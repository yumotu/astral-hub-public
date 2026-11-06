import { Flag } from 'lucide-react';
export type LongGoalState = {
  id: string;
  objective: string;
  status: 'active' | 'paused' | 'complete' | 'budget_limited';
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
};
export function LongGoalCard({ goal, status }: { goal?: LongGoalState | null; status?: string }) {
  if (!goal) return null;
  const paused =
    goal.status === 'active' && ['cancelled', 'error', 'interrupted'].includes(status || '');
  const labels = {
    active: '持续执行',
    paused: '已暂停',
    complete: '已完成',
    budget_limited: '已达到预算',
  };
  return (
    <details className="long-goal-card">
      <summary>
        <Flag size={14} />
        <strong>持续目标 · {paused ? '已暂停' : labels[goal.status]}</strong>
        <span>{goal.tokensUsed.toLocaleString()} tokens</span>
      </summary>
      <p>{goal.objective}</p>
      <small>
        累计用时 {Math.floor(goal.timeUsedSeconds / 60)} 分钟
        {goal.tokenBudget !== null ? ` · Token 上限 ${goal.tokenBudget.toLocaleString()}` : ''}
      </small>
      {(paused || goal.status === 'paused') && (
        <p className="field-help">输入 /long-goal resume 继续；恢复前先核对已保存的进度。</p>
      )}
    </details>
  );
}
