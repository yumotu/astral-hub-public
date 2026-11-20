export function scheduleTarget(context) {
  return context.target?.kind === 'computer'
    ? { kind: 'computer', deviceId: context.target.deviceId, execute: !!context.target.execute }
    : { kind: 'server' };
}
export function sameScheduleScope(a, b) {
  return (
    a?.ownerId === b?.ownerId &&
    a?.conversationId === b?.conversationId &&
    (a?.projectId || null) === (b?.projectId || null) &&
    (a?.access || 'read') === (b?.access || 'read') &&
    JSON.stringify(scheduleTarget(a || {})) === JSON.stringify(scheduleTarget(b || {}))
  );
}
export function ownsScheduleScope(a, b) {
  const at = scheduleTarget(a || {}),
    bt = scheduleTarget(b || {});
  return (
    a?.ownerId === b?.ownerId &&
    a?.conversationId === b?.conversationId &&
    (a?.projectId || null) === (b?.projectId || null) &&
    at.kind === bt.kind &&
    (at.kind !== 'computer' || at.deviceId === bt.deviceId)
  );
}
