import { useState, type ReactNode } from 'react';
export function ProjectConversationList({
  children,
  hasMore,
  loadMore,
}: {
  children: ReactNode[];
  hasMore?: boolean;
  loadMore?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      {expanded ? children : children.slice(0, 3)}
      {((!expanded && children.length > 3) || hasMore) && (
        <button
          className="text-link project-more-conversations"
          onClick={() => {
            if (!expanded) {
              setExpanded(true);
              if (children.length <= 3) loadMore?.();
            } else loadMore?.();
          }}
        >
          {expanded ? '加载更多记录' : '更多对话'}
        </button>
      )}
      {expanded && children.length > 3 && (
        <button className="text-link project-more-conversations" onClick={() => setExpanded(false)}>
          收起 · 显示最近3个
        </button>
      )}
    </>
  );
}
