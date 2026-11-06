import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { expectedReleaseAssets } from '../shared/release-assets.mjs';
import { prepareRelease } from '../scripts/prepare-release.mjs';
import { buildAgent } from '../scripts/package-agent.mjs';
import { unzipSync, strFromU8 } from 'fflate';
import { pathToFileURL } from 'node:url';
import { publishUpdates } from '../scripts/publish-updates.mjs';

test('0.8.3 update source requires real computer runtime checks on all three operating systems', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'astral-computer-release-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'build-info.json'),
    JSON.stringify({
      version: '0.8.3',
      verifiedJobs: ['web-and-tests', 'desktop-macOS', 'desktop-Windows', 'android', 'pi-runtime'],
    }),
  );
  await assert.rejects(() => publishUpdates(root, join(root, 'output')), /全部原生 CI/);
});

test('release only publishes all nine current artifacts, excludes bundled old downloads and writes parseable checksums and build info', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'astral-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = '0.7.21',
    expected = expectedReleaseAssets(version);
  await mkdir(join(root, 'artifacts/build/release'), { recursive: true });
  await mkdir(join(root, 'artifacts/build/dist/downloads'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ version }));
  for (const name of [...expected, 'Astral-Remote-Pi-Agent-0.5.0.zip'])
    await writeFile(join(root, 'artifacts/build/release', name), name);
  await writeFile(
    join(root, 'artifacts/build/dist/downloads', expected.at(-1)),
    'bundled duplicate',
  );
  const result = await prepareRelease({ root, commit: 'a'.repeat(40), run: 'unit-test' });
  const manifest = await readFile(join(root, 'release/publish/SHA256SUMS.txt'), 'utf8');
  const lines = manifest.trim().split('\n');
  assert.equal(lines.length, 9);
  for (const name of expected)
    assert.ok(lines.includes(createHash('sha256').update(name).digest('hex') + '  ' + name));
  assert.equal(manifest.includes('\\n'), false);
  assert.equal(
    JSON.parse(await readFile(join(root, 'release/publish/build-info.json'), 'utf8')).commit,
    result.commit,
  );
  assert.ok(
    (await readFile(join(root, 'release/release-notes.md'), 'utf8')).split('\n\n').length > 3,
  );
  assert.equal(
    (await readdir(join(root, 'release/publish'))).includes('Astral-Remote-Pi-Agent-0.5.0.zip'),
    false,
  );
  await rm(join(root, 'artifacts/build/release', expected[0]));
  await assert.rejects(
    () => prepareRelease({ root, commit: 'a'.repeat(40) }),
    /Missing release asset/,
  );
});
test('web and release executors share deterministic bytes, the current version and no device credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'astral-agent-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'agent'), { recursive: true });
  await mkdir(join(root, 'deploy/pi'), { recursive: true });
  await mkdir(join(root, 'shared'), { recursive: true });
  await writeFile(
    join(root, 'shared/computer-plugin.mjs'),
    await readFile(new URL('../shared/computer-plugin.mjs', import.meta.url)),
  );
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '0.7.21' }));
  await writeFile(
    join(root, 'shared/computer-package.mjs'),
    await readFile(new URL('../shared/computer-package.mjs', import.meta.url)),
  );
  await writeFile(join(root, 'agent/package.json'), JSON.stringify({ version: '0.7.21' }));
  for (const name of [
    'relay-agent.mjs',
    'workspace.mjs',
    'config.mjs',
    'task-runner.mjs',
    'task-worker.mjs',
    'project-adapter.mjs',
    'file-tools.mjs',
    'extra-tools.mjs',
    'computer-tools.mjs',
    'input-tools.mjs',
    'plugin-store.mjs',
    'online-packages.mjs',
    'package-leases.mjs',
    'package-probe.mjs',
    'package-read.mjs',
    'execute-tools.mjs',
    'process-tree.mjs',
    'terminal-runtime.mjs',
    'windows-pty.mjs',
    'terminal-worker.mjs',
    'prepare-terminal.mjs',
  ])
    await writeFile(join(root, 'agent', name), 'export {};\r\n');
  await writeFile(join(root, 'agent/device.json'), 'fixture-secret-must-not-be-packaged');
  for (const name of [
    'project-files.mjs',
    'project-lock.mjs',
    'project-tools.mjs',
    'app-tools.mjs',
    'protocol.mjs',
    'file-diff.mjs',
    'rpc-prompt.mjs',
    'activity-deadline.mjs',
    'ask-user.mjs',
    'long-goal.mjs',
    'long-goal-command.mjs',
    'schedule-tools.mjs',
    ...['index.ts','goal-state.ts','usage.ts','LICENSE','UPSTREAM.json'].map(name=>'vendor/pi-goal/'+name),
    'stream-writer.mjs',
    'package-transaction.mjs',
    'document-text.mjs',
    'attachments.mjs',
    'pdf-content.mjs',
    'pdf-document.mjs',
    'chat-content.mjs',
    'office-content.mjs',
    'attachment-limits.mjs',
  ]) {
    await mkdir(dirname(join(root, 'deploy/pi', name)), {recursive:true});
    await writeFile(
      join(root, 'deploy/pi', name),
      await readFile(new URL('../deploy/pi/' + name, import.meta.url)),
    );
  }
  const first = buildAgent(root, { web: true });
  await writeFile(join(root, 'agent/relay-agent.mjs'), 'export {};\n');
  const next = buildAgent(root);
  assert.deepEqual(first.bytes, next.bytes);
  assert.deepEqual(
    Buffer.from(first.bytes),
    await readFile(join(root, 'web/public/downloads', first.name)),
  );
  const archive = unzipSync(first.bytes);
  const unpacked = join(root, 'unpacked');
  for (const [name, bytes] of Object.entries(archive)) {
    const path = join(unpacked, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }
  const protocol = await import(
    pathToFileURL(join(unpacked, 'astral-remote-pi-agent/assets/protocol.mjs')).href
  );
  assert.equal(typeof protocol.createCollector, 'function');
  assert.equal(
    Object.keys(archive).some((name) => name.endsWith('device.json')),
    false,
  );
  assert.equal(
    JSON.parse(strFromU8(archive['astral-remote-pi-agent/package.json'])).version,
    '0.7.21',
  );
});

