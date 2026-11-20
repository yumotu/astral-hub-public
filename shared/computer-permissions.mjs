export const COMPUTER_PERMISSION_NAMES = Object.freeze([
  'file.read',
  'file.write',
  'terminal.execute',
  'network.outbound',
  'plugin.install',
  'dsh.workspace',
  'computer.background',
]);

export const FULL_WORKSPACE_PERMISSIONS = Object.freeze([...COMPUTER_PERMISSION_NAMES]);
export const COMPUTER_PERMISSION_VERSION = 1;

const known = new Set(COMPUTER_PERMISSION_NAMES);

export function normalizeComputerPermissions(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((name) => typeof name === 'string' && known.has(name)))];
}

export function permissionsFromLegacy({ allowWrite = false, allowExecute = false } = {}) {
  return [
    'file.read',
    ...(allowWrite ? ['file.write'] : []),
    ...(allowExecute ? ['terminal.execute', 'plugin.install'] : []),
  ];
}

export function permissionsForGrant(grant = {}) {
  const permissions = normalizeComputerPermissions(grant.permissions);
  if (grant.permissionProfile === 'full-workspace') return [...FULL_WORKSPACE_PERMISSIONS];
  if (grant.permissionProfile === 'legacy' || !permissions.length)
    return permissionsFromLegacy({
      allowWrite: grant.allowWrite,
      allowExecute: grant.allowExecute,
    });
  return permissions;
}

export function hasComputerPermission(grant, permission) {
  return permissionsForGrant(grant).includes(permission);
}

export function isFullWorkspace(value) {
  const permissions = normalizeComputerPermissions(value);
  return FULL_WORKSPACE_PERMISSIONS.every((permission) => permissions.includes(permission));
}
