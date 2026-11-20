import { readFile } from 'node:fs/promises';
import { createSandboxOperations, validCommand } from './bash-sandbox.mjs';
import { redact } from './project-files.mjs';
import { createSkillStore } from './skill-store.mjs';
import { readSandboxNetwork } from './bash-network.mjs';
import { Type } from 'typebox';
export async function registerBashTools(pi, createBashToolDefinition) {
  const projects = JSON.parse(await readFile(process.env.ASTRAL_PROJECTS_FILE, 'utf8'));
  const selected = projects.find((p) => p.id === process.env.ASTRAL_PROJECT_ID);
  if (!selected || selected.readOnly || process.env.ASTRAL_PROJECT_ACCESS !== 'edit') return;
  pi.registerTool({
    name: 'sandbox_network_status',
    label: 'Bash 联网状态',
    description:
      '读取此对话 Bash 的实际联网授权、有效期和范围。只查询，不能自行批准；联网设置不改变宿主命令审核。',
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const policy = await readSandboxNetwork();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ...policy,
              scope: '当前对话，Pi 容器可达的外部和内部网络；默认关闭',
            }),
          },
        ],
        details: policy,
      };
    },
  });
  const native = createBashToolDefinition(selected.root, {
    operations: createSandboxOperations(projects, selected.root, {
      getSkillMounts: () => createSkillStore(process.env.ASTRAL_SKILLS_ROOT).mounts(),
      getNetworkPolicy: readSandboxNetwork,
      cacheDir: process.env.ASTRAL_BASH_CACHE || undefined,
    }),
    exposeSessionEnvironment: false,
  });
  const scrub = (result) => ({
    ...result,
    content: result.content?.map((c) => (c.type === 'text' ? { ...c, text: redact(c.text) } : c)),
    ...(result.structuredContent
      ? {
          structuredContent: {
            ...result.structuredContent,
            output: redact(result.structuredContent.output),
          },
        }
      : {}),
  });
  pi.registerTool({
    ...native,
    label: 'Bash 命令',
    description:
      '在当前项目的隔离 Bash 中执行命令，返回标准输出、错误与退出码。无每轮命令次数上限，不要仅为重置额度要求用户发送“继续”。仅挂载当前项目及明确授权目录和应用提供的独立缓存，不继承 API 密钥。网络默认关闭，可在当前对话「Bash 联网」经授权开启；每条命令核验，撤销会停止正在联网的命令，不自动重试。HOME和/tmp每次临时，依赖请安装到项目目录（如 .venv、node_modules）；下载/编译缓存使用XDG_CACHE_HOME，按账号、对话及项目隔离并跨命令保留。不要把缓存重定向到项目内data/private等受保护目录，遇到只读错误先核对路径和挂载，不能无证据归因静态链接。支持 Bash、Node、Python、Git、rg、curl。默认超时120秒，最多300秒。命令写入直接生效，不走文件工具的逐文件备份。',
    async execute(id, p, signal, onUpdate, ctx) {
      validCommand(p.command, p.timeout ?? 120);
      try {
        return scrub(
          await native.execute(
            id,
            { ...p, timeout: p.timeout ?? 120 },
            signal,
            onUpdate ? (r) => onUpdate(scrub(r)) : undefined,
            ctx,
          ),
        );
      } catch (e) {
        throw new Error(redact(e.message));
      }
    },
  });
}
export default async function (pi) {
  const { createBashToolDefinition } =
    await import('/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js');
  await registerBashTools(pi, createBashToolDefinition);
}
