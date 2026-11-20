import { readFile, writeFile, mkdir, rename, lstat, realpath, chmod } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
export const COMPUTER_PERMISSION_VERSION = 1;
export const FULL_WORKSPACE_PERMISSIONS = Object.freeze([
  'file.read',
  'file.write',
  'terminal.execute',
  'network.outbound',
  'plugin.install',
  'dsh.workspace',
  'computer.background',
]);
export function permissionsFromLegacy({ allowWrite = false, allowExecute = false } = {}) {
  return [
    'file.read',
    ...(allowWrite ? ['file.write'] : []),
    ...(allowExecute ? ['terminal.execute', 'plugin.install'] : []),
  ];
}
export function permissionsForGrant(grant = {}) {
  const permissions = Array.isArray(grant.permissions)
    ? [...new Set(grant.permissions.filter((value) => typeof value === 'string'))]
    : [];
  return permissions.length
    ? permissions
    : permissionsFromLegacy({ allowWrite: grant.allowWrite, allowExecute: grant.allowExecute });
}
export function hasComputerPermission(grant, permission) {
  return permissionsForGrant(grant).includes(permission);
}
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
export async function localGrant(
  root,
  { name, allowWrite = false, allowExecute = false, permissions } = {},
) {
  const actual = await realpath(resolve(root)),
    info = await lstat(actual);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('请选择普通项目目录。');
  const grantPermissions = permissions?.length
    ? permissions
    : permissionsFromLegacy({ allowWrite, allowExecute });
  return {
    id: randomUUID(),
    name: name || basename(actual) || '本机项目',
    root: actual,
    ino: info.ino,
    dev: info.dev,
    allowWrite: grantPermissions.includes('file.write'),
    allowExecute: grantPermissions.includes('terminal.execute'),
    permissionVersion: COMPUTER_PERMISSION_VERSION,
    permissions: grantPermissions,
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
    const project = await localGrant(p.root, {
      allowWrite: !!p.allowWrite,
      allowExecute: !!p.allowExecute,
      permissions: p.permissions,
    });
    p.projects = [project];
    p.legacyProjectId = project.id;
    await saveConfig(path, p);
  }
  for (const project of p.projects) {
    const permissions = permissionsForGrant(project);
    project.permissionVersion ||= COMPUTER_PERMISSION_VERSION;
    project.permissions = permissions;
    project.allowWrite = permissions.includes('file.write');
    project.allowExecute = permissions.includes('terminal.execute');
  }
  p.permissionVersion ||= COMPUTER_PERMISSION_VERSION;
  p.permissions = Array.isArray(p.permissions)
    ? p.permissions
    : p.fullWorkspace
      ? [...FULL_WORKSPACE_PERMISSIONS]
      : permissionsFromLegacy({ allowWrite: p.allowWrite, allowExecute: p.allowExecute });
  if (p.projects.length > 32 || new Set(p.projects.map((p) => p.id)).size !== p.projects.length)
    throw Error('本机项目配置不正确。');
  return p;
}
