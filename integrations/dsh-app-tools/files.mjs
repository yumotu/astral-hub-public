import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { resolve, relative, join, basename, dirname, sep } from 'node:path';

const MiB = 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const stableId = (value) => {
  const h = digest(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
function params(args, keys) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !keys.includes(k)))
    throw Error('附件工具参数无效。');
}
async function bounded(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw Error('附件超出此工具的传输上限。');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body || []) {
    size += chunk.length;
    if (size > limit) throw Error('附件超出此工具的传输上限。');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export function createFileTools({ endpoint, workspaceRoot, grant, call, request = fetch }) {
  // An external native host must explicitly configure its permitted workspace.
  // Never infer it from a model-supplied absolute path or expose Astral storage.
  async function pathInWorkspace(path, g, create = false) {
    if (!workspaceRoot || resolve(workspaceRoot) === sep) throw Error('此DSH主机未配置附件工作区。');
    const root = resolve(workspaceRoot);
    if (await realpath(root) !== root || !(await lstat(root)).isDirectory()) throw Error('附件工作区不是可信目录。');
    const target = resolve(root, path), rel = relative(root, target);
    if (!rel || rel.startsWith('..' + sep) || rel === '..' || rel.startsWith(sep)) throw Error('文件必须在当前授权工作区内。');
    const parts = rel.split(sep);
    const staged = parts[0] === '.astral-attachments' && parts[1] === g.taskId;
    if (parts[0] === '.astral-attachments' && !staged) throw Error('不能交付其他任务的附件暂存文件。');
    if (!staged && parts.some(p => /^(\.env(?:\..*)?|\.git|\.ssh|\.aws|\.codex|\.dsh|\.pi|private|node_modules)$/i.test(p)))
      throw Error('不能交付私有配置、凭据或工具内部文件。');
    let current = root;
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      if (create) await mkdir(current, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw Error('附件路径不能经过符号链接。');
    }
    return target;
  }
  async function original(path, limit) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.nlink !== 1 || st.size > limit) throw Error(`只能交付普通文件，单文件最多${limit / MiB} MiB。`);
      const bytes = Buffer.alloc(st.size);
      let at = 0;
      while (at < bytes.length) {
        const { bytesRead } = await handle.read(bytes, at, bytes.length - at, at);
        if (!bytesRead) throw Error('文件在读取时发生变化。');
        at += bytesRead;
      }
      const after = await handle.stat();
      if (after.size !== st.size || after.mtimeMs !== st.mtimeMs) throw Error('文件在读取时发生变化。');
      return bytes;
    } finally { await handle.close(); }
  }
  async function api(g, command, exec) {
    const result = await call(g, command, exec.signal);
    grant(exec, g);
    if (result?.state !== 'done') throw Error('附件工具未完成，请核对原操作，不重放未知结果。');
    return result.result;
  }
  return async function execute(name, args, exec) {
    const g = grant(exec);
    if (name === 'chat_files') {
      params(args, []);
      return api(g, { action: 'invoke', name: 'attachments.list', input: {}, callId: exec.callId }, exec);
    }
    if (name === 'chat_read') {
      params(args, ['id', 'startLine', 'limit', 'startPage', 'pageLimit', 'mode']);
      return api(g, { action: 'invoke', name: 'attachments.read', input: args, callId: exec.callId }, exec);
    }
    const headers = {
      Authorization: 'Bearer ' + g.token,
      'X-Astral-Task-Id': g.taskId, 'X-Astral-Request-Id': g.requestId,
      'X-Astral-Session-Id': g.sessionId,
    };
    const signal = exec.signal ? AbortSignal.any([exec.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000);
    if (name === 'chat_download') {
      params(args, ['id']);
      if (!uuid(args.id)) throw Error('附件编号无效。');
      const catalogue = await api(g, { action: 'invoke', name: 'attachments.list', input: {}, callId: exec.callId + ':list' }, exec);
      const file = catalogue.files.find(f => f.id === args.id);
      if (!file) throw Error('附件未提交给当前任务。');
      if (file.bytes > 20 * MiB) throw Error('原件传输上限20 MiB；可用chat_read分页读取，星屿仍保留50 MiB以内原件。');
      const response = await request(endpoint + '/files/' + args.id, { headers, signal, redirect: 'error' });
      if (!response.ok) throw Error('附件原件请求被拒绝，请核对授权及传输上限。');
      const bytes = await bounded(response, 20 * MiB);
      grant(exec, g);
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256 || response.headers.get('x-astral-sha256') !== file.sha256)
        throw Error('附件原件摘要或大小校验失败。');
      const safeName = basename(file.name).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 100) || 'attachment';
      const target = await pathInWorkspace(join('.astral-attachments', g.taskId, file.id + '-' + safeName), g, true);
      grant(exec, g);
      let created = false;
      try {
        try {
          const handle = await open(target, 'wx', 0o600);
          created = true;
          try { await handle.writeFile(bytes); } finally { await handle.close(); }
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          if (digest(await original(target, 20 * MiB)) !== file.sha256) throw Error('暂存文件已有不同内容，不覆盖。');
        }
        grant(exec, g);
        return { file, path: target, sha256: file.sha256, transferred: true, untrusted: true };
      } catch (e) { if (created) await rm(target, { force: true }); throw e; }
    }
    if (name !== 'chat_export') throw Error('未知附件工具。');
    params(args, ['path', 'name']);
    if (typeof args.path !== 'string' || !args.path || args.path.length > 4000) throw Error('请提供实际已生成文件的路径。');
    const path = await pathInWorkspace(args.path, g),
      bytes = await original(path, 10 * MiB),
      id = stableId(JSON.stringify([g.taskId, g.sessionId, exec.callId]));
    const fileName = args.name || basename(path);
    if (typeof fileName !== 'string' || fileName !== fileName.trim() || !fileName || fileName.length > 160 || /[\/\\\x00-\x1f]/.test(fileName)) throw Error('交付文件名无效。');
    grant(exec, g);
    const response = await request(endpoint + '/files/' + id, {
      method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'X-Astral-File-Name': encodeURIComponent(fileName) },
      body: bytes, signal, redirect: 'error',
    });
    const result = JSON.parse((await bounded(response, 1000000)).toString());
    if (!response.ok) throw Error(result.error || '文件交付被拒绝或结果待核对；请用chat_files核对，不重放未知交付。');
    grant(exec, g);
    if (result.file?.id !== id || result.file?.sha256 !== digest(bytes) || result.file?.bytes !== bytes.length)
      throw Error('文件交付回执校验失败，请用chat_files核对原编号。');
    return { delivered: true, file: result.file, note: '已保存到当前星屿对话，可预览或下载。' };
  };
}
