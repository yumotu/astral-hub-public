export type PiCommand = { name: string; description?: string; source?: string };
export type PiSkill = {
  name: string;
  description: string;
  enabled: boolean;
  source?: 'managed' | 'package';
  readOnly?: boolean;
};

// Skill execution stays with Pi; this only completes its native /skill:name syntax.
export function commandMenu(
  input: string,
  commands: PiCommand[],
  skills: PiSkill[],
  owner: boolean,
) {
  const picker = /^\/skill(?:\s+(.*)|:([^\s]*))?$/u.exec(input);
  const kind = picker ? 'skills' : /^\/[^\s]*$/u.test(input) ? 'commands' : null;
  if (!kind) return { kind, items: [] as PiCommand[] };
  const query = (picker ? picker[1] || picker[2] || '' : input.slice(1)).trim().toLocaleLowerCase();
  const skillCommands = skills
    .filter((s) => s.enabled)
    .map((s) => ({
      name: `skill:${s.name}`,
      description: s.source === 'package' ? `插件技能 · ${s.description}` : s.description,
      source: 'skill',
    }));
  const available: PiCommand[] =
    kind === 'skills'
      ? skillCommands
      : [
          { name: 'new', description: '开始新的独立会话' },
          { name: 'compact', description: '使用 Pi 原生压缩上下文' },
          { name: 'skill', description: '选择技能，补充任务后发送' },
          { name: 'status', description: '查看当前会话和上下文用量' },
          { name: 'goal', description: '查看或建立目标，持续记录新增需求' },
          { name: 'plan', description: '查看、调整目标的计划与步骤' },
          ...(owner ? [{ name: 'skills', description: '在对话中让助手管理技能' }] : []),
          ...commands.filter(
            (c) => !c.name.startsWith('skill:') && !['skill', 'skills'].includes(c.name),
          ),
          ...skillCommands,
        ];
  const items = [...new Map(available.map((c) => [c.name, c])).values()].filter((c) =>
    `${c.name} ${c.description || ''}`.toLocaleLowerCase().includes(query),
  );
  return { kind, items: items.slice(0, 12) };
}

export function completeCommand(command: PiCommand) {
  return `/${command.name} `;
}
