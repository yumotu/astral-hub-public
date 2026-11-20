import { mkdirSync, createReadStream, constants } from 'node:fs';
import { open, rm, lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fail } from './accounts.mjs';
import { attachmentMaxBytes, attachmentSizeMessage } from '../deploy/pi/attachment-limits.mjs';
export const maxFileBytes = attachmentMaxBytes;
export function createChatFiles(db, { root, piRoot = root }) {
  root = resolve(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  db.exec(
    'CREATE TABLE IF NOT EXISTS pi_files(id TEXT PRIMARY KEY,owner TEXT NOT NULL,conversation_id TEXT NOT NULL,name TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS pi_files_owner ON pi_files(owner,conversation_id)',
  );
  const prefix = (owner, conversation) =>
    join(createHash('sha256').update(owner).digest('hex'), conversation);
  const publicFile = (row) => ({
    id: row.id,
    name: row.name,
    bytes: row.bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
  });
  function list(owner, conversation) {
    return db
      .prepare('SELECT * FROM pi_files WHERE owner=? AND conversation_id=? ORDER BY created_at')
      .all(owner, conversation);
  }
  function get(owner, conversation, id) {
    const row = db
      .prepare('SELECT * FROM pi_files WHERE owner=? AND conversation_id=? AND id=?')
      .get(owner, conversation, id);
    if (!row) throw fail(404, '附件不存在。');
    return row;
  }
  const assertConversationOpen = (owner, id) => {
    if (
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='relay_closed_conversations'",
        )
        .get() &&
      db.prepare('SELECT 1 FROM relay_closed_conversations WHERE owner=? AND id=?').get(owner, id)
    )
      throw fail(410, '电脑对话已删除。');
  };
  let uploading = new Set();
  const delivered = (owner, conversation, id) =>
    (!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='dsh_task_files'").get() &&
      !!db.prepare('SELECT 1 FROM dsh_task_files d JOIN pi_files f ON f.id=d.file_id AND f.owner=d.owner WHERE d.owner=? AND f.conversation_id=?' + (id ? ' AND f.id=?' : '')).get(...(id ? [owner, conversation, id] : [owner, conversation]))) ||
    (!!db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='relay_job_files'")
      .get() &&
      !!db
        .prepare(
          'SELECT 1 FROM relay_job_files WHERE owner=? AND conversation_id=?' +
            (id ? ' AND file_id=?' : ''),
        )
        .get(...(id ? [owner, conversation, id] : [owner, conversation]))) ||
    !!(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='relay_jobs'").get() &&
      db
        .prepare('PRAGMA table_info(relay_jobs)')
        .all()
        .some((c) => c.name === 'attachments') &&
      db
        .prepare(
          'SELECT 1 FROM relay_jobs WHERE owner=? AND conversation_id=?' +
            (id
              ? ' AND EXISTS(SELECT 1 FROM json_each(attachments) WHERE value=?)'
              : " AND attachments!='[]'"),
        )
        .get(...(id ? [owner, conversation, id] : [owner, conversation]))
    );
  return {
    async clone(owner, source, target, id) {
      const row = get(owner, source, id);
      const path = join(root, prefix(owner, source), id);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== row.bytes)
        throw fail(409, '原附件已变化。');
      const bytes = await readFile(path);
      if (createHash('sha256').update(bytes).digest('hex') !== row.sha256)
        throw fail(409, '原附件校验失败。');
      return this.save(owner, target, row.name, bytes);
    },
    list: (owner, conversation) => list(owner, conversation).map(publicFile),
    async save(owner, conversation, name, bytes, savedId) {
      assertConversationOpen(owner, conversation);
      if (uploading.has(owner)) throw fail(429, '请等待上一个文件上传完成。');
      uploading.add(owner);
      let path,
        written = false;
      try {
        if (
          typeof name !== 'string' ||
          !name.trim() ||
          name.length > 160 ||
          /[\/\\\x00-\x1f]/.test(name)
        )
          throw fail(400, '文件名不正确。');
        if (!Buffer.isBuffer(bytes) || bytes.length > maxFileBytes)
          throw fail(413, attachmentSizeMessage);
        if (savedId) {
          const existing = db
            .prepare('SELECT * FROM pi_files WHERE id=? AND owner=? AND conversation_id=?')
            .get(savedId, owner, conversation);
          if (existing) {
            if (
              existing.name !== name ||
              existing.sha256 !== createHash('sha256').update(bytes).digest('hex')
            )
              throw fail(409, '生成的文件已存在不同内容。');
            return publicFile(existing);
          }
        }
        const usage = db
          .prepare(
            'SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes FROM pi_files WHERE owner=?',
          )
          .get(owner);
        if (usage.count >= 1000 || usage.bytes + bytes.length > 200 * 1024 * 1024)
          throw fail(413, '附件空间已达200 MiB或1000个文件，请删除不需要的对话后重试。');
        const id = savedId || randomUUID(),
          dir = join(root, prefix(owner, conversation));
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        path = join(dir, id);
        const file = await open(path, 'wx', 0o600);
        written = true;
        try {
          await file.writeFile(bytes);
        } finally {
          await file.close();
        }
        assertConversationOpen(owner, conversation);
        db.prepare('INSERT INTO pi_files VALUES(?,?,?,?,?,?,?)').run(
          id,
          owner,
          conversation,
          name.trim(),
          bytes.length,
          createHash('sha256').update(bytes).digest('hex'),
          new Date().toISOString(),
        );
        return publicFile(get(owner, conversation, id));
      } catch (e) {
        if (written) await rm(path, { force: true });
        throw e;
      } finally {
        uploading.delete(owner);
      }
    },
    modelFiles(owner, conversation, ids = []) {
      for (const id of ids) get(owner, conversation, id);
      return list(owner, conversation).map((row) => ({
        ...publicFile(row),
        path: join(piRoot, prefix(owner, conversation), row.id),
      }));
    },
    selected(owner, conversation, ids) {
      return ids.map((id) => publicFile(get(owner, conversation, id)));
    },
    async readBytes(owner, conversation, id, maxBytes = maxFileBytes) {
      const row = get(owner, conversation, id),
        path = join(root, prefix(owner, conversation), id);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const st = await handle.stat();
        if (!st.isFile() || st.nlink > 1 || st.size !== row.bytes || st.size > maxBytes)
          throw fail(413, '附件类型、大小或内容已变化。');
        const bytes = Buffer.alloc(st.size);
        let offset = 0;
        while (offset < bytes.length) {
          const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!chunk.bytesRead) throw fail(409, '附件读取不完整。');
          offset += chunk.bytesRead;
        }
        if (createHash('sha256').update(bytes).digest('hex') !== row.sha256)
          throw fail(409, '附件摘要校验失败。');
        return bytes;
      } finally { await handle.close(); }
    },
    async download(owner, conversation, id, res) {
      const row = get(owner, conversation, id),
        path = join(root, prefix(owner, conversation), id);
      const st = await lstat(path);
      if (!st.isFile() || st.isSymbolicLink() || st.size !== row.bytes)
        throw fail(409, '附件文件已变化。');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': row.bytes,
        'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      const stream = createReadStream(path);
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
    },
    async removeConversation(owner, conversation) {
      if (delivered(owner, conversation)) throw fail(409, '电脑对话附件随电脑历史保留。');
      await rm(join(root, prefix(owner, conversation)), { recursive: true, force: true });
      db.prepare('DELETE FROM pi_files WHERE owner=? AND conversation_id=?').run(
        owner,
        conversation,
      );
    },
    async remove(owner, conversation, id) {
      get(owner, conversation, id);
      if (delivered(owner, conversation, id)) throw fail(409, '已发送的电脑文件随对话保留。');
      if (
        db
          .prepare(
            "SELECT 1 FROM pi_turns WHERE owner=? AND conversation_id=? AND (instr(COALESCE(attachments,''),?)>0 OR instr(COALESCE(artifacts,''),?)>0)",
          )
          .get(owner, conversation, id, id)
      )
        throw fail(409, '已发送的附件随对话保留；删除对话时一起删除。');
      await rm(join(root, prefix(owner, conversation), id), { force: true });
      db.prepare('DELETE FROM pi_files WHERE id=? AND owner=? AND conversation_id=?').run(
        id,
        owner,
        conversation,
      );
    },
  };
}
let activeUploads = 0;
let activeDocumentReads = 0;
// The App has a 512 MiB budget. OCR and two 50 MiB upload buffers must not
// overlap; this bounds resources without changing any conversation tool count.
export function reserveDocumentRead() {
  if (activeUploads || activeDocumentReads) throw fail(429, '附件正在上传或解析，请稍后重试。');
  activeDocumentReads++;
  let released = false;
  return () => { if (!released) { released = true; activeDocumentReads--; } };
}
export async function readUpload(req, maxBytes = maxFileBytes) {
  const sizeMessage = `单个文件最多${maxBytes / 1024 / 1024} MiB。`;
  if (Number(req.headers['content-length']) > maxBytes) throw fail(413, sizeMessage);
  if (activeDocumentReads) throw fail(429, '附件正在解析，请等待本批解析完成后上传。');
  // Each request temporarily holds both chunks and the concatenated buffer.
  // Bound memory before reading bodies, including chunked/slow requests.
  if (activeUploads >= 2) throw fail(429, '当前附件上传繁忙，请稍后再试。');
  activeUploads++;
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBytes) throw fail(413, sizeMessage);
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    activeUploads--;
  }
}
