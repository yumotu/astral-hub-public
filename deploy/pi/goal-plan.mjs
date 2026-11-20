// Session data only: no filesystem/command permission and no implicit goal.
export function parseGoalPlan(p) {
  if (
    !p ||
    !Number.isSafeInteger(p.revision) ||
    p.revision < 0 ||
    typeof p.goalId !== 'string' ||
    p.goalId.length > 200
  )
    throw Error('目标计划编号或版本无效。');
  const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
  if (
    !Array.isArray(p.criteria) ||
    !p.criteria.length ||
    p.criteria.length > 20 ||
    !p.criteria.every((v) => text(v, 500)) ||
    new Set(p.criteria).size !== p.criteria.length
  )
    throw Error('请提供互不重复的验收标准。');
  if (
    !Array.isArray(p.items) ||
    !p.items.length ||
    p.items.length > 100 ||
    new Set(p.items.map((v) => v.id)).size !== p.items.length ||
    !p.items.every(
      (v) =>
        text(v.id, 100) &&
        text(v.text, 500) &&
        ['pending', 'running', 'done'].includes(v.status) &&
        (!v.evidence || text(v.evidence, 2000)) &&
        (v.status !== 'done' || text(v.evidence, 2000)),
    )
  )
    throw Error('计划步骤需有唯一编号、状态；已完成步骤必须记录实际证据。');
  if (
    !Array.isArray(p.verification) ||
    p.verification.length > 20 ||
    !p.verification.every((v) => p.criteria.includes(v.criterion) && text(v.evidence, 2000)) ||
    new Set(p.verification.map((v) => v.criterion)).size !== p.verification.length
  )
    throw Error('验收证据必须对应计划中的标准。');
  const result = {
    goalId: p.goalId,
    revision: p.revision,
    criteria: p.criteria,
    items: p.items.map((v) => ({
      id: v.id,
      text: v.text,
      status: v.status,
      ...(v.evidence ? { evidence: v.evidence } : {}),
    })),
    verification: p.verification.map((v) => ({ criterion: v.criterion, evidence: v.evidence })),
  };
  if (JSON.stringify(result).length > 24000)
    throw Error('计划内容过长，请精炼证据并引用已保存成果。');
  return result;
}
export function latestGoalPlan(ctx, goalId) {
  const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'custom' && e.customType === 'astral-goal-plan' && e.data?.goalId === goalId) {
      try {
        return parseGoalPlan(e.data);
      } catch {
        return null;
      }
    }
  }
  return null;
}
export function goalPlanComplete(plan) {
  return (
    !!plan &&
    plan.items.every((v) => v.status === 'done' && v.evidence?.trim()) &&
    plan.criteria.every((c) =>
      plan.verification.some((v) => v.criterion === c && v.evidence.trim()),
    )
  );
}
