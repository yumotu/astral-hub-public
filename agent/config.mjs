import { readFile, writeFile, mkdir, rename, lstat, realpath, chmod } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
export function validServer(value) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/')
    throw Error('请输入服务器根地址。');
  if (
    u.protocol !== 'https:' &&
    !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))
  )
    throw Error('公网连接必须使用HTTPS；本机隧道可使用localhost HTTP。');
  return u.origin;
}
export async function localGrant(root, { name, allowWrite = false, allowExecute = false } = {}) {
  const actual = await realpath(resolve(root)),
    info = await lstat(actual);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('请选择普通项目目录。');
  return {
    id: randomUUID(),
    name: name || basename(actual) || '本机项目',
    root: actual,
    ino: info.ino,
    dev: info.dev,
    allowWrite,
    allowExecute,
  };
}
export async function saveConfig(path, config, { create = false } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const text = JSON.stringify(config, null, 2) + '\n';
  if (create) {
    await writeFile(path, text, { mode: 0o600, flag: 'wx' });
    return;
  }
  const temp = path + '.' + randomUUID() + '.tmp';
  await writeFile(temp, text, { mode: 0o600, flag: 'wx' });
  await rename(temp, path);
  await chmod(path, 0o600);
}
export async function loadConfig(path) {
  const p = JSON.parse(await readFile(path, 'utf8'));
  p.server = validServer(p.server);
  if (!Array.isArray(p.projects)) {
    const project = await localGrant(p.root, { allowWrite: !!p.allowWrite });
    p.projects = [project];
    p.legacyProjectId = project.id;
    await saveConfig(path, p);
  }
  if (p.projects.length > 32 || new Set(p.projects.map((p) => p.id)).size !== p.projects.length)
    throw Error('本机项目配置不正确。');
  return p;
}
