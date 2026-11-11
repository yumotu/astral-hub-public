const modes = ['manual', 'rules', 'assist', 'full'];
// Preferences contain UI choices, never bearer tokens, approvals or secrets.
// Account and concrete execution identity are part of every storage key.
export function operationPreferenceKey(server, owner, origin, target) {
  return (
    'astral.operations.v1:' + JSON.stringify([server.replace(/\/$/, ''), owner, origin, target])
  );
}
export function readOperationPreferences(storage, key) {
  try {
    const p = JSON.parse(storage.getItem(key) || '{}');
    return {
      ...(['read', 'edit'].includes(p.access) ? { access: p.access } : {}),
      ...(typeof p.execute === 'boolean' ? { execute: p.execute } : {}),
      ...(['off', 'low', 'high', 'max'].includes(p.thinkingLevel)
        ? { thinkingLevel: p.thinkingLevel }
        : {}),
      ...(modes.includes(p.approvalMode) ? { approvalMode: p.approvalMode } : {}),
      ...(Array.isArray(p.approvalTargets) &&
      p.approvalTargets.length &&
      p.approvalTargets.every((v) => ['pi', 'server'].includes(v))
        ? { approvalTargets: [...new Set(p.approvalTargets)] }
        : {}),
      ...(['15', '60', '120', 'always'].includes(p.approvalMinutes)
        ? { approvalMinutes: p.approvalMinutes }
        : {}),
      ...(['5', '15', '60'].includes(p.networkMinutes) ? { networkMinutes: p.networkMinutes } : {}),
    };
  } catch {
    return {};
  }
}
export function saveOperationPreferences(storage, key, patch) {
  try {
    const merged = { ...readOperationPreferences(storage, key), ...patch };
    const value = readOperationPreferences({ getItem: () => JSON.stringify(merged) }, key);
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
