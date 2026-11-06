import type { OutboxRow } from './message-outbox';
export function MessageOutbox({
  rows,
  retry,
  reconcile,
  restore,
}: {
  rows: OutboxRow[];
  retry: (id: string) => void;
  reconcile: (id: string) => Promise<void>;
  restore: (row: OutboxRow) => void;
}) {
  const failed = rows.filter((row) => ['unknown', 'rejected'].includes(row.status));
  if (!failed.length) return null;
  return (
    <div className="message-delivery-recovery" aria-live="polite">
      {failed.map((row) => (
        <details key={row.payload.id}>
          <summary>
            {row.status === 'rejected' ? '消息未发送，点击处理' : '消息送达结果待核对'}
          </summary>
          <p>{row.error || '请先查询送达状态，同一编号不会重复创建任务。'}</p>
          <div className="action-row">
            <button
              type="button"
              className="text-link"
              onClick={() => void reconcile(row.payload.id)}
            >
              查询送达
            </button>
            <button type="button" className="text-link" onClick={() => retry(row.payload.id)}>
              原编号重试
            </button>
            {row.status === 'rejected' && (
              <button type="button" className="text-link" onClick={() => restore(row)}>
                放回输入框
              </button>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}
