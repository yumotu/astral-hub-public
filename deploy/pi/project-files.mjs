import {
  lstat,
  readdir,
  readFile,
  writeFile,
  mkdir,
  rename,
  unlink,
  open,
  realpath,
} from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { resolve, join, dirname, relative, basename, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { lockProjectFile } from './project-lock.mjs';
import { compareFiles } from './file-diff.mjs';
const error = (status, message) => Object.assign(new Error(message), { status });
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const blockedDirs = new Set([
  '.git',
  '.ssh',
  '.aws',
  '.config',
  '.pi',
  'node_modules',
  'data',
  'backups',
  'release',
  'private',
]);
const blockedName =
  /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pypirc|id_rsa.*|id_ed25519.*|auth\.json|credentials(?:\..*)?)$|\.(?:pem|key|p12|pfx|keystore|jks|sqlite|sqlite3|db|log)$/i;
export const redact = (text) =>
  text
    .replace(/sk-[a-zA-Z0-9_-]{24,}/g, '[密钥已隐藏]')
    .replace(
      /-----BEGIN (?:OPENSSH |RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:OPENSSH |RSA |EC )?PRIVATE KEY-----/g,
      '[私钥已隐藏]',
    );
const allowedName = (name) =>
  !(
    blockedDirs.has(name) ||
    blockedName.test(name) ||
    (name.startsWith('.') && name !== '.gitignore')
  );
