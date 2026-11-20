import { Flag } from 'lucide-react';
export type LongGoalState = {
  id: string;
  objective: string;
  status: 'active' | 'paused' | 'complete' | 'budget_limited';
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  plan?: {
    goalId: string;
    revision: number;
    criteria: string[];
    items: { id: string; text: string; status: string; evidence?: string }[];
    verification: { criterion: string; evidence: string }[];
  } | null;
};
export function LongGoalCard({
  goal,
  status,
  waiting = false,
}: {
  goal?: LongGoalState | null;
  status?: string;
  waiting?: boolean;
}) {
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
        <strong>
          持续目标 ·{' '}
          {paused
            ? '已暂停'
            : waiting && goal.status === 'active'
              ? '等待你的回复'
              : labels[goal.status]}
        </strong>
        <span>{goal.tokensUsed.toLocaleString()} tokens</span>
      </summary>
      <p>{goal.objective}</p>
      {goal.plan && (
        <>
          <p className="field-help">
            计划版本 {goal.plan.revision} ·{' '}
            {goal.plan.items.filter((v) => v.status === 'done').length}/{goal.plan.items.length}{' '}
            项完成
          </p>
          <ul>
            {goal.plan.criteria.map((c) => (
              <li key={c}>
                {c}
                {goal.plan?.verification.some((v) => v.criterion === c) ? ' · 已验证' : ''}
              </li>
            ))}
          </ul>
          {goal.plan.verification.map((v) => (
            <p key={v.criterion} className="field-help">
              {v.criterion}：{v.evidence}
            </p>
          ))}
        </>
      )}
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
