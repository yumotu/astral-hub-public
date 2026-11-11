import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createDshConversations } from '../server/dsh-conversations.mjs';
import { createChatFiles, readUpload } from '../server/files.mjs';
import { createAppFunctions } from '../server/app-functions.mjs';
import { createAppToolsPlugin } from '../integrations/dsh-app-tools/core.mjs';
import { dshReadSchema, dshFileScope, createDshFiles } from '../server/dsh-files.mjs';
import { documentFixtures } from './fixtures/document-files.mjs';
import { scannedPdf } from './fixtures/scanned-pdf.mjs';
import { uploadChatFile, fetchChatFile } from '../web/src/chat-file-transport.ts';

const MiB = 1024 * 1024, hash = b => createHash('sha256').update(b).digest('hex');
async function fixture(t, { oldPlugin = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'astral-dsh-files-'))), db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE pi_turns(owner TEXT,conversation_id TEXT,attachments TEXT,artifacts TEXT);');
  const files = createChatFiles(db, { root: join(root, 'storage') }), workspace = join(root, 'workspace');
  await mkdir(workspace);
  let service, engine, plugin, listener, seq = -1, turn = 0, currentGrant, online = true, loggedIn = true;
  const connectionId = randomUUID(), conversation = randomUUID(), agent = { id: 'native-test-session' }, rates = new Map();
  const body = async req => { const chunks = []; for await (const b of req) chunks.push(b); return JSON.parse(Buffer.concat(chunks)); };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, endpoint), json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    try {
      if (await service.before(req, url, json, res)) return;
      const actor = { id: req.headers.authorization === 'Bearer bob' ? 'bob' : 'alice', sessionHash: 'session' };
      if (await service.handle(req, url, json, actor, res)) return;
      json(404, {});
    } catch (e) { json(e.status || (e.name === 'ZodError' ? 400 : 500), { error: e.message }); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`, endpoint = base + '/api/agent/dsh/app-access';
  const path = `/api/agent/remote/conversations/${conversation}`;
  plugin = createAppToolsPlugin({ endpoint, workspaceRoot: workspace });
  function emit(type, data) {
    const event = { seq: ++seq, type, time: Date.now(), data, ...(/message|result/.test(type) ? { surfaceOp: 'append' } : {}) };
    plugin.observe(agent, event); listener({ type: 'event', event });
  }
  const chat = {
    async watch(_id, cb) { listener = cb; const state = db.prepare('SELECT snapshot FROM dsh_conversations WHERE id=?').get(conversation); cb({ type: 'snapshot', header: { id: agent.id, version: 3 }, cursor: seq, records: JSON.parse(state.snapshot).events.map(event => ({ type: 'event', event })), projections: { asOfSeq: Math.max(0, seq), values: {} } }); },
    async bindAppTools(_id, g) { currentGrant = g; const result = await plugin.bind({ agent, rawInput: JSON.stringify(g) }); assert.equal(result.kind, 'success'); const proof = JSON.parse(result.text); if (oldPlugin) delete proof.fileBridgeVersion; return proof; },
    async prompt(_id, requestId, text) { emit('turn/start', { turn: ++turn }); emit('user/message', { content: [{ type: 'text', text: text + '\n\nNative attachment routing metadata' }], source: { kind: 'user', rpcId: requestId } }); return { accepted: true }; },
    async cancel() { return { accepted: true }; },
  };
  service = createDshConversations(db, { body, files: () => files, rate(owner, kind, max) { const k=owner+':'+kind,n=rates.get(k)||0;if(n>=max)throw Object.assign(Error('rate exceeded'),{status:429});rates.set(k,n+1); }, live() { if (!online) throw Error('offline'); return { state: 'ready' }; }, connection: async () => ({ client: { chat: () => chat }, peer: { location: 'server', deviceId: 'synthetic' } }), catalogue: async () => ({ host: { location: 'server', deviceId: 'synthetic' }, workspaces: [{ id: 'project' }], sessions: [{ id: agent.id, workspaceIds: ['project'] }] }), appTools: { endpoint, engine: () => engine, sessionActive: () => loggedIn } });
  engine = createAppFunctions(db, { token: 'synthetic-file-encryption-key-1234567890', body, profile: id => ({ id }), isActive: ctx => service.appActive(ctx) });
  engine.register({ name: 'attachments.list', description: 'files', schema: z.object({}).strict(), execute: ctx => service.fileCatalog(ctx) });
  engine.register({ name: 'attachments.read', description: 'read', schema: dshReadSchema, execute: (ctx, p) => service.fileRead(ctx, p) });
  async function req(route = '', input, who = 'alice', method = input ? 'POST' : 'GET') {
    const r = await fetch(base + (route.startsWith('/api/') ? route : path + route), { method, headers: { Authorization: 'Bearer ' + who, 'Content-Type': 'application/json' }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: r.status, value: await r.json() };
  }
  async function upload(name, bytes) { const r = await fetch(base + path + '/files?name=' + encodeURIComponent(name), { method: 'POST', headers: { Authorization: 'Bearer alice' }, body: bytes }); const value = await r.json(); assert.equal(r.status, 201, JSON.stringify(value)); return value.file; }
  await req('/api/agent/remote/conversations', { id: conversation, connectionId, workspaceId: 'project', sessionId: agent.id });
  await req('/tools', { enabled: true });
  t.after(async () => { service.close(); engine.close(); plugin.dispose(); server.closeAllConnections(); await new Promise(r => server.close(r)); db.close(); await rm(root, { recursive: true, force: true }); });
  return {
    root, db, service, files, workspace, plugin, agent, base, endpoint, conversation, path, req, upload,
    async prompt(ids = []) { const id = randomUUID(), r = await req('/prompt', { id, text: 'synthetic human input', attachments: ids }); assert.equal(r.status, 200, JSON.stringify(r)); return id; },
    tool: (name, args = {}, callId = randomUUID()) => plugin.file(name, args, { agent, callId, signal: new AbortController().signal }),
    end: () => emit('turn/end', { turn, reason: { kind: 'completed' } }),
    logout: () => { loggedIn = false; },
    disconnect() { online = false; service.disconnect('alice', connectionId); },
    headers: () => ({ Authorization: 'Bearer ' + currentGrant.token, 'X-Astral-Task-Id': currentGrant.taskId, 'X-Astral-Request-Id': currentGrant.requestId, 'X-Astral-Session-Id': agent.id, 'X-Astral-File-Name': encodeURIComponent('export.bin') }),
  };
}
test('DSH real HTTP attachment bridge preserves hashes, document reads, native download/export receipts and browser routes', async t => {
  const f = await fixture(t), fixtures = documentFixtures().slice(0, 4), saved = [];
  for (const v of fixtures) saved.push(await f.upload(v.name, v.bytes));
  const task = await f.prompt(saved.map(v => v.id));
  assert.equal((await f.tool('chat_files')).files.length, 4);
  for (const [i, file] of saved.entries()) {
    const read = await f.tool('chat_read', { id: file.id, mode: 'text', pageLimit: 1 });
    assert.equal(read.originalAvailable, true); assert.equal(read.sha256, hash(fixtures[i].bytes)); assert.ok(read.content.length > 0);
    const downloaded = await f.tool('chat_download', { id: file.id });
    assert.equal(hash(await readFile(downloaded.path)), file.sha256);
  }
  const image = documentFixtures()[4]; await writeFile(join(f.workspace, image.name), image.bytes);
  const first = await f.tool('chat_export', { path: image.name }, 'same-export');
  const again = await f.tool('chat_export', { path: image.name }, 'same-export');
  assert.equal(first.file.id, again.file.id); assert.equal(first.delivered, true);
  const view = (await f.req()).value.conversation;
  assert.equal(view.title, 'synthetic human input');
  assert.equal(view.messages[0].text, 'synthetic human input');
  assert.equal(view.inputs[task].length, 4); assert.equal(view.artifacts.length, 1);
  const settings = { url: f.base, model: 'deepseek-flash', sessionToken: 'alice' };
  assert.equal(hash(Buffer.from(await (await fetchChatFile(settings, f.conversation, first.file)).arrayBuffer())), hash(image.bytes));
  const browser = await uploadChatFile(settings, f.conversation, new File(['browser-body'], 'browser.txt'), { source: 'dsh' });
  assert.equal(browser.source, 'dsh'); assert.equal((await f.req('/files/' + saved[0].id, undefined, 'bob')).status, 404);
  await assert.rejects(f.tool('chat_read', { id: browser.id }), /拒绝|待核对/);
  const samePiId = await f.files.save('alice', f.conversation, 'pi-only.txt', Buffer.from('pi private'));
  await assert.rejects(f.tool('chat_read', { id: samePiId.id }), /拒绝|待核对/);
  assert.notEqual(dshFileScope('alice', f.conversation), f.conversation);
  assert.equal((await f.req('/files/' + saved[0].id, null, 'alice', 'DELETE')).status, 409);
  await assert.rejects(f.files.remove('alice', dshFileScope('alice', f.conversation), saved[0].id), { status: 409 });
  f.end();
  await assert.rejects(f.tool('chat_files'), /授权|未启用/);
  assert.equal((await f.req()).value.conversation.artifacts.length, 1, 'completed artifacts remain in history');
});
test('DSH 50 MiB upload, 20 MiB original and 10/20 MiB export boundaries use actual HTTP bytes', async t => {
  const f = await fixture(t), large = await f.upload('50MiB.txt', Buffer.alloc(50 * MiB, 65));
  const exact = await f.upload('20MiB.bin', Buffer.alloc(20 * MiB, 65)), over = await f.upload('20MiB-plus.bin', Buffer.alloc(20 * MiB + 1, 65));
  await f.prompt([large.id, exact.id, over.id]);
  await assert.rejects(f.tool('chat_download', { id: large.id }), /20 MiB/);
  const bigText = await f.tool('chat_read', { id: large.id, limit: 1 }); assert.equal(bigText.originalAvailable, true); assert.equal(bigText.truncated, true);
  assert.equal((await f.tool('chat_download', { id: exact.id })).file.bytes, 20 * MiB);
  await assert.rejects(f.tool('chat_download', { id: over.id }), /20 MiB/);
  const raw = await fetch(f.endpoint + '/files/' + over.id, { headers: f.headers() }); assert.equal(raw.status, 413);
  await writeFile(join(f.workspace, 'large.bin'), Buffer.alloc(10 * MiB, 66));
  assert.equal((await f.tool('chat_export', { path: 'large.bin' }, 'a')).file.bytes, 10 * MiB);
  await f.tool('chat_export', { path: 'large.bin' }, 'b');
  await assert.rejects(f.tool('chat_export', { path: 'large.bin' }, 'c'), /20 MiB/);
  await writeFile(join(f.workspace, 'over.bin'), Buffer.alloc(10 * MiB + 1));
  await assert.rejects(f.tool('chat_export', { path: 'over.bin' }), /10 MiB/);
  const invalid = await fetch(f.base + f.path + '/files?name=oversize.bin', { method: 'POST', headers: { 'Content-Length': String(50 * MiB + 1) }, body: Buffer.alloc(50 * MiB + 1) }); assert.equal(invalid.status, 413);
});
test('DSH export blocks private paths, traversal, symlinks, hardlinks and changed idempotent content', async t => {
  const f = await fixture(t); await f.prompt();
  const outside = join(f.root, 'outside.txt'); await writeFile(outside, 'secret');
  await writeFile(join(f.workspace, '.env'), 'secret');
  await symlink(outside, join(f.workspace, 'link.txt')); await link(outside, join(f.workspace, 'hard.txt'));
  await symlink(f.root, join(f.workspace, 'sub'));
  for (const path of ['../outside.txt', outside, '.env', 'link.txt', 'hard.txt', 'sub/outside.txt', '.astral-attachments/other/file'])
    await assert.rejects(f.tool('chat_export', { path }));
  await writeFile(join(f.workspace, 'ok.txt'), 'first'); await f.tool('chat_export', { path: 'ok.txt' }, 'same');
  await writeFile(join(f.workspace, 'ok.txt'), 'second'); await assert.rejects(f.tool('chat_export', { path: 'ok.txt' }, 'same'), /内容不符/);
  assert.equal((await f.req()).value.conversation.artifacts.length, 1);
});
for (const mode of ['stop', 'disable', 'logout', 'disconnect']) test(`DSH binary authority rejects ${mode} including an in-flight upload`, async t => {
  const f = await fixture(t), file = await f.upload('test.txt', Buffer.from('test')); await f.prompt([file.id]);
  const headers = f.headers(), id = randomUUID();
  let finish;
  const pending = new Promise((resolve, reject) => {
    const req = httpRequest(f.endpoint + '/files/' + id, { method: 'PUT', headers: { ...headers, 'Content-Length': '4' } }, r => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
    req.on('error', reject); req.write('t'); finish = () => req.end('est');
  });
  await new Promise(r => setTimeout(r, 25));
  if (mode === 'stop') await f.req('/stop', { id: randomUUID() });
  else if (mode === 'disable') await f.req('/tools', { enabled: false }); else f[mode]();
  finish(); assert.ok([403, 409].includes(await pending));
  assert.equal(f.db.prepare("SELECT count(*) n FROM dsh_task_files WHERE kind='artifact'").get().n, 0);
  assert.equal((await fetch(f.endpoint + '/files/' + file.id, { headers })).status, 403);
});
test('DSH parser cancellation and errors preserve original availability without leaking internal paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'astral-dsh-parse-')), db = new DatabaseSync(':memory:');
  let live = true, finish;
  const file = { id: randomUUID(), name: 'input.txt', bytes: 5 }, ctx = { owner: 'alice', conversation: randomUUID(), task: randomUUID() };
  const store = createChatFiles(db, { root }); const saved = await store.save(ctx.owner, dshFileScope(ctx.owner, ctx.conversation), file.name, Buffer.from('input'));
  const bridge = createDshFiles(db, { files: () => store, active: () => live, task: () => ({ id: ctx.task }), read: () => new Promise(r => { finish = r; }) });
  bridge.bind(ctx.owner, ctx.conversation, ctx.task, [saved.id]);
  const parsing = bridge.read(ctx, { id: saved.id });
  while (!finish) await new Promise(r => setImmediate(r));
  await assert.rejects(readUpload({ headers: {} }), { status: 429 }, 'OCR and upload buffers must not overlap');
  live = false; finish({ content: 'must not escape' }); await assert.rejects(parsing, { status: 409 });
  assert.equal(store.list(ctx.owner, dshFileScope(ctx.owner, ctx.conversation)).length, 1);
  const failed = createDshFiles(db, { files: () => store, active: () => true, task: () => ({ id: ctx.task }), read: async () => { throw Error('corrupt data at /app/private/secret'); } });
  await assert.rejects(failed.read(ctx, { id: saved.id }), e => /已读取附件原件/.test(e.message) && !e.message.includes('/app/'));
  await rm(join(root, hash(ctx.owner), dshFileScope(ctx.owner, ctx.conversation), saved.id));
  await assert.rejects(failed.read(ctx, { id: saved.id }), e => /原件暂不可读取/.test(e.message) && !e.message.includes('/tmp/'));
  db.close(); await rm(root, { recursive: true, force: true });
});
test('DSH reads actual Chinese raster PDF and image with offline OCR and retains PDF page cursors', { timeout: 120000 }, async t => {
  const f = await fixture(t), image = await readFile(new URL('./fixtures/ocr-text.jpg', import.meta.url));
  const scan = await f.upload('中文扫描件.pdf', scannedPdf(image)), jpg = await f.upload('中文图片.jpg', image);
  await f.prompt([scan.id, jpg.id]);
  for (const file of [scan, jpg]) {
    const read = await f.tool('chat_read', { id: file.id, pageLimit: 1 });
    assert.equal(read.pages[0].method, 'ocr'); assert.match(read.content, /offline OCR 889/);
    assert.match(read.content.replace(/\s/g, ''), /离线识别文件测试/); assert.equal(read.originalAvailable, true);
  }
});
test('DSH raw export enforces size, count, replay and explicit task/session headers', async t => {
  const f = await fixture(t); await f.prompt();
  const headers = f.headers();
  assert.equal((await fetch(f.endpoint + '/files/' + randomUUID(), { method: 'PUT', headers, body: Buffer.alloc(10 * MiB + 1) })).status, 413);
  for (let i = 0; i < 8; i++) {
    const id = randomUUID(), response = await fetch(f.endpoint + '/files/' + id, { method: 'PUT', headers, body: 'ok' }); assert.equal(response.status, 201);
    assert.equal((await fetch(f.endpoint + '/files/' + id, { method: 'PUT', headers, body: 'ok' })).status, 200);
  }
  assert.equal((await fetch(f.endpoint + '/files/' + randomUUID(), { method: 'PUT', headers, body: 'ok' })).status, 413);
  assert.equal((await fetch(f.endpoint + '/files/' + randomUUID(), { method: 'PUT', headers: { ...headers, 'X-Astral-Session-Id': 'foreign-session' }, body: 'ok' })).status, 403);
});
test('an old native plugin rejects attachments before prompt admission and does not lock an unsent draft file', async t => {
  const f = await fixture(t, { oldPlugin: true }), file = await f.upload('draft.txt', Buffer.from('draft'));
  const id = randomUUID(), result = await f.req('/prompt', { id, text: 'must not be sent', attachments: [file.id] });
  assert.equal(result.status, 409); assert.match(result.value.error, /附件插件/);
  const view = (await f.req()).value.conversation;
  assert.equal(view.messages.length, 0); assert.equal(view.actions.find(a => a.id === id).state, 'rejected');
  assert.equal((await f.req('/files/' + file.id, null, 'alice', 'DELETE')).status, 200);
});
test('DSH previews do not consume the independent upload or delete rate budget', async t => {
  const f = await fixture(t);
  for (let i=0;i<25;i++) assert.equal((await f.req('/files')).status,200);
  const file = await f.upload('after-previews.txt', Buffer.from('still uploadable'));
  assert.equal((await f.req('/files/' + file.id, null, 'alice', 'DELETE')).status,200);
});
