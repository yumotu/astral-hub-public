import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
try {
  const loader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.home,
    settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
    additionalExtensionPaths: [
      fileURLToPath(new URL('./computer-tools.mjs', import.meta.url)),
      ...input.roots,
    ],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const result = loader.getExtensions(),
    skills = loader.getSkills();
  if (result.errors.length) throw Error(result.errors.map((e) => e.error).join('\n'));
  const own = result.extensions.filter((e) => input.roots.some((root) => e.path.startsWith(root)));
  const tools = own.flatMap((e) => [...e.tools.keys()]);
  if (tools.some((t) => !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(t)))
    throw Error('插件工具名称不适合远程调用。');
  if (input.roots.length && !own.length && !skills.skills.length)
    throw Error('此包没有可加载的Pi扩展或技能。');
  await writeFile(
    input.output,
    JSON.stringify({
      ready: true,
      tools,
      extensions: own.length,
      skills: skills.skills.map((s) => s.name),
      warnings: [...(result.warnings || []), ...skills.diagnostics]
        .map((d) => (typeof d === 'string' ? d : d.message || d.warning || '资源诊断'))
        .slice(0, 20),
    }),
    { mode: 0o600 },
  );
  process.exit(0);
} catch (e) {
  await writeFile(
    input.output,
    JSON.stringify({ ready: false, error: String(e.message).slice(0, 4000) }),
    { mode: 0o600 },
  );
  process.exit(1);
}
