import {
  SettingsManager,
  DefaultPackageManager,
} from '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

// Resolve only configured packages, without discovering project-local resources or installing missing packages.
export async function packageResources(cwd, agentDir) {
  // Do not let a corrupt settings file or a missing npm installation silently
  // become a successful check of an empty package set.
  let configured = {};
  try {
    configured = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('插件设置无法读取：' + e.message);
  }
  for (const source of configured.packages || []) {
    const name = (typeof source === 'string' ? source : source.source || '').match(
      /^npm:((?:@[^/]+\/)?[^@/]+)(?:@.*)?$/,
    )?.[1];
    if (name)
      try {
        await readFile(join(agentDir, 'npm/node_modules', name, 'package.json'));
      } catch (e) {
        throw new Error(`Failed to load extension package ${name}: ${e.message}`);
      }
  }
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const result = await manager.resolve(async () => 'skip');
  return Object.fromEntries(
    await Promise.all(
      ['extensions', 'skills', 'prompts', 'themes'].map(async (kind) => [
        kind,
        [
          ...new Set(
            await Promise.all(
              (result[kind] || [])
                .filter((item) => item.enabled && item.metadata?.scope !== 'project')
                .map((item) => realpath(item.path)),
            ),
          ),
        ],
      ]),
    ),
  );
}
