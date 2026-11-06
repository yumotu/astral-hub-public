export function goalRequest(input) {
  const match = /^\/(?:goals?|plan)(?:\s+([\s\S]*))?$/i.exec(input.trim());
  return match
    ? `用户通过星屿的目标计划指令要求：${match[1]?.trim() || '查看当前账号的目标与计划'}。请调用 goal_manage 实际读取或管理，先读取现有目标与 revision。目标不是技能，不创建 SKILL.md；只记录计划不等于已经执行。新增需求应加入相关目标步骤，不重复建立同一目标。`
    : input;
}
export function validateCreatedSkillName(name) {
  if (/(^|-)(?:skill|skills)(?:-|$)/i.test(name))
    throw new Error(
      '请按用途命名，不添加 skill 或 skills 前后缀，例如 pdf-reader、application-review。',
    );
  return name;
}
