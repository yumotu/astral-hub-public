import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, truncate, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { readUpload } from '../server/files.mjs';
import { readAttachment } from '../deploy/pi/attachments.mjs';
import { attachmentMaxBytes } from '../deploy/pi/attachment-limits.mjs';

test('attachment readers cap declared/chunked requests and release bounded receive slots after failure', async () => {
  const req = (chunks, length) =>
    Object.assign(Readable.from(chunks), {
      headers: length === undefined ? {} : { 'content-length': String(length) },
    });
  await assert.rejects(readUpload(req([], attachmentMaxBytes + 1)), { status: 413 });
  await assert.rejects(readUpload(req([Buffer.from('123'), Buffer.from('456')]), 5), {
    status: 413,
  });
  let release;
  const gate = new Promise((r) => (release = r));
  const waiting = () =>
    req(
      (async function* () {
        await gate;
        yield Buffer.from('ok');
      })(),
    );
  const first = readUpload(waiting()),
    second = readUpload(waiting());
  await assert.rejects(readUpload(req([])), { status: 429 });
  release();
  assert.deepEqual(await first, Buffer.from('ok'));
  assert.deepEqual(await second, Buffer.from('ok'));
  assert.deepEqual(await readUpload(req([Buffer.from('next')])), Buffer.from('next'));
});

test('Pi reads scoped 16/50 MiB attachments and rejects oversized or changed bytes', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'astral-large-pi-attachments-')));
  const previous = process.env.ASTRAL_UPLOADS_ROOT;
  process.env.ASTRAL_UPLOADS_ROOT = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.ASTRAL_UPLOADS_ROOT;
    else process.env.ASTRAL_UPLOADS_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  const dir = join(root, 'a'.repeat(64), randomUUID());
  await mkdir(dir, { recursive: true });
  for (const size of [16 * 1024 * 1024, attachmentMaxBytes]) {
    const bytes = Buffer.alloc(size, 65),
      path = join(dir, randomUUID());
    await writeFile(path, bytes);
    const file = { path, sha256: createHash('sha256').update(bytes).digest('hex') };
    assert.equal((await readAttachment(file)).length, size);
    await assert.rejects(readAttachment({ ...file, sha256: '0'.repeat(64) }), /已变化/);
    await truncate(path, attachmentMaxBytes + 1);
    await assert.rejects(readAttachment(file), /大小/);
  }
});

test('HTTPS ingress matches the attachment cap and streams bodies without a smaller temporary-file budget', async () => {
  const { readFile } = await import('node:fs/promises');
  const config = await readFile(new URL('../deploy/https/nginx.conf.template', import.meta.url), 'utf8');
  const megabytes = Number(config.match(/client_max_body_size\s+(\d+)m;/)?.[1]);
  assert.equal(megabytes * 1024 * 1024, attachmentMaxBytes);
  assert.match(config, /proxy_request_buffering\s+off;/);
  assert.match(config, /proxy_http_version\s+1\.1;/);
});