export function createProjectFiles({
  projects,
  backupDir,
  maxBytes = 262144,
  protectedPaths = [],
}) {
  const canonical = (p) => {
    try {
      return realpathSync(p);
    } catch {
      const parent = dirname(resolve(p));
      return parent === resolve(p) ? parent : join(canonical(parent), basename(p));
    }
  };
  const normalized = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const protectedRoots = protectedPaths.map((p) => normalized(canonical(p)));
  const byId = new Map(projects.map((p) => [p.id, { ...p, root: resolve(p.root) }]));
  const guardRoots = new Map([...byId].map(([id, p]) => [id, canonical(p.root)]));
  const protectedPath = (path, p) => {
    const value = normalized(
      p ? join(guardRoots.get(p.id), relative(p.root, path)) : resolve(path),
    );
    return protectedRoots.some((root) => value === root || value.startsWith(root + sep));
  };
  function project(id) {
    const p = byId.get(id);
    if (!p) throw error(404, '项目不存在或未挂载。');
    return p;
  }
  function pieces(path = '.') {
    if (
      typeof path !== 'string' ||
      path.length > 500 ||
      /[\x00-\x1f\\:]/.test(path) ||
      path.startsWith('/')
    )
      throw error(403, '仅支持项目内的相对路径。');
    if (path === '.' || path === '') return [];
    const parts = path.split('/');
    if (parts.some((n) => !n || n === '.' || n === '..' || !allowedName(n)))
      throw error(403, '路径包含受保护的文件或目录。');
    return parts;
  }
  async function checked(id, path = '.', { createParents = false, allowMissing = false } = {}) {
    const p = project(id),
      parts = pieces(path);
    let current = p.root;
    if (protectedPath(current, p))
      throw error(403, '此路径包含执行器私有配置，无法通过文件工具访问。');
    const rootInfo = await lstat(current).catch(() => {
      throw error(503, '项目目录尚不可用，请检查服务器挂载。');
    });
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
      throw error(403, '项目根目录必须是普通目录。');
    if (p.canonicalRoot && (await realpath(p.root)) !== p.canonicalRoot)
      throw error(403, '项目实际路径已变化，请重新确认目录授权。');
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]);
      if (protectedPath(current, p)) throw error(403, '此路径属于执行器私有配置。');
      let info;
      try {
        info = await lstat(current);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        if (i < parts.length - 1 && createParents) {
          await mkdir(current, { mode: 0o750 }).catch((e) => {
            if (e.code !== 'EEXIST') throw e;
          });
          info = await lstat(current);
        } else if (i === parts.length - 1 && allowMissing)
          return { project: p, path: current, info: null, relative: parts.join('/') };
        else throw error(404, '文件或目录不存在。');
      }
      if (info.isSymbolicLink()) throw error(403, '不允许通过符号链接访问项目文件。');
      if (i < parts.length - 1 && !info.isDirectory()) throw error(400, '父路径不是目录。');
      if (i === parts.length - 1)
        return { project: p, path: current, info, relative: parts.join('/') };
    }
    return { project: p, path: current, info: rootInfo, relative: '.' };
  }
  async function bytes(file) {
    if (!file.info?.isFile()) throw error(400, '请选择普通文本文件。');
    if (file.info.size > maxBytes) throw error(413, '文件超过 256 KiB，请使用搜索或选择较小文件。');
    const handle = await open(file.path, 'r');
    try {
      const info = await handle.stat();
      if (info.size > maxBytes || !info.isFile()) throw error(413, '文件过大或类型不支持。');
      const data = await handle.readFile();
      if (data.includes(0)) throw error(400, '暂不支持二进制文件。');
      return data;
    } finally {
      await handle.close();
    }
  }
  async function list(id, path = '.') {
    const file = await checked(id, path);
    if (!file.info.isDirectory()) throw error(400, '请选择目录。');
    const entries = (await readdir(file.path, { withFileTypes: true }))
      .filter(
        (e) =>
          allowedName(e.name) &&
          !protectedPath(join(file.path, e.name), file.project) &&
          !e.isSymbolicLink() &&
          (e.isFile() || e.isDirectory()),
      )
      .sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
      );
    return {
      path: file.relative,
      entries: entries.slice(0, 200).map((e) => ({
        name: e.name,
        path: file.relative === '.' ? e.name : file.relative + '/' + e.name,
        type: e.isDirectory() ? 'directory' : 'file',
      })),
      truncated: entries.length > 200,
    };
  }
  async function read(id, path, startLine = 1, limit = 200) {
    const file = await checked(id, path),
      data = await bytes(file),
      lines = data.toString('utf8').split('\n');
    startLine = Math.max(1, Math.min(Number(startLine) || 1, 1000000));
    limit = Math.max(1, Math.min(Number(limit) || 200, 400));
    const content = redact(lines.slice(startLine - 1, startLine - 1 + limit).join('\n'));
    return {
      path: file.relative,
      sha256: hash(data),
      totalLines: lines.length,
      startLine,
      content: content.slice(0, 24000),
      truncated: lines.length > startLine - 1 + limit || content.length > 24000,
    };
  }
  async function search(id, query, path = '.', limit = 40) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200)
      throw error(400, '搜索内容应为 1–200 个字符。');
    const matches = [];
    let scanned = 0,
      truncated = false;
    const needle = query.toLowerCase();
    async function walk(dir, depth) {
      if (depth > 10 || scanned >= 1000 || matches.length >= limit) {
        truncated = true;
        return;
      }
      const data = await list(id, dir);
      if (data.truncated) truncated = true;
      for (const e of data.entries) {
        if (scanned >= 1000 || matches.length >= limit) {
          truncated = true;
          break;
        }
        if (e.type === 'directory') {
          await walk(e.path, depth + 1);
          continue;
        }
        scanned++;
        try {
          const file = await checked(id, e.path),
            data = await bytes(file);
          const lines = data.toString('utf8').split('\n');
          for (let i = 0; i < lines.length && matches.length < limit; i++)
            if (lines[i].toLowerCase().includes(needle))
              matches.push({ path: e.path, line: i + 1, text: redact(lines[i].slice(0, 300)) });
        } catch (e) {
          if (![400, 403, 404, 413].includes(e.status)) throw e;
        }
      }
    }
    const file = await checked(id, path);
    if (!file.info.isDirectory()) throw error(400, '搜索范围必须是目录。');
    await walk(file.relative, 0);
    return { query, matches, scanned, truncated };
  }
  async function change(id, path, content, expectedHash, mode = 'edit') {
    const p = project(id);
    if (p.readOnly || mode !== 'edit') throw error(403, '此项目或本次会话为只读。');
    if (
      typeof content !== 'string' ||
      Buffer.byteLength(content) > maxBytes ||
      content.includes('\0')
    )
      throw error(413, '只支持不超过 256 KiB 的文本修改。');
    const release = await lockProjectFile(backupDir, resolve(p.root, ...pieces(path)));
    try {
      const f = await checked(id, path, { createParents: true, allowMissing: true });
      if (f.relative === '.') throw error(400, '需要文件路径。');
      if (f.info && (!f.info.isFile() || f.info.nlink > 1))
        throw error(403, '仅可修改普通且无硬链接的文件。');
      const before = f.info ? await bytes(f) : null,
        current = before ? hash(before) : 'new';
      if (expectedHash !== current) throw error(409, '文件已变化或尚未读取，请先读取最新版本。');
      const after = Buffer.from(content),
        backupId = randomUUID();
      await mkdir(backupDir, { recursive: true, mode: 0o700 });
      const backup = {
        id: backupId,
        projectId: id,
        path: f.relative,
        createdAt: new Date().toISOString(),
        before: before?.toString('base64') ?? null,
        after: after.toString('base64'),
        afterHash: hash(after),
        restored: false,
      };
      await writeFile(join(backupDir, backupId + '.json'), JSON.stringify(backup), {
        mode: 0o600,
        flag: 'wx',
      });
      const temp = join(dirname(f.path), '.astral-write-' + randomUUID());
      try {
        await writeFile(temp, after, { mode: f.info ? f.info.mode & 0o777 : 0o640, flag: 'wx' });
        await rename(temp, f.path);
      } finally {
        await unlink(temp).catch(() => {});
      }
      const stats = await compareFiles(before, after, f.relative).catch(() => null);
      return {
        path: f.relative,
        sha256: hash(after),
        bytes: after.length,
        created: !before,
        backupId,
        ...(stats ? { added: stats.added, removed: stats.removed } : {}),
      };
    } finally {
      release();
    }
  }
  async function edit(id, path, oldText, newText, expectedHash, mode) {
    if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string')
      throw error(400, '需要明确的原文和替换文本。');
    const f = await checked(id, path),
      data = await bytes(f),
      text = data.toString('utf8');
    if (text.split(oldText).length !== 2) throw error(409, '原文需要且只能匹配一次，请重新读取。');
    return change(
      id,
      path,
      text.replace(oldText, () => newText),
      expectedHash,
      mode,
    );
  }
  async function restore(id, backupId) {
    if (!/^[0-9a-f-]{36}$/.test(backupId)) throw error(400, '备份编号不正确。');
    let b;
    try {
      b = JSON.parse(await readFile(join(backupDir, backupId + '.json'), 'utf8'));
    } catch {
      throw error(404, '备份不存在。');
    }
    if (b.projectId !== id) throw error(403, '备份不属于此项目。');
    const release = await lockProjectFile(backupDir, resolve(project(id).root, ...pieces(b.path)));
    try {
      return await restoreUnlocked(id, backupId);
    } finally {
      release();
    }
  }
  async function restoreUnlocked(id, backupId) {
    if (!/^[0-9a-f-]{36}$/.test(backupId)) throw error(400, '备份编号不正确。');
    const file = join(backupDir, backupId + '.json');
    let b;
    try {
      b = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      throw error(404, '备份不存在。');
    }
    if (b.projectId !== id || b.restored) throw error(409, '备份不属于此项目或已恢复。');
    const p = project(id);
    if (p.readOnly) throw error(403, '项目为只读。');
    const f = await checked(id, b.path);
    const current = await bytes(f);
    if (hash(current) !== b.afterHash) throw error(409, '文件在修改后又发生变化，请先手动合并。');
    if (b.before === null) await unlink(f.path);
    else {
      const temp = f.path + '.restore-' + randomUUID();
      try {
        await writeFile(temp, Buffer.from(b.before, 'base64'), {
          mode: f.info.mode & 0o777,
          flag: 'wx',
        });
        await rename(temp, f.path);
      } finally {
        await unlink(temp).catch(() => {});
      }
    }
    b.restored = true;
    await writeFile(file, JSON.stringify(b), { mode: 0o600 });
    return { path: b.path, restored: true };
  }
  async function diff(id, backupId) {
    if (!/^[0-9a-f-]{36}$/.test(backupId)) throw error(400, '备份编号不正确。');
    project(id);
    let b;
    try {
      b = JSON.parse(await readFile(join(backupDir, backupId + '.json'), 'utf8'));
    } catch {
      throw error(404, '备份不存在。');
    }
    if (b.projectId !== id) throw error(403, '备份不属于此项目。');
    const result = await compareFiles(
      b.before === null ? null : Buffer.from(b.before, 'base64'),
      Buffer.from(b.after, 'base64'),
      b.path,
    );
    const text = redact(result.patch);
    return {
      path: b.path,
      before: redact(b.before === null ? '' : Buffer.from(b.before, 'base64').toString('utf8')),
      after: redact(Buffer.from(b.after, 'base64').toString('utf8')),
      added: result.added,
      removed: result.removed,
      patch: text.slice(0, 120000),
      truncated: text.length > 120000,
      restored: !!b.restored,
    };
  }
  return {
    async info(id, path = '.') {
      const f = await checked(id, path);
      return {
        path: f.relative || '.',
        kind: f.info.isDirectory() ? 'directory' : f.info.isFile() ? 'file' : 'other',
        bytes: f.info.size,
        modifiedAt: f.info.mtime.toISOString(),
        readOnly: !!f.project.readOnly,
      };
    },
    async document(id, path) {
      const f = await checked(id, path),
        data = await bytes(f),
        text = data.toString('utf8'),
        content = redact(text);
      return {
        path: f.relative,
        content,
        sha256: hash(data),
        totalLines: text.split('\n').length,
        readOnly: !!f.project.readOnly || content !== text,
        redacted: content !== text,
      };
    },
    async exportFile(id, path, { maxBytes: limit = 2 * 1024 * 1024 } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10 * 1024 * 1024)
        throw error(400, '文件导出大小设置不正确。');
      const file = await checked(id, path);
      if (!file.info.isFile() || file.info.nlink > 1 || file.info.size > limit)
        throw error(413, `导出只支持${limit / 1024 / 1024} MiB以内、无链接的普通文件。`);
      const canonicalRoot = await realpath(file.project.root);
      if ((await realpath(file.path)) !== join(canonicalRoot, file.relative))
        throw error(403, '不允许导出符号链接文件。');
      const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.nlink > 1 ||
          info.size > limit ||
          info.ino !== file.info.ino ||
          info.dev !== file.info.dev
        )
          throw error(409, '文件已变化，请重新读取。');
        const buffer = Buffer.alloc(limit + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const result = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!result.bytesRead) break;
          offset += result.bytesRead;
        }
        if (offset > limit) throw error(413, `文件超过${limit / 1024 / 1024} MiB，请压缩后导出。`);
        return buffer.subarray(0, offset);
      } finally {
        await handle.close();
      }
    },
    async directory(id, path = '.') {
      const f = await checked(id, path);
      if (!f.info.isDirectory()) throw error(400, '请选择文件夹。');
      return f.path;
    },
    async mkdir(id, path) {
      if (project(id).readOnly) throw error(403, '此目录为只读。');
      const f = await checked(id, path, { allowMissing: true });
      if (f.info) throw error(409, '目录或文件已经存在。');
      await mkdir(f.path, { mode: 0o750 });
      return { path: f.relative };
    },
    async readResource(id, path) {
      const f = await checked(id, path);
      if (!f.info.isFile() || f.info.size > maxBytes)
        throw error(413, '技能资源必须是 256 KiB 以内的普通文件。');
      const data = await readFile(f.path);
      if (data.length > maxBytes) throw error(413, '技能资源过大。');
      return { data, mode: f.info.mode & 0o777 };
    },
    list,
    read,
    search,
    write: change,
    edit,
    restore,
    diff,
    project,
    projects: () => [...byId.values()].map(({ root, canonicalRoot, ...p }) => p),
  };
}
