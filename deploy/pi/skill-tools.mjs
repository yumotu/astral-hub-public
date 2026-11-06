import { Type } from 'typebox';
import { createSkillStore } from './skill-store.mjs';
import { readFile } from 'node:fs/promises';
import {
  parseFrontmatter,
  loadSkills,
} from '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import { createProjectFiles } from './project-files.mjs';
import { createSkillInstaller } from './skill-install.mjs';
import { buildSkillCatalog, packageSkillLocation } from './skill-catalog.mjs';
import { validateCreatedSkillName } from './goal-command.mjs';
export default async function (pi) {
  const store = createSkillStore(process.env.ASTRAL_SKILLS_ROOT);
  const owner = process.env.ASTRAL_SKILLS_WRITE === '1';
  pi.registerTool({
    name: 'read',
    label: '读取技能说明',
    description:
      '读取已启用技能的 SKILL.md 或 Markdown 参考资料，按说明继续当前任务。不能读取其他服务器文件。',
    parameters: Type.Object(
      {
        path: Type.String({ maxLength: 1000 }),
        offset: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 400 })),
      },
      { additionalProperties: false },
    ),
    async execute(_id, p) {
      let text;
      const roots = JSON.parse(process.env.ASTRAL_PACKAGE_SKILLS || '[]');
      const location = await packageSkillLocation(p.path, roots);
      if (location)
        text = (await readFile(location.path, 'utf8'))
          .split('\n')
          .slice((p.offset || 1) - 1, (p.offset || 1) - 1 + (p.limit || 400))
          .join('\n');
      text ??= await store.read(p.path, p.offset, p.limit);
      return {
        content: [{ type: 'text', text }],
        details: {},
      };
    },
  });
  pi.registerTool({
    name: 'skill_list',
    label: '查找可用技能',
    description: owner
      ? '列出自建与当前已加载插件技能的名称、用途、启停状态、来源和路径；插件技能 readOnly，仅通过 package_manage 维护。自建技能包含停用项；includeRemoved 查看已移除项。管理自建技能前使用 skill_manage inspect 查看 revision；执行技能用 read。同名项遵循 Pi 加载优先级，diagnostics 保留冲突。'
      : '列出已启用技能的名称、用途和 SKILL.md 路径；找到适用技能后使用 read 加载并按说明执行。',
    parameters: Type.Object(owner ? { includeRemoved: Type.Optional(Type.Boolean()) } : {}, {
      additionalProperties: false,
    }),
    async execute(_id, p = {}) {
      const catalog = await buildSkillCatalog({
        root: process.env.ASTRAL_SKILLS_ROOT,
        managed: await store.list(),
        packagePaths: JSON.parse(process.env.ASTRAL_PACKAGE_SKILLS || '[]'),
        owner,
        includeRemoved: p.includeRemoved,
        cwd: process.env.PI_CODING_AGENT_DIR,
        agentDir: process.env.PI_CODING_AGENT_DIR,
        loadSkills,
      });
      return { content: [{ type: 'text', text: JSON.stringify(catalog) }], details: {} };
    },
  });
  if (owner)
    pi.registerTool({
      name: 'skill_manage',
      label: '管理技能',
      description:
        '仅在用户要求管理自建技能（source=managed）时使用；source=package 为只读插件技能，请用 package_manage 维护包，不能用本工具更改。同名自建项的修改不影响 Pi 优先加载的包技能。先 inspect 查看内容、启停状态及 revision（含停用、已移除技能），再用当前 revision 执行 update 修改用途/说明、enable 启用、disable 停用、remove 移除、restore 恢复。移除可恢复，恢复后保持停用；不扩大工具权限。revision 过期需重新查看，不能覆盖。',
      parameters: Type.Object(
        {
          name: Type.String({ pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 }),
          action: Type.Union(
            ['inspect', 'update', 'enable', 'disable', 'remove', 'restore'].map((value) =>
              Type.Literal(value),
            ),
          ),
          revision: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })),
          description: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
          instructions: Type.Optional(Type.String({ minLength: 1, maxLength: 60000 })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, p, signal) {
        if (signal?.aborted) throw new Error('操作已取消');
        const result = await store.manage(p);
        const labels = {
          inspect: '已查看',
          update: '已更新',
          enable: '已启用',
          disable: '已停用',
          remove: '已移除，可恢复',
          restore: '已恢复，当前停用',
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: { skillName: p.name, summary: `${p.name} ${labels[p.action]}` },
        };
      },
    });
  if (process.env.ASTRAL_SKILLS_WRITE === '1')
    pi.registerTool({
      name: 'skill_create',
      label: '创建技能',
      description:
        '仅在用户要求创建或保存技能时调用。为工作流程命名并保存标准 SKILL.md 到星屿技能库，立即启用，不覆盖同名技能。已有项目技能目录应使用 skill_install。返回路径可用 read 读取，本轮即可使用；后续可在 /skill 选择。技能不增加工具权限。',
      parameters: Type.Object(
        {
          name: Type.String({ pattern: '^[a-z0-9]+(-[a-z0-9]+)*$', maxLength: 64 }),
          description: Type.String({ minLength: 1, maxLength: 1024 }),
          instructions: Type.String({ minLength: 1, maxLength: 60000 }),
        },
        { additionalProperties: false },
      ),
      async execute(_id, p, signal) {
        if (signal?.aborted) throw new Error('操作已取消');
        validateCreatedSkillName(p.name);
        const saved = await store.save({ ...p, enabled: true }, { createOnly: true });
        return {
          content: [{ type: 'text', text: JSON.stringify(saved) }],
          details: { skillName: saved.name },
        };
      },
    });
  if (process.env.ASTRAL_SKILLS_WRITE === '1' && process.env.ASTRAL_PROJECT_ID) {
    const projects = JSON.parse(await readFile(process.env.ASTRAL_PROJECTS_FILE, 'utf8'));
    const files = createProjectFiles({ projects, backupDir: process.env.ASTRAL_PROJECT_BACKUPS });
    const install = createSkillInstaller({ files, store, parseFrontmatter });
    pi.registerTool({
      name: 'skill_install',
      label: '导入项目技能',
      description:
        '将当前项目（或明确授权目录）里的标准技能目录导入星屿持久技能库。path 可指向单个含 SKILL.md 的目录，或包含多个技能子目录的目录；默认 skills。保留附带脚本和参考文件，立即启用，不覆盖同名技能。完成后用 skill_list 和 read 验证。不要写安装脚本或往 Bash 的临时 HOME、Claude/Codex 目录复制。',
      parameters: Type.Object(
        {
          path: Type.Optional(Type.String({ maxLength: 500 })),
          projectId: Type.Optional(Type.String({ maxLength: 50 })),
        },
        { additionalProperties: false },
      ),
      async execute(_id, p, signal) {
        const result = await install(
          p.projectId || process.env.ASTRAL_PROJECT_ID,
          p.path || 'skills',
          signal,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: { installedCount: result.installed.length },
          isError: result.errors.length > 0,
        };
      },
    });
  }
}
