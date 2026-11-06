export function runState(status = 'done', phase = '') {
  const busy = ['queued', 'running', 'delivering', 'accepted', 'applied', 'stopping'].includes(
    status,
  );
  const waiting = status === 'running' && /^等待你的|^等待用户/.test(phase);
  const label =
    status === 'stopping'
      ? '正在停止'
      : status === 'running'
        ? waiting
          ? '等待你的回复'
          : /已完成|已停止|已中断|执行失败/.test(phase)
            ? '正在执行'
            : phase || '正在执行'
        : status === 'done'
          ? '已完成'
          : status === 'cancelled'
            ? '已停止'
            : status === 'interrupted'
              ? '已中断，结果待核对'
              : status === 'error'
                ? '执行失败'
                : phase || '等待执行';
  return {
    busy,
    waiting,
    label,
    spinning: (status === 'running' && !waiting) || status === 'stopping',
    state:
      status === 'running'
        ? waiting
          ? 'waiting'
          : 'executing'
        : status === 'stopping'
          ? 'stopping'
          : status === 'cancelled'
            ? 'stopped'
            : status === 'done'
              ? 'complete'
              : busy
                ? 'queued'
                : 'failed',
  };
}
