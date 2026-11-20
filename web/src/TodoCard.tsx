import { Check, ChevronDown, Circle, ListChecks, LoaderCircle, Minus } from 'lucide-react';
import type { TodoItem } from './types';

export function TodoDropdown({ items }: { items: TodoItem[] }) {
  if (!items.length) return null;
  const done = items.filter((item) => item.status === 'done').length;
  return (
    <details className="composer-todos">
      <summary aria-label={`任务清单，${done} / ${items.length} 已完成`}>
        <ListChecks size={15} aria-hidden="true" />
        <span className="todo-dropdown-title">任务清单</span>
        <span className="todo-dropdown-count">
          {done} / {items.length} 已完成
        </span>
        <ChevronDown size={14} className="todo-dropdown-chevron" aria-hidden="true" />
      </summary>
      <div className="todo-dropdown-body">
        {!!items.length && (
          <div
            className="todo-progress"
            role="progressbar"
            aria-label="任务完成进度"
            aria-valuemin={0}
            aria-valuemax={items.length}
            aria-valuenow={done}
          >
            <span style={{ width: `${(done / items.length) * 100}%` }} />
          </div>
        )}
        {items.length ? (
          <ol className="todo-items">
            {items.map((item, index) => (
              <li key={`${item.id}:${index}`} className={`todo-item is-${item.status}`}>
                <span
                  className="todo-item-state"
                  title={
                    { done: '已完成', running: '进行中', pending: '待办', cancelled: '已取消' }[
                      item.status
                    ]
                  }
                >
                  {item.status === 'done' ? (
                    <Check size={13} />
                  ) : item.status === 'running' ? (
                    <LoaderCircle size={13} className="spin" />
                  ) : item.status === 'cancelled' ? (
                    <Minus size={13} />
                  ) : (
                    <Circle size={13} />
                  )}
                </span>
                <span className="todo-item-text">{item.text}</span>
                {item.status === 'running' && <span className="todo-current">进行中</span>}
                <span className="sr-only">
                  {item.status === 'done'
                    ? '已完成'
                    : item.status === 'pending'
                      ? '待办'
                      : item.status === 'cancelled'
                        ? '已取消'
                        : ''}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <div className="todo-empty">暂无待办事项</div>
        )}
      </div>
    </details>
  );
}
