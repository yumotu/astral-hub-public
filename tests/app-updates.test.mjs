import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { updateManifestSchema, newerVersion } from '../shared/app-updates.mjs';
import { createApp } from '../server/index.mjs';
import { publishUpdates } from '../scripts/publish-updates.mjs';
const { createInstallerUpdater, validateDownload } = createRequire(import.meta.url)(
  '../desktop/updates.cjs',
);
test('version comparison and update manifests reject mismatched versions, platforms and filenames', () => {
  assert.equal(newerVersion('0.7.27', '0.7.9'), true);
  assert.equal(newerVersion('0.7.27', '0.7.27'), false);
  assert.equal(newerVersion('bad', '0.7.27'), false);
  const data = {
    version: '1.0.0',
    commit: 'a'.repeat(40),
    generatedAt: new Date().toISOString(),
    assets: [
      {
        platform: 'win-x64',
        name: 'Astral-Hub-1.0.0-win-x64.exe',
        bytes: 4,
        sha256: 'f'.repeat(64),
      },
    ],
  };
  assert.equal(updateManifestSchema.safeParse(data).success, true);
  assert.equal(updateManifestSchema.safeParse({ ...data, version: '2.0.0' }).success, false);
  assert.equal(
    updateManifestSchema.safeParse({ ...data, assets: [data.assets[0], data.assets[0]] }).success,
    false,
  );
});
test('native updater streams and verifies bytes before exposing install; corrupt and redirected destinations are blocked', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-update-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bytes = Buffer.from('synthetic installer fixture, not a real application');
  const asset = {
    platform: 'mac-arm64',
    name: 'Astral-Hub-1.0.0-mac-arm64.dmg',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const url = 'https://updates.example/api/updates/download/' + 'f'.repeat(64);
  let opened = 0,
    fetches = 0;
  const updater = createInstallerUpdater({
    directory: dir,
    platform: 'mac-arm64',
    fetch: async () => {
      fetches++;
      return new Response(bytes);
    },
    open: async () => {
      opened++;
      return '';
    },
  });
  await assert.rejects(() => updater.install(), /先下载/);
  await updater.download({ url, asset });
  assert.equal(updater.status().state, 'ready');
  assert.deepEqual(await readFile(join(dir, asset.name)), bytes);
  await updater.download({ url, asset });
  assert.equal(fetches, 1);
  await updater.install();
  assert.equal(opened, 1);
  await writeFile(join(dir, asset.name), 'modified');
  await assert.rejects(() => updater.install(), /校验/);
  assert.equal(opened, 1);
  for (const bad of [
    'http://evil.example/api/updates/download/' + 'f'.repeat(64),
    url + '?token=private',
    'file:///tmp/x',
  ])
    assert.throws(() => validateDownload(bad, asset, 'mac-arm64'));
  const corrupt = createInstallerUpdater({
    directory: dir,
    platform: 'mac-arm64',
    fetch: async () => new Response(Buffer.alloc(bytes.length)),
    open: async () => {
      opened++;
    },
  });
  await assert.rejects(() => corrupt.download({ url, asset }), /校验失败/);
  assert.equal(corrupt.status().state, 'error');
});
test('private update service requires login, issues limited download tickets and verifies content and ranges', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-updates-api-'));
  const from = join(dir, 'publish'),
    root = join(dir, 'updates');
  await mkdir(from);
  let lines = '';
  for (const suffix of ['mac-arm64.dmg', 'mac-x64.dmg', 'win-x64.exe', 'android-debug.apk']) {
    const name = 'Astral-Hub-1.0.0-' + suffix,
      bytes = Buffer.from('fixture ' + suffix);
    await writeFile(join(from, name), bytes);
    lines += createHash('sha256').update(bytes).digest('hex') + '  ' + name + '\n';
  }
  await writeFile(join(from, 'SHA256SUMS.txt'), lines);
  await writeFile(
    join(from, 'build-info.json'),
    JSON.stringify({
      version: '1.0.0',
      commit: 'a'.repeat(40),
      verifiedJobs: ['web-and-tests', 'desktop-macOS', 'desktop-Windows', 'android'],
    }),
  );
  await assert.rejects(publishUpdates(from, root), /全部原生 CI/);
  const verified = JSON.parse(await readFile(join(from, 'build-info.json'), 'utf8'));
  verified.verifiedJobs.push('pi-runtime');
  await writeFile(join(from, 'build-info.json'), JSON.stringify(verified));
  await assert.rejects(publishUpdates(from, root), /全部原生 CI/);
  verified.verifiedJobs.push('computer-runtime-linux','computer-runtime-macOS','computer-runtime-Windows');
  await writeFile(join(from, 'build-info.json'), JSON.stringify(verified));
  await assert.rejects(publishUpdates(from, root), /全部原生 CI/);
  verified.verifiedJobs.push('source-audit', 'android-sign');
  await writeFile(join(from, 'build-info.json'), JSON.stringify(verified));
  await assert.rejects(publishUpdates(from, root), /Android release signature provenance/);
  verified.androidVerification = {
    version: verified.version,
    commit: verified.commit,
    integrity: true,
    certificateSha256: 'b'.repeat(64),
    schemes: ['v2', 'v3'],
    apkSha256: createHash('sha256').update(await readFile(join(from, 'Astral-Hub-1.0.0-android-debug.apk'))).digest('hex'),
  };
  await writeFile(join(from, 'build-info.json'), JSON.stringify(verified));
  await publishUpdates(from, root);
  const app = await createApp({
    dataDir: join(dir, 'data'),
    updatesDir: root,
    token: 'update-test-token-12345678901234567890',
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((r) => app.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  assert.equal((await fetch(base + '/updates')).status, 401);
  const login = await fetch(base + '/auth/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'update-owner',
      displayName: 'Update test',
      password: 'only-for-update-tests!',
      adminToken: 'update-test-token-12345678901234567890',
    }),
  });
  const token = (await login.json()).token;
  assert.ok(token);
  const auth = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const ticket = await fetch(base + '/updates/ticket', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ version: '1.0.0', platform: 'mac-arm64' }),
  });
  assert.equal(ticket.status, 200);
  const value = await ticket.json();
  assert.ok(!JSON.stringify(value).includes(token));
  const response = await fetch(base.replace(/\/api$/, '') + value.path, {
    headers: { Range: 'bytes=2-6' },
  });
  assert.equal(response.status, 206);
  assert.equal(await response.text(), 'xture');
  await writeFile(join(root, '1.0.0', value.asset.name), 'corrupt');
  const broken = await fetch(base + '/updates/ticket', {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ version: '1.0.0', platform: 'mac-arm64' }),
  });
  assert.equal(broken.status, 409);
});

test('web can download the current client release while installed clients offer only newer updates', async () => {
  const { downloadableRelease } = await import('../shared/app-downloads.mjs');
  assert.equal(downloadableRelease(null, '0.8.9', false), false);
  assert.equal(downloadableRelease({version:'0.8.9'}, '0.8.9', false), true);
  assert.equal(downloadableRelease({version:'0.8.8'}, '0.8.9', false), true);
  assert.equal(downloadableRelease({version:'0.8.9'}, '0.8.9', true), false);
  assert.equal(downloadableRelease({version:'0.8.8'}, '0.8.9', true), false);
  assert.equal(downloadableRelease({version:'0.8.10'}, '0.8.9', true), true);
});
