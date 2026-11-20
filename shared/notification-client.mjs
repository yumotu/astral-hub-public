// Share delivery between long polling and an immediate test response. A failed
// delivery is never remembered as successful, so its cursor can be retried.
/** @param {{deliver: (notice: any) => Promise<any>, seen?: string[], persist?: (ids: string[]) => void}} options */
export function notificationDelivery({ deliver, seen = [], persist = () => {} }) {
  const completed = new Set(seen),
    pending = new Map();
  return async function once(notice) {
    if (completed.has(notice.id)) return { mode: 'duplicate' };
    if (pending.has(notice.id)) return pending.get(notice.id);
    const operation = Promise.resolve()
      .then(() => deliver(notice))
      .then((result) => {
        if (result?.mode !== 'ignored') {
          completed.add(notice.id);
          while (completed.size > 200) completed.delete(completed.values().next().value);
          persist([...completed]);
        }
        return result;
      })
      .finally(() => pending.delete(notice.id));
    pending.set(notice.id, operation);
    return operation;
  };
}
export async function deliverNotificationBatch(notices, { deliver, acknowledge, active }) {
  for (const notice of notices) {
    if (!active()) return;
    await deliver(notice);
    if (!active()) return;
    acknowledge(notice.seq);
  }
}
