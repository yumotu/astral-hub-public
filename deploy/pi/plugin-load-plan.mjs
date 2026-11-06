import { terminalNotifier } from './notification-protocol.mjs';

// A single resource plan is shared by real turns and activation probes. Managed
// adapters own their tool names; installing the upstream package cannot load it twice.
export function pluginLoadPlan(resources = {}, { owner = false, cronRoot, coreOnly = false } = {}) {
  const extensions = [
    'skill-tools',
    'chat-tools',
    'web-tools',
    'notification-tools',
    'goal-tools',
    'mail-tools',
    'app-tools',
    'ask-user',
    'long-goal',
  ].map((name) => `/bridge/${name}.mjs`);
  const warnings = [],
    adapted = [];
  if (owner) extensions.push('/bridge/host-tools.mjs', '/bridge/package-tools.mjs');
  if (owner && !coreOnly)
    for (const path of resources.extensions || []) {
      const normalized = path.replaceAll('\\', '/');
      if (normalized.includes('/node_modules/pi-goal/')) {
        adapted.push('pi-goal');
        continue;
      }
      if (/\/node_modules\/pi-web-access\//.test(normalized)) {
        adapted.push('pi-web-access');
        continue;
      }
      if (terminalNotifier(normalized)) {
        warnings.push('终端通知插件由星屿通知接口适配，使用 /notify 或 notify 工具。');
        continue;
      }
      if (normalized.includes('/node_modules/@patimweb/pi-cron/')) {
        if (cronRoot) extensions.push('/bridge/cron-tools.mjs');
        adapted.push('@patimweb/pi-cron');
        continue;
      }
      extensions.push(path);
    }
  const unique = (values) => [...new Set(values || [])];
  return {
    extensions: unique(extensions),
    warnings: unique(warnings),
    adapted: unique(adapted),
    ...Object.fromEntries(
      ['skills', 'prompts', 'themes'].map((kind) => [
        kind,
        owner && !coreOnly ? unique(resources[kind]) : [],
      ]),
    ),
  };
}
