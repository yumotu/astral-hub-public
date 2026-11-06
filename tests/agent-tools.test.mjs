import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSkillStore } from '../deploy/pi/skill-store.mjs';
import { validCommand, sandboxArgs } from '../deploy/pi/bash-sandbox.mjs';
import { createCollector } from '../deploy/pi/protocol.mjs';
const definition = {
  name: 'review-code',
  description: '代码检查',
  instructions: '读取项目，运行检查，报告结果。',
  enabled: true,
};
test('model truncation and provider errors retain their actual stop reason without replaying tools', () => {
  const collector = createCollector();
  collector.push(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'length', content: [{ type: 'thinking', thinking: 'still thinking' }] } }) + '\n');
  assert.equal(collector.result().stopReason, 'length');
  assert.equal(collector.result().failed, true);
  collector.push(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: 'provider 429 throttled', content: [] } }) + '\n');
  assert.equal(collector.result().errorMessage, 'provider 429 throttled');
  collector.push(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'recovered by native retry' }] } }) + '\n');
  assert.equal(collector.result().failed, false);
  assert.equal(collector.result().output, 'recovered by native retry');
});
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'astral-agent-tools-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test('agent-created standard skills persist, reject collisions, and respect disabling and links', async (t) => {
  const dir = await fixture(t),
    store = createSkillStore(join(dir, 'skills'));
  const saved = await store.save(definition, { createOnly: true });
  assert.match(await readFile(saved.path, 'utf8'), /^---\nname: review-code\ndescription:/);
  assert.equal((await createSkillStore(join(dir, 'skills')).list())[0].name, 'review-code');
  assert.match(await store.read(saved.path), /运行检查/);
  await assert.rejects(
    () => store.save({ ...definition, instructions: 'overwrite' }, { createOnly: true }),
    { status: 409 },
  );
  assert.match(await store.read(saved.path), /运行检查/);
  await store.save({ ...definition, enabled: false });
  await assert.rejects(() => store.read(saved.path), { status: 403 });
  await store.save(definition);
  await writeFile(join(dir, 'outside.md'), 'secret');
  await symlink(join(dir, 'outside.md'), join(dir, 'skills', 'review-code', 'escape.md'));
  await assert.rejects(() => store.read(join(dir, 'skills', 'review-code', 'escape.md')), {
    status: 403,
  });
  await assert.rejects(() => store.save({ ...definition, name: '../escape' }), { status: 400 });
  const two = await Promise.all([
    store.save({ ...definition, name: 'one' }),
    store.save({ ...definition, name: 'two' }),
  ]);
  assert.equal(two.length, 2);
  assert.equal((await store.list()).length, 3);
});
test('bash sandbox binds only its supplied scope, hides credentials and locks read-only grants', async (t) => {
  const dir = await fixture(t),
    root = join(dir, 'project'),
    grant = join(dir, 'grant');
  await mkdir(root);
  await mkdir(grant);
  await writeFile(join(root, '.env'), 'KEY=hidden');
  await mkdir(join(root, 'private'));
  await writeFile(join(root, 'script.py'), 'print(42)');
  const command = "printf '%s\\n' '$(touch should-not-run)'";
  const args = await sandboxArgs(
    [
      { id: 'main', root, readOnly: false },
      { id: 'grant', root: grant, readOnly: true },
    ],
    root,
    command,
  );
  assert.equal(args.at(-1), command);
  assert.ok(args.includes('--unshare-all'));
  assert.ok(args.includes('--clearenv'));
  assert.equal(args[args.indexOf(root) - 1], '--bind');
  assert.equal(args[args.indexOf(grant) - 1], '--ro-bind');
  assert.ok(args.includes(join(root, '.env')));
  assert.ok(args.includes(join(root, 'private')));
  assert.equal(args.includes(process.env.DEEPSEEK_API_KEY || 'not-present'), false);
  await assert.rejects(() => sandboxArgs([{ root, readOnly: true }], root, 'pwd'), /智能体模式/);
  for (const timeout of [0, -1, 301, Infinity]) assert.throws(() => validCommand('pwd', timeout));
  assert.throws(() => validCommand(''));
  assert.throws(() => validCommand('a\0b'));
  assert.equal(validCommand('pwd'), 120);
});
test('chat skill management edits, disables, removes and restores without losing resources or overwriting stale changes', async (t) => {
  const dir = await fixture(t),
    store = createSkillStore(join(dir, 'skills'));
  await store.save(definition, {
    createOnly: true,
    resources: [{ path: 'scripts/check.py', data: Buffer.from('print(42)'), mode: 0o700 }],
    frontmatter: { license: 'MIT' },
  });
  const first = await store.manage({ name: definition.name, action: 'inspect' });
  assert.equal(first.instructions, definition.instructions);
  assert.equal(first.markdown, undefined);
  const updated = await store.manage({
    name: definition.name,
    action: 'update',
    revision: first.revision,
    instructions: '先读取项目，再执行检查。',
  });
  await assert.rejects(
    () => store.manage({ name: definition.name, action: 'disable', revision: first.revision }),
    { status: 409 },
  );
  await assert.rejects(() => store.manage({ name: definition.name, action: 'disable' }), {
    status: 409,
  });
  const disabled = await store.manage({
    name: definition.name,
    action: 'disable',
    revision: updated.revision,
  });
  await assert.rejects(() => store.read(disabled.path), { status: 403 });
  assert.deepEqual(await store.mounts(), []);
  const removed = await store.manage({
    name: definition.name,
    action: 'remove',
    revision: disabled.revision,
  });
  assert.equal(removed.archived, true);
  await assert.rejects(
    () => store.manage({ name: definition.name, action: 'enable', revision: removed.revision }),
    { status: 409 },
  );
  const restored = await store.manage({
    name: definition.name,
    action: 'restore',
    revision: removed.revision,
  });
  assert.equal(restored.archived, false);
  assert.equal(restored.enabled, false);
  const enabled = await store.manage({
    name: definition.name,
    action: 'enable',
    revision: restored.revision,
  });
  assert.match(await store.read(enabled.path), /先读取项目/);
  assert.match(await readFile(enabled.path, 'utf8'), /MIT/);
  assert.equal(
    await readFile(join(dir, 'skills', definition.name, 'scripts/check.py'), 'utf8'),
    'print(42)',
  );
  assert.equal((await createSkillStore(join(dir, 'skills')).list())[0].enabled, true);
  await assert.rejects(() => store.manage({ name: '../outside', action: 'inspect' }), {
    status: 400,
  });
  const outcomes = await Promise.allSettled([
    store.manage({
      name: definition.name,
      action: 'update',
      revision: enabled.revision,
      description: '变更一',
    }),
    store.manage({
      name: definition.name,
      action: 'update',
      revision: enabled.revision,
      description: '变更二',
    }),
  ]);
  assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find((r) => r.status === 'rejected').reason.status, 409);
});
test('approved host commands retain their command, exit code and result in history', () => {
  const collector = createCollector({ projectMode: true });
  collector.push(
    [
      {
        type: 'tool_execution_start',
        toolName: 'host_command',
        toolCallId: 'host1',
        args: { command: 'id -u' },
      },
      {
        type: 'tool_execution_end',
        toolName: 'host_command',
        toolCallId: 'host1',
        result: { content: [{ type: 'text', text: '0\n' }], details: { exitCode: 0 } },
      },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\n',
  );
  const [tool] = collector.result().tools;
  assert.equal(tool.command, 'id -u');
  assert.equal(tool.output, '0\n');
  assert.equal(tool.exitCode, 0);
});
test('bash transcript keeps command, exit code and bounded redacted output without losing skill logs', () => {
  const collector = createCollector({ projectMode: true });
  const events = [
    {
      type: 'tool_execution_start',
      toolName: 'bash',
      toolCallId: 'bash1',
      args: { command: 'node check.mjs' },
    },
    {
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId: 'bash1',
      isError: true,
      result: {
        content: [
          { type: 'text', text: 'x'.repeat(13000) + ' sk-' + 'z'.repeat(40) },
        ],
        structuredContent: { exit_code: 2 },
      },
    },
    {
      type: 'tool_execution_start',
      toolName: 'skill_create',
      toolCallId: 'skill1',
      args: { name: 'review-code' },
    },
    {
      type: 'tool_execution_end',
      toolName: 'skill_create',
      toolCallId: 'skill1',
      result: { details: { skillName: 'review-code' } },
    },
  ];
  collector.push(events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const tools = collector.result().tools;
  assert.equal(tools[0].command, 'node check.mjs');
  assert.equal(tools[0].exitCode, 2);
  assert.equal(tools[0].status, 'error');
  assert.ok(tools[0].output.length <= 12000);
  assert.match(tools[0].output, /密钥已隐藏/);
  assert.equal(tools[1].path, 'review-code/SKILL.md');
});
