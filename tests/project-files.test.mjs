import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectFiles } from '../deploy/pi/project-files.mjs';
import { createCollector } from '../deploy/pi/protocol.mjs';
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-files-')),
    root = join(dir, 'project');
  await mkdir(root);
  await writeFile(join(root, 'README.md'), 'hello\nproject detail\n');
  const files = createProjectFiles({
    projects: [
      { id: 'rw', root, readOnly: false },
      { id: 'ro', root, readOnly: true },
    ],
    backupDir: join(dir, 'backups'),
  });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, root, files };
}

test('raw attachment import preserves bytes and is retry safe without overwrites, private paths, links or read-only bypass', async (t) => {
  const { dir, root, files } = await fixture(t);
  const original = Buffer.concat([
    Buffer.from('%PDF-synthetic-original'),
    Buffer.alloc(16 * 1024 * 1024, 42),
  ]);
  const result = await files.importFile('rw', 'attachments/resume.pdf', original);
  assert.equal(result.created, true);
  assert.deepEqual(await readFile(join(root, result.path)), original);
  assert.equal((await files.importFile('rw', result.path, original)).created, false);
  await assert.rejects(files.importFile('rw', result.path, Buffer.from('different')), /已存在/);
  await assert.rejects(files.importFile('ro', 'new.pdf', original), /修改权限/);
  await assert.rejects(files.importFile('rw', '../outside.pdf', original), /保护|相对路径/);
  await assert.rejects(files.importFile('rw', '.env', original), /保护/);
  await writeFile(join(dir, 'outside.pdf'), 'outside');
  if (process.platform !== 'win32') {
    await symlink(join(dir, 'outside.pdf'), join(root, 'linked.pdf'));
    await assert.rejects(files.importFile('rw', 'linked.pdf', original), /符号链接/);
  }
  assert.equal(await readFile(join(dir, 'outside.pdf'), 'utf8'), 'outside');
  await assert.rejects(
    files.importFile('rw', 'huge.pdf', Buffer.alloc(50 * 1024 * 1024 + 1)),
    /50 MiB/,
  );
});
test('project tools refuse traversal, protected files, symlinks and read-only edits', async (t) => {
  const { dir, root, files } = await fixture(t);
  await writeFile(join(root, '.env'), 'SECRET=hidden');
  await writeFile(join(dir, 'outside.txt'), 'outside');
  await symlink(join(dir, 'outside.txt'), join(root, 'link'));
  for (const path of [
    '../outside.txt',
    '/etc/passwd',
    '.env',
    'link',
    'a/../../outside.txt',
    'C:\\Windows\\file',
  ])
    await assert.rejects(() => files.read('rw', path));
  assert.deepEqual(
    (await files.list('rw')).entries.map((e) => e.name),
    ['README.md'],
  );
  await assert.rejects(
    async () =>
      files.write('ro', 'README.md', 'bad', (await files.read('ro', 'README.md')).sha256, 'edit'),
    { status: 403 },
  );
});

