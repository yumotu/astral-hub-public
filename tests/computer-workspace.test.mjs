import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/index.mjs';
import { localGrant, saveConfig } from '../agent/config.mjs';
import { createLocalWorkspace } from '../agent/workspace.mjs';
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-computer-')),
    root = join(dir, 'project');
  await mkdir(root);
  await writeFile(join(root, 'note.txt'), 'before');
  const grant = await localGrant(root, { allowWrite: true });
  let time = Date.now();
  const token = 'synthetic-computer-admin-token-123456789012345';
  const app = await createApp({ token, dataDir: join(dir, 'server'), now: () => time, ...options });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const req = async (path, data, auth, method) => {
    const r = await fetch('http://127.0.0.1:' + app.server.address().port + '/api/relay' + path, {
      method: method || (data ? 'POST' : 'GET'),
      headers: {
        ...(auth ? { Authorization: 'Bearer ' + auth } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  const auth = async (path, data) => {
    const r = await fetch('http://127.0.0.1:' + app.server.address().port + '/api/auth' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return r.json();
  };
  const owner = await auth('/bootstrap', {
    username: 'computerowner',
    password: 'Synthetic-computer-password',
    displayName: 'Computer QA',
    adminToken: token,
  });
  const r = await fetch('http://127.0.0.1:' + app.server.address().port + '/api/auth/invitations', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + owner.token, 'Content-Type': 'application/json' },
      body: '{}',
    }),
    invite = await r.json();
  const other = await auth('/register', {
    username: 'computerother',
    password: 'Synthetic-computer-password',
    displayName: 'Other',
    invite: invite.code,
  });
  const pair = (await req('/pairing', {}, owner.token)).body;
  const device = (
    await req('/device/enroll', {
      code: pair.code,
      name: 'Synthetic Mac',
      platform: 'darwin',
      rootLabel: 'project',
      allowWrite: true,
    })
  ).body;
  const configPath = join(dir, 'device.json');
  await saveConfig(
    configPath,
    { server: 'http://127.0.0.1:' + app.server.address().port, ...device, projects: [grant] },
    { create: true },
  );
  const local = await createLocalWorkspace({
    configPath,
    projects: () => [grant],
    backupDir: join(dir, 'backups'),
    ledgerFile: join(dir, 'ledger.sqlite'),
  });
  const announce = (projects) =>
    req(
      '/device/workspace/announce',
      {
        version: 2,
        capabilities: ['chat_export', 'computer_plugins', 'online_packages'],
        projects: projects.map(({ id, name, allowWrite, allowExecute }) => ({
          id,
          name,
          allowWrite,
          allowExecute,
        })),
      },
      device.token,
    );
  t.after(async () => {
    local.close();
    await new Promise((r) => app.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  await announce([grant]);
  const perform = async (operation, id = randomUUID()) => {
    const input = { id, deviceId: device.deviceId, projectId: grant.id, operation };
    const accepted = await req('/operations', input, owner.token);
    assert.ok([200, 202].includes(accepted.status));
    const op = (await req('/device/workspace/poll', undefined, device.token)).body.operation;
    if (op) {
      try {
        await req(
          '/device/workspace/result',
          { id: op.id, status: 'done', result: await local.handle(op) },
          device.token,
        );
      } catch (e) {
        await req(
          '/device/workspace/result',
          { id: op.id, status: 'error', error: e.message },
          device.token,
        );
      }
    }
    return (await req('/operations/' + id, undefined, owner.token)).body.operation;
  };
  return {
    dir,
    root,
    grant,
    local,
    owner,
    other,
    device,
    req,
    announce,
    perform,
    tick: (ms) => {
      time += ms;
    },
  };
}
test('online package preview confirmation pins the queued operation, isolates owners and renews only live device leases', async (t) => {
  const integrity = 'sha512-' + Buffer.alloc(64, 7).toString('base64');
  const f = await setup(t, {
    packageCatalogAI: async (stage) =>
      stage === 'queries'
        ? { queries: ['diagram'] }
        : { choices: [{ id: 0, reason: '合成推荐', limitations: '只验收安装协议' }] },
    packageCatalogFetch: async (url) =>
      url.includes('/-/v1/')
        ? Response.json({
            objects: [{ package: { name: 'synthetic-pi-package', version: '1.0.0' } }],
          })
        : Response.json({
            name: 'synthetic-pi-package',
            version: '1.0.0',
            keywords: ['pi-package'],
            dist: {
              integrity,
              tarball:
                'https://registry.npmjs.org/synthetic-pi-package/-/synthetic-pi-package-1.0.0.tgz',
            },
          }),
  });
  const target = { deviceId: f.device.deviceId, projectId: f.grant.id };
  assert.equal(
    (await f.req('/packages/wish', { ...target, wish: '帮我画图' }, f.other.token)).status,
    404,
  );
  const preview = (await f.req('/packages/wish', { ...target, wish: '帮我画图' }, f.owner.token))
    .body.packages[0];
  assert.ok(preview.previewId);
  const id = randomUUID(),
    operation = {
      kind: 'package_install',
      previewId: preview.previewId,
      expectedRevision: 'new',
      confirmed: true,
    },
    request = { id, ...target, operation };
  assert.equal(
    (await f.req('/operations', request, f.owner.token)).status,
    403,
    'local execute permission is mandatory',
  );
  f.grant.allowExecute = true;
  await f.announce([f.grant]);
  assert.equal(
    (
      await f.req(
        '/operations',
        { ...request, operation: { ...operation, previewId: randomUUID() } },
        f.owner.token,
      )
    ).status,
    409,
  );
  assert.equal((await f.req('/operations', request, f.owner.token)).status, 202);
  const queued = (await f.req('/device/workspace/poll', undefined, f.device.token)).body.operation;
  assert.deepEqual(queued.package, { name: 'synthetic-pi-package', version: '1.0.0', integrity });
  assert.equal(
    (await f.req('/operations', request, f.owner.token)).status,
    200,
    'same request is an idempotent receipt',
  );
  assert.equal((await f.req('/operations/' + id, undefined, f.other.token)).status, 404);
  f.tick(30000);
  assert.equal(
    (await f.req('/device/workspace/operation-heartbeat', { id }, f.device.token)).body.cancelled,
    false,
  );
  f.tick(30000);
  assert.equal(
    (await f.req('/operations/' + id, undefined, f.owner.token)).body.operation.status,
    'running',
    'heartbeat renewed the lease',
  );
  await f.announce([]);
  assert.equal(
    (await f.req('/device/workspace/operation-heartbeat', { id }, f.device.token)).body.cancelled,
    true,
  );
  const late = await f.req(
    '/device/workspace/result',
    { id, status: 'done', result: { packages: [{ name: 'late' }] } },
    f.device.token,
  );
  assert.equal(late.body.status, 'cancelled', 'late completion cannot undo revocation');
});
test('computer plugin wishes stay drafts until an owner registers them, verify native receipts and isolate project permissions', async (t) => {
  let generated;
  const manifest = {
    version: 1,
    id: 'read_note',
    name: '读取说明',
    description: '读取指定的项目文本文件。',
    inputLabel: '相对路径',
    steps: [{ tool: 'project_read', arguments: { path: '{{input}}' } }],
  };
  generated = manifest;
  const f = await setup(t, {
    aiConfig: {
      apiKey: 'synthetic-only',
      model: 'deepseek-flash',
      fetch: async () =>
        Response.json({
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(generated) } }],
        }),
    },
  });
  const input = {
    deviceId: f.device.deviceId,
    projectId: f.grant.id,
    wish: '读取项目说明并给我分析',
  };
  assert.equal((await f.req('/plugins/wish', input, f.other.token)).status, 404);
  const draft = await f.req('/plugins/wish', input, f.owner.token);
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  assert.deepEqual(draft.body.manifest, manifest);
  assert.deepEqual((await f.perform({ kind: 'plugin_list' })).result.plugins, []);
  const id = randomUUID();
  const saved = await f.perform(
    { kind: 'plugin_register', manifest, enabled: true, expectedHash: 'new' },
    id,
  );
  assert.equal(saved.status, 'done', JSON.stringify(saved));
  assert.equal(saved.result.plugins[0].manifest.id, manifest.id);
  const replay = await f.perform(
    { kind: 'plugin_register', manifest, enabled: true, expectedHash: 'new' },
    id,
  );
  assert.deepEqual(replay.result, saved.result);
  const conflict = await f.perform({
    kind: 'plugin_register',
    manifest,
    enabled: false,
    expectedHash: 'new',
  });
  assert.equal(conflict.status, 'error');
  assert.match(conflict.error, /已变化/);
  const disabled = await f.perform({
    kind: 'plugin_register',
    manifest,
    enabled: false,
    expectedHash: saved.result.plugins[0].sha256,
  });
  assert.equal(disabled.result.plugins[0].enabled, false);
  f.grant.allowWrite = false;
  await f.announce([f.grant]);
  const shell = {
    ...manifest,
    steps: [{ tool: 'computer_exec', arguments: { command: 'node --version' } }],
  };
  assert.equal(
    (
      await f.req(
        '/operations',
        {
          id: randomUUID(),
          deviceId: f.device.deviceId,
          projectId: f.grant.id,
          operation: {
            kind: 'plugin_register',
            manifest: shell,
            enabled: true,
            expectedHash: 'new',
          },
        },
        f.owner.token,
      )
    ).status,
    403,
  );
  const removed = await f.perform({
    kind: 'plugin_remove',
    pluginId: manifest.id,
    expectedHash: disabled.result.plugins[0].sha256,
  });
  assert.deepEqual(removed.result.plugins, []);
  generated = { ...manifest, source: 'must never be installed' };
  assert.equal((await f.req('/plugins/wish', input, f.owner.token)).status, 502);
});

test('computer files use local grants, original hashes, backups, download and idempotent requests', async (t) => {
  const f = await setup(t),
    { grant, perform, req, owner, other, device, local } = f;
  assert.equal(
    (await req('/projects?deviceId=' + device.deviceId, undefined, other.token)).status,
    404,
  );
  const list = await perform({ kind: 'list', path: '.' });
  assert.equal(list.result.entries[0].name, 'note.txt');
  const read = await perform({ kind: 'read', path: 'note.txt' });
  assert.equal(read.result.content, 'before');
  const id = randomUUID(),
    write = await perform(
      { kind: 'write', path: 'note.txt', content: 'after', expectedHash: read.result.sha256 },
      id,
    );
  assert.equal(write.status, 'done');
  assert.ok(write.result.backupId);
  assert.equal(
    (
      await perform(
        { kind: 'write', path: 'note.txt', content: 'after', expectedHash: read.result.sha256 },
        id,
      )
    ).status,
    'done',
  );
  assert.equal(await readFile(join(f.root, 'note.txt'), 'utf8'), 'after');
  const stale = await perform({
    kind: 'write',
    path: 'note.txt',
    content: 'stale',
    expectedHash: read.result.sha256,
  });
  assert.equal(stale.status, 'error');
  assert.equal(
    (await perform({ kind: 'restore', backupId: write.result.backupId })).status,
    'done',
  );
  const download = await perform({ kind: 'download', path: 'note.txt' });
  assert.equal(Buffer.from(download.result.base64, 'base64').toString(), 'before');
  for (const path of ['../outside', '.env', 'nested/../../escape'])
    assert.equal((await perform({ kind: 'read', path })).status, 'error');
  await writeFile(join(f.dir, 'outside.txt'), 'secret');
  await symlink(join(f.dir, 'outside.txt'), join(f.root, 'link.txt'));
  assert.equal((await perform({ kind: 'read', path: 'link.txt' })).status, 'error');
  assert.equal(
    (
      await req(
        '/projects/' + grant.id + '/display-name?deviceId=' + device.deviceId,
        { name: 'Remote display' },
        owner.token,
        'PUT',
      )
    ).status,
    200,
  );
  assert.equal(
    (await req('/projects?deviceId=' + device.deviceId, undefined, owner.token)).body.projects[0]
      .name,
    'Remote display',
  );
  assert.equal(
    (await req('/projects?deviceId=' + device.deviceId, undefined, owner.token)).body.projects[0]
      .readOnly,
    false,
  );
  const op = { id: randomUUID(), projectId: grant.id, kind: 'read', path: 'note.txt' };
  await local.handle(op);
  await assert.rejects(local.handle({ ...op, path: 'other.txt' }));
  await rename(f.root, f.root + '-old');
  await mkdir(f.root);
  await assert.rejects(local.handle({ ...op, id: randomUUID() }), /目录已变化/);
});
test('computer disconnects and revocations do not replay file writes or grant another account access', async (t) => {
  const f = await setup(t),
    id = randomUUID(),
    p = {
      id,
      deviceId: f.device.deviceId,
      projectId: f.grant.id,
      operation: { kind: 'mkdir', path: 'unknown' },
    };
  await f.req('/operations', p, f.owner.token);
  await f.req('/device/workspace/poll', undefined, f.device.token);
  f.tick(45001);
  assert.equal(
    (await f.req('/operations/' + id, undefined, f.owner.token)).body.operation.status,
    'interrupted',
  );
  assert.equal(
    (await f.req('/device/workspace/poll', undefined, f.device.token)).body.operation,
    null,
  );
  assert.equal((await f.req('/operations/' + id, undefined, f.other.token)).status, 404);
  assert.equal(
    (await f.req('/operations', { ...p, id: randomUUID(), extra: true }, f.owner.token)).status,
    400,
  );
  const queued = { ...p, id: randomUUID() };
  await f.req('/operations', queued, f.owner.token);
  await f.announce([]);
  assert.equal(
    (await f.req('/projects?deviceId=' + f.device.deviceId, undefined, f.owner.token)).body.projects
      .length,
    0,
  );
  assert.equal((await f.req('/operations', p, f.owner.token)).status, 404);
  assert.equal(
    (await f.req('/device/workspace/poll', undefined, f.device.token)).body.operation,
    null,
  );
});
