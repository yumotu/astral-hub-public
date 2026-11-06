import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { localGrant, saveConfig } from '../config.mjs';
import inputTools from '../input-tools.mjs';
import { largeDocumentFixtures } from '../../tests/fixtures/document-files.mjs';

test('computer inputs read real 16 MiB documents, verify cached bytes and recheck task and local grants', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'astral-inputs-')),
    root = join(dir, 'project');
  await mkdir(root);
  const files = largeDocumentFixtures().map((f) => ({
    ...f,
    id: randomUUID(),
    sha256: createHash('sha256').update(f.bytes).digest('hex'),
  }));
  let allowed = true,
    downloads = 0;
  const server = createServer((req, res) => {
    if (!allowed || req.headers.authorization !== 'Bearer synthetic-inputs') {
      res.writeHead(403);
      res.end();
      return;
    }
    const file = files.find((f) => req.url.endsWith('/' + f.id));
    if (file) {
      downloads++;
      res.setHeader('Content-Length', file.bytes.length);
      res.end(file.bytes);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ files: files.map((f) => ({ ...f, bytes: f.bytes.length })) }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const grant = await localGrant(root),
    path = join(dir, 'device.json'),
    config = {
      server: 'http://127.0.0.1:' + server.address().port,
      token: 'synthetic-inputs',
      deviceId: randomUUID(),
      projects: [grant],
    };
  await saveConfig(path, config, { create: true });
  const values = {
    ASTRAL_DEVICE_CONFIG: path,
    ASTRAL_DEVICE_PROJECT: grant.id,
    ASTRAL_DEVICE_ROOT: grant.root,
    ASTRAL_DEVICE_INO: String(grant.ino),
    ASTRAL_DEVICE_DEV: String(grant.dev),
    ASTRAL_DEVICE_JOB: randomUUID(),
    ASTRAL_PROJECT_ACCESS: 'read',
    ASTRAL_PROJECT_PRIVATE_PATHS: '[]',
    ASTRAL_DOCUMENT_DEPS: fileURLToPath(new URL('../package.json', import.meta.url)),
  };
  const previous = Object.fromEntries(Object.keys(values).map((k) => [k, process.env[k]]));
  Object.assign(process.env, values);
  t.after(async () => {
    for (const [k, v] of Object.entries(previous))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const tools = new Map();
  inputTools({ registerTool: (s) => tools.set(s.name, s) });
  const read = async (id) =>
    JSON.parse(
      (await tools.get('chat_read').execute(randomUUID(), { id }, new AbortController().signal))
        .content[0].text,
    );
  assert.match((await read(files[0].id)).content, /0720/);
  assert.match((await read(files[1].id)).content, /page 2/);
  assert.equal(downloads, 2);
  assert.match((await read(files[0].id)).content, /0720/);
  assert.equal(downloads, 2);
  if (process.platform !== 'win32')
    assert.equal((await stat(join(dir, 'input-cache', files[0].sha256))).mode & 0o777, 0o600);
  await writeFile(join(dir, 'input-cache', files[0].sha256), 'corrupted');
  assert.match((await read(files[0].id)).content, /0720/);
  assert.equal(downloads, 3);
  await assert.rejects(() => read(randomUUID()), /当前电脑对话/);
  allowed = false;
  await assert.rejects(() => read(files[0].id), /授权可能已结束/);
  assert.equal(downloads, 3);
  allowed = true;
  config.projects = [];
  await saveConfig(path, config);
  await assert.rejects(() => read(files[0].id), /撤销/);
});