test('explicit executor private paths stay hidden even inside an otherwise authorized root', async (t) => {
  const { dir, root } = await fixture(t),
    config = join(root, 'settings', 'device.json'),
    sessions = join(root, 'sessions');
  await mkdir(join(root, 'settings'));
  await mkdir(sessions);
  await writeFile(config, '{"token":"synthetic-device-credential"}');
  await writeFile(join(sessions, 'history.jsonl'), 'synthetic-private-history');
  const files = createProjectFiles({
    projects: [{ id: 'p', root, readOnly: false }],
    backupDir: join(dir, 'backups'),
    protectedPaths: [config, sessions],
  });
  assert.ok(!(await files.list('p', 'settings')).entries.some((e) => e.name === 'device.json'));
  assert.ok(!(await files.list('p', '.')).entries.some((e) => e.name === 'sessions'));
  for (const path of ['settings/device.json', 'sessions/history.jsonl']) {
    await assert.rejects(() => files.read('p', path), /私有配置/);
    await assert.rejects(() => files.exportFile('p', path), /私有配置/);
    await assert.rejects(() => files.write('p', path, 'changed', 'new', 'edit'), /私有配置/);
  }
  assert.equal((await files.search('p', 'synthetic')).matches.length, 0);
  assert.equal(await readFile(config, 'utf8'), '{"token":"synthetic-device-credential"}');
});
test('writes use hashes, retain backups, restore safely and never overwrite newer edits', async (t) => {
  const { root, files } = await fixture(t);
  const first = await files.read('rw', 'README.md');
  const changed = await files.edit('rw', 'README.md', 'hello', 'hi', first.sha256, 'edit');
  assert.equal(changed.added, 1);
  assert.equal(changed.removed, 1);
  const patch = await files.diff('rw', changed.backupId);
  assert.match(patch.patch, /-hello\n\+hi/);
  await assert.rejects(() => files.diff('ro', changed.backupId), { status: 403 });
  assert.match(await readFile(join(root, 'README.md'), 'utf8'), /^hi/);
  await assert.rejects(() => files.write('rw', 'README.md', 'stale', first.sha256, 'edit'), {
    status: 409,
  });
  await files.restore('rw', changed.backupId);
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'hello\nproject detail\n');
  const created = await files.write('rw', 'nested/new.txt', 'new file', 'new', 'edit');
  await files.restore('rw', created.backupId);
  await assert.rejects(() => readFile(join(root, 'nested/new.txt')));
  const r = await files.read('rw', 'README.md'),
    m = await files.write('rw', 'README.md', 'changed', r.sha256, 'edit');
  await writeFile(join(root, 'README.md'), 'human edit');
  await assert.rejects(() => files.restore('rw', m.backupId), { status: 409 });
  assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'human edit');
});
test('search does not expose protected files or provider keys and bounds large files', async (t) => {
  const { root, files } = await fixture(t);
  await writeFile(join(root, '.env'), 'needle');
  await writeFile(join(root, 'notes.txt'), 'needle sk-' + 'z'.repeat(40));
  await writeFile(join(root, 'large.txt'), 'x'.repeat(300000));
  const r = await files.search('rw', 'needle');
  assert.equal(r.matches.length, 1);
  assert.match(r.matches[0].text, /密钥已隐藏/);
  assert.equal(r.matches[0].text.includes('abcdefghijklmnopqrstuvwxyz'), false);
  await assert.rejects(() => files.read('rw', 'large.txt'), { status: 413 });
});
test('JSON collector preserves Unicode and tracks verified tool results without storing file bodies', () => {
  const c = createCollector({ projectMode: true });
  const events = [
    {
      type: 'tool_execution_start',
      toolCallId: 'one',
      toolName: 'project_read',
      args: { path: 'README.md' },
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'one',
      result: {
        content: [{ type: 'text', text: 'private file body' }],
        details: { totalLines: 2, sha256: 'a'.repeat(64) },
      },
      isError: false,
    },
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '回答\u2028继续' }],
        stopReason: 'stop',
      },
    },
  ]
    .map((x) => JSON.stringify(x))
    .join('\n');
  for (let i = 0; i < events.length; i += 5) c.push(events.slice(i, i + 5));
  const r = c.result();
  assert.equal(r.output, '回答\u2028继续');
  assert.equal(r.tools[0].status, 'done');
  assert.equal(r.tools[0].path, 'README.md');
  assert.equal(JSON.stringify(r.tools).includes('private file body'), false);
});
test('full file documents preserve whitespace, disable redacted editing, and reject stale manual saves', async (t) => {
  const { root, files } = await fixture(t);
  const original = '  # Title\n\nhello\n';
  await writeFile(join(root, 'read.md'), original);
  const doc = await files.document('rw', 'read.md');
  assert.equal(doc.content, original);
  assert.equal(doc.readOnly, false);
  assert.equal((await files.document('ro', 'read.md')).readOnly, true);
  await writeFile(join(root, 'key.txt'), 'sk-' + 'a'.repeat(40));
  const redacted = await files.document('rw', 'key.txt');
  assert.equal(redacted.redacted, true);
  assert.equal(redacted.readOnly, true);
  assert.equal(redacted.content.includes('a'.repeat(40)), false);
  const write = await files.write('rw', 'read.md', original + 'edit\n', doc.sha256, 'edit');
  const diff = await files.diff('rw', write.backupId);
  assert.equal(diff.before, original);
  assert.equal(diff.after, original + 'edit\n');
  await assert.rejects(files.write('rw', 'read.md', 'stale', doc.sha256, 'edit'), { status: 409 });
});
test('separate workers cannot lease the same file, while independent files remain writable and dead leases recover', async (t) => {
  const { dir } = await fixture(t);
  const { lockProjectFile } = await import('../deploy/pi/project-lock.mjs');
  const { spawn } = await import('node:child_process');
  const backup = join(dir, 'locks'),
    path = '/projects/one/file.txt';
  const release = await lockProjectFile(backup, path);
  const run = () =>
    new Promise((resolve, reject) => {
      const script = `import {lockProjectFile} from ${JSON.stringify(new URL('../deploy/pi/project-lock.mjs', import.meta.url).href)};try{const r=await lockProjectFile(${JSON.stringify(backup)},${JSON.stringify(path)});r();console.log('acquired');}catch(e){console.log(e.status);}`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
      let out = '';
      child.stdout.on('data', (x) => (out += x));
      child.on('error', reject);
      child.on('close', () => resolve(out.trim()));
    });
  assert.equal(await run(), '409');
  const other = await lockProjectFile(backup, '/projects/two/file.txt');
  other();
  release();
  assert.equal(await run(), 'acquired');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(backup, '.file-locks.sqlite'));
  db.prepare('INSERT INTO file_locks VALUES(?,?,?)').run(path, 2147483647, 'dead-worker');
  db.close();
  const recovered = await lockProjectFile(backup, path);
  recovered();
});
