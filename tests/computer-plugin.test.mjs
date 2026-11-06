import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseComputerPlugin,
  pluginArguments,
  pluginPermissions,
} from '../shared/computer-plugin.mjs';
const manifest = {
  version: 1,
  id: 'find_send',
  name: '查找并发送',
  description: '读取文件信息后将原文件发送到当前聊天。',
  inputLabel: '文件相对路径',
  steps: [
    { tool: 'project_stat', arguments: { path: '{{input}}' } },
    { tool: 'chat_export', arguments: { path: '{{step0.path}}' } },
  ],
};
test('computer plugin manifests are strict, declarative, bounded and cannot refer to future or prototype fields', () => {
  assert.deepEqual(parseComputerPlugin(manifest), manifest);
  assert.deepEqual(pluginPermissions(manifest), { write: false, execute: false });
  assert.deepEqual(pluginArguments(manifest.steps[1].arguments, 'x', [{ path: 'image.png' }]), {
    path: 'image.png',
  });
  assert.throws(() => parseComputerPlugin({ ...manifest, source: 'process.exit()' }), /字段/);
  assert.throws(
    () => parseComputerPlugin({ ...manifest, steps: [{ tool: 'eval', arguments: {} }] }),
    /列出/,
  );
  assert.throws(
    () =>
      parseComputerPlugin({
        ...manifest,
        steps: [{ tool: 'project_read', arguments: { path: '{{step1.path}}' } }],
      }),
    /前面步骤/,
  );
  assert.throws(
    () =>
      parseComputerPlugin({
        ...manifest,
        steps: [{ tool: 'project_read', arguments: { path: '{{step0.__proto__}}' } }],
      }),
    /前面步骤/,
  );
  assert.throws(() => pluginArguments({ path: '{{step0.missing}}' }, 'x', [{}]), /没有提供/);
  assert.throws(
    () => parseComputerPlugin({ ...manifest, steps: Array(13).fill(manifest.steps[0]) }),
    /12步/,
  );
});