test('modern release preparation requires commit-bound macOS evidence and detects changed installers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'astral-mac-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = '0.8.0',
    commit = 'c'.repeat(40),
    dir = join(root, 'artifacts/native/release');
  await mkdir(dir, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ version }));
  for (const name of expectedReleaseAssets(version)) await writeFile(join(dir, name), name);
  await assert.rejects(prepareRelease({ root, commit }), /macOS verification provenance/);
  const report = {
    version,
    commit,
    mode: 'integrity-only',
    apps: ['arm64', 'x86_64'].map((arch) => ({
      arch,
      integrity: true,
      notarized: false,
      gatekeeperAccepted: false,
    })),
    assets: expectedReleaseAssets(version)
      .filter((name) => name.includes('-mac-'))
      .map((name) => ({ name, sha256: createHash('sha256').update(name).digest('hex') })),
  };
  await writeFile(join(dir, 'macos-verification.json'), JSON.stringify(report));
  await prepareRelease({ root, commit });
  const info = JSON.parse(await readFile(join(root, 'release/publish/build-info.json'), 'utf8'));
  assert.equal(info.macosVerification.mode, 'integrity-only');
  assert.equal(info.macosVerification.notarized, false);
  const notes = await readFile(join(root, 'release/release-notes.md'), 'utf8');
  assert.match(notes, /临时签名/);
  assert.match(notes, /Gatekeeper仍可能拒绝/);
  assert.match(notes, /Apple Developer ID／公证延期/);
  report.mode = 'developer-id';
  for (const app of report.apps) {
    app.notarized = true;
    app.gatekeeperAccepted = true;
  }
  await writeFile(join(dir, 'macos-verification.json'), JSON.stringify(report));
  await prepareRelease({ root, commit });
  const manifest = await publishUpdates(join(root, 'release/publish'), join(root, 'updates'));
  assert.match(manifest.notes, /已验证 Developer ID、公证票据和 Gatekeeper/);
  await writeFile(join(dir, report.assets[0].name), 'changed after verification');
  await assert.rejects(prepareRelease({ root, commit }), /installer hashes/);
  await assert.rejects(readFile(join(root, 'release/publish/build-info.json')), { code: 'ENOENT' });
});

