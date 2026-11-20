import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { localGrant, saveConfig } from '../config.mjs';
import fileTools from '../file-tools.mjs';
import extraTools from '../extra-tools.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-computer-tools-')),
    root = join(dir, 'project');
  await mkdir(root);
  const grant = await localGrant(root),
    configPath = join(dir, 'device.json');
  const config = {
    server: 'http://127.0.0.1:1',
    deviceId: randomUUID(),
    token: 'synthetic-only',
    projects: [grant],
  };
  await saveConfig(configPath, config, { create: true });
  const values = {
    ASTRAL_DEVICE_CONFIG: configPath,
    ASTRAL_DEVICE_PROJECT: grant.id,
    ASTRAL_DEVICE_ROOT: grant.root,
    ASTRAL_DEVICE_INO: String(grant.ino),
    ASTRAL_DEVICE_DEV: String(grant.dev),
    ASTRAL_DEVICE_JOB: randomUUID(),
    ASTRAL_PROJECT_ACCESS: 'read',
    ASTRAL_DEVICE_EXECUTE: '0',
    ASTRAL_PROJECT_BACKUPS: join(dir, 'backups'),
    ASTRAL_PROJECT_PRIVATE_PATHS: '[]',
  };
  const previous = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  t.after(async () => {
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    await rm(dir, { recursive: true, force: true });
  });
  const tools = new Map(),
    pi = { registerTool: (spec) => tools.set(spec.name, spec) };
  fileTools(pi);
  extraTools(pi);
  const run = (name, p, id = randomUUID()) =>
    tools.get(name).execute(id, p, new AbortController().signal);
  return { dir, root, config, configPath, grant, tools, run };
}

test('computer export recovers a lost acknowledgement once and never puts binary bytes into a tool result', async (t) => {
  const f = await fixture(t),
    bytes = Buffer.alloc(3 * 1024 * 1024, 0xab);
  await writeFile(join(f.root, 'photo.png'), bytes);
  let uploads = 0,
    receipt,
    received;
  const server = createServer(async (req, res) => {
    if (req.method === 'PUT') {
      uploads++;
      const chunks = [];
      for await (const c of req) chunks.push(c);
      received = Buffer.concat(chunks);
      receipt = {
        id: req.url.split('/').at(-1),
        name: decodeURIComponent(req.headers['x-astral-file-name']),
        bytes: received.length,
        sha256: createHash('sha256').update(received).digest('hex'),
      };
      res.destroy(); // File persisted; acknowledgement lost in transit.
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ file: receipt }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  f.config.server = 'http://127.0.0.1:' + server.address().port;
  await saveConfig(f.configPath, f.config);
  const result = await f.run('chat_export', { path: 'photo.png' });
  assert.equal(uploads, 1);
  assert.deepEqual(received, bytes);
  assert.equal(result.details.file.sha256, receipt.sha256);
  assert.ok(JSON.stringify(result).length < 1000);
  assert.equal(JSON.parse(result.content[0].text).sent, true);
  await assert.rejects(
    () => f.run('chat_export', { name: 'fake.pdf', content: 'not a PDF' }),
    /二进制/,
  );
  await assert.rejects(() => f.run('chat_export', { path: '../device.json' }), /受保护/);
  await writeFile(join(f.root, '.env'), 'synthetic-secret');
  await assert.rejects(() => f.run('chat_export', { path: '.env' }), /受保护/);
  await writeFile(join(f.root, 'large.bin'), Buffer.alloc(10 * 1024 * 1024 + 1));
  await assert.rejects(() => f.run('chat_export', { path: 'large.bin' }), /10 MiB/);
  if (process.platform !== 'win32') {
    await symlink(join(f.root, 'photo.png'), join(f.root, 'linked.png'));
    await assert.rejects(() => f.run('chat_export', { path: 'linked.png' }), /符号链接/);
  }
  await link(join(f.root, 'photo.png'), join(f.root, 'hard.png'));
  await assert.rejects(() => f.run('chat_export', { path: 'hard.png' }), /无链接/);
  f.config.projects = [];
  await saveConfig(f.configPath, f.config);
  await assert.rejects(() => f.run('chat_export', { path: 'photo.png' }), /撤销/);
});

test('computer inspection tools expose bounded project data, do not widen read-only grants and recheck revocation', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, 'src'));
  await writeFile(join(f.root, 'src', 'one.txt'), 'one\ntwo');
  await writeFile(join(f.root, '.env'), 'must-not-appear');
  const info = JSON.parse((await f.run('computer_info', {})).content[0].text);
  assert.equal(info.project.readOnly, true);
  assert.equal(info.project.allowExecute, false);
  assert.equal(f.tools.has('project_mkdir'), false);
  assert.equal(f.tools.has('project_restore'), false);
  const tree = JSON.parse((await f.run('project_tree', {})).content[0].text);
  assert.ok(tree.entries.some((e) => e.path === 'src/one.txt'));
  assert.ok(!JSON.stringify(tree).includes('.env'));
  const stat = JSON.parse((await f.run('project_stat', { path: 'src/one.txt' })).content[0].text);
  assert.equal(stat.bytes, 7);
  const many = JSON.parse(
    (await f.run('project_read_many', { paths: ['src/one.txt', '.env'] })).content[0].text,
  );
  assert.ok(many.files[0].content.includes('one'));
  assert.ok(many.files[1].error);
  f.config.projects = [];
  await saveConfig(f.configPath, f.config);
  await assert.rejects(() => f.run('computer_info', {}), /撤销/);
});
