// A startup rejection is a definite non-delivery. Only that acknowledgement
// releases its memo entry, permitting the same control ID to be retried safely.
export function steeringUnavailable(accepting, promptStarted) {
  if (accepting) return null;
  return promptStarted
    ? { code: 'task_ended', error: '任务已结束，补充未送达，请排到下一条。' }
    : { code: 'not_ready', error: 'Pi 正在启动，补充尚未送达。' };
}
export function settleSteeringAck(controls, event) {
  const item = controls.get(event.id);
  if (!item) return;
  if (!event.error) {
    item.accept({ disposition: event.disposition });
    return;
  }
  const retryable = event.code === 'not_ready';
  if (retryable) controls.delete(event.id);
  item.decline(Object.assign(new Error(event.error), { status: retryable ? 503 : 409 }));
}