test('update publication cannot label incomplete distribution evidence as notarized or replace the existing feed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'astral-mac-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const from = join(root, 'source'),
    to = join(root, 'updates');
  await mkdir(from);
  await mkdir(to);
  await writeFile(
    join(from, 'build-info.json'),
    JSON.stringify({
      version: '0.8.1',
      macosVerification: { mode: 'developer-id', integrity: true },
    }),
  );
  await writeFile(join(to, 'manifest.json'), 'existing protected feed');
  await assert.rejects(publishUpdates(from, to), /distribution verification is incomplete/);
  assert.equal(await readFile(join(to, 'manifest.json'), 'utf8'), 'existing protected feed');
  assert.deepEqual(await readdir(to), ['manifest.json']);
});

test('public release requires commit-bound Android signing evidence and refuses changed APKs without replacing the update feed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'astral-public-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = '0.8.9', commit = 'd'.repeat(40), dir = join(root, 'artifacts/native');
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  await mkdir(dir, { recursive: true });
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version }));
  await writeFile(join(root, 'docs/release-0.8.9.md'), 'Synthetic release fixture.');
  for (const name of expectedReleaseAssets(version)) await writeFile(join(dir, name), name);
  await writeFile(join(dir, 'macos-verification.json'), JSON.stringify({
    version, commit, mode: 'integrity-only',
    apps: ['arm64', 'x86_64'].map(arch => ({ arch, integrity: true, notarized: false, gatekeeperAccepted: false })),
    assets: expectedReleaseAssets(version).filter(name => name.includes('-mac-')).map(name => ({ name, sha256: digest(name) })),
  }));
  await assert.rejects(prepareRelease({ root, commit }), /Android release signature provenance/);
  const apkName = `Astral-Hub-${version}-android-debug.apk`;
  const report = { version, commit, integrity: true, certificateSha256: 'e'.repeat(64), schemes: ['v2', 'v3'], apkSha256: digest(apkName) };
  await writeFile(join(dir, 'android-verification.json'), JSON.stringify({ ...report, commit: 'f'.repeat(40) }));
  await assert.rejects(prepareRelease({ root, commit }), /Android release signature provenance/);
  await writeFile(join(dir, 'android-verification.json'), JSON.stringify(report));
  await prepareRelease({ root, commit });
  const from = join(root, 'release/publish'), to = join(root, 'updates');
  const info = JSON.parse(await readFile(join(from, 'build-info.json'), 'utf8'));
  assert.deepEqual(info.androidVerification, report);
  assert.ok(info.verifiedJobs.includes('source-audit') && info.verifiedJobs.includes('android-sign'));
  const manifest = await publishUpdates(from, to);
  assert.equal(manifest.commit, commit);
  const originalFeed = await readFile(join(to, 'manifest.json'), 'utf8');
  await writeFile(join(dir, apkName), 'tampered APK');
  await assert.rejects(prepareRelease({ root, commit }), /Android release signature provenance/);
  assert.equal(await readFile(join(to, 'manifest.json'), 'utf8'), originalFeed);
  await assert.rejects(readFile(join(from, 'build-info.json')), { code: 'ENOENT' });
});
