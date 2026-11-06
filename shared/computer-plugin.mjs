// Declarative computer plugins compose registered tools. No source code, eval,
// package installation, absolute file access or additional privileges are added.
export const computerPluginTools = {
  computer_info: {},
  project_list: { path: '.' },
  project_stat: { path: 'README.md' },
  project_tree: { path: '.', depth: 2 },
  project_read: { path: 'README.md', limit: 100 },
  project_read_many: { paths: ['README.md'] },
  project_search: { query: '{{input}}', path: '.' },
  project_write: { path: 'note.md', content: '{{input}}', expectedHash: 'new' },
  project_edit: {
    path: 'note.md',
    oldText: 'old',
    newText: '{{input}}',
    expectedHash: '{{step0.sha256}}',
  },
  project_mkdir: { path: '{{input}}' },
  project_diff: { backupId: '{{input}}' },
  project_restore: { backupId: '{{input}}' },
  chat_export: { path: '{{input}}' },
  computer_exec: { command: 'node --version', timeout: 10000 },
};
const writes = new Set(['project_write', 'project_edit', 'project_mkdir', 'project_restore']);
export const pluginPermissions = (plugin) => ({
  write: plugin.steps.some((s) => writes.has(s.tool)),
  execute: plugin.steps.some((s) => s.tool === 'computer_exec'),
});
const plain = (v) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
function keys(value, allowed) {
  if (!plain(value) || Object.keys(value).some((k) => !allowed.includes(k)))
    throw Error('插件字段不正确。');
}
function text(value, min, max) {
  return typeof value === 'string' && value.trim().length >= min && value.length <= max;
}
function safeJSON(value, depth = 0) {
  if (depth > 6) throw Error('插件参数嵌套过深。');
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return;
  if (typeof value === 'string') {
    if (value.length > 32000) throw Error('插件参数过长。');
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 32) throw Error('插件参数列表过长。');
    for (const v of value) safeJSON(v, depth + 1);
    return;
  }
  if (!plain(value) || Object.keys(value).length > 20) throw Error('插件参数不正确。');
  for (const [k, v] of Object.entries(value)) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(k) ||
      ['constructor', 'prototype', '__proto__'].includes(k)
    )
      throw Error('插件参数名称不正确。');
    safeJSON(v, depth + 1);
  }
}
export function parseComputerPlugin(value) {
  keys(value, ['version', 'id', 'name', 'description', 'inputLabel', 'steps']);
  if (
    value.version !== 1 ||
    !/^[a-z][a-z0-9_]{2,31}$/.test(value.id || '') ||
    !text(value.name, 1, 40) ||
    !text(value.description, 1, 300) ||
    !text(value.inputLabel, 1, 80) ||
    !Array.isArray(value.steps) ||
    value.steps.length < 1 ||
    value.steps.length > 12
  )
    throw Error('电脑插件清单不完整，最多12步，编号使用3到32位小写字母、数字或下划线。');
  for (let i = 0; i < value.steps.length; i++) {
    const s = value.steps[i];
    keys(s, ['tool', 'arguments']);
    if (!Object.hasOwn(computerPluginTools, s.tool) || !plain(s.arguments))
      throw Error('插件只能调用列出的电脑工具。');
    safeJSON(s.arguments);
    for (const ref of JSON.stringify(s.arguments).matchAll(/\{\{([^{}]+)\}\}/g)) {
      if (ref[1] === 'input') continue;
      const m = ref[1].match(/^step(\d+)\.([a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)*)$/);
      if (
        !m ||
        Number(m[1]) >= i ||
        m[2].split('.').some((k) => ['constructor', 'prototype', '__proto__'].includes(k))
      )
        throw Error('插件只能引用input或前面步骤的结果。');
    }
  }
  if (JSON.stringify(value).length > 60000) throw Error('插件清单过大。');
  return structuredClone(value);
}
export function pluginArguments(value, input, results) {
  const resolve = (ref) => {
    if (ref === 'input') return input;
    const m = ref.match(/^step(\d+)\.(.+)$/);
    let value = m && results[Number(m[1])];
    for (const part of m?.[2].split('.') || []) {
      if (!value || !Object.hasOwn(value, part))
        throw Error('前面步骤没有提供插件所需字段：' + ref);
      value = value[part];
    }
    return value;
  };
  function expand(v) {
    if (typeof v === 'string') {
      const whole = v.match(/^\{\{([^{}]+)\}\}$/);
      if (whole) return structuredClone(resolve(whole[1]));
      return v.replace(/\{\{([^{}]+)\}\}/g, (_s, ref) => {
        const x = resolve(ref);
        return typeof x === 'string' ? x : JSON.stringify(x);
      });
    }
    if (Array.isArray(v)) return v.map(expand);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]));
    return v;
  }
  const args = expand(value);
  safeJSON(args);
  return args;
}
