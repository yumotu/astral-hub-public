import { useEffect, useState } from 'react';
import type { PiTask } from './pi-tasks';
export function TaskActivity({ task }: { task: PiTask }) {
  const [at, setAt] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setAt(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);
  const elapsed = Math.max(
    0,
    Math.floor((at - Date.parse(task.lastActivityAt || task.startedAt || task.createdAt)) / 1000),
  );
  if (elapsed < 30 || task.uiRequests?.some((r) => r.status !== 'resolved')) return null;
  const tool = task.tools.find((t) => t.status === 'running');
  return (
    <p className="field-help task-inactivity" role="status">
      {tool ? '工具仍在执行，尚未返回新结果。' : '等待模型继续，尚未收到新内容。'}最近一次进展为{' '}
      {elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分钟`}
      前。切换对话不会停止任务；可使用输入框旁的停止按钮结束。
    </p>
  );
}
