import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTodos,
  todoSnapshot,
  latestTodo,
  conversationTodo,
  groupActivities,
  applyRunMetrics,
  metricValues,
  activityTarget,
} from '../shared/pi-activity.mjs';
import { applyPiTimeline, interruptedTools } from '../shared/pi-timeline.mjs';
import { todoResultFields, usageEvent, createCollector } from '../deploy/pi/protocol.mjs';

test('composer todo follows the current conversation and survives cache eviction or a turn without todos', () => {
  const snapshot = (text) => ({
    name: 'todo',
    status: 'done',
    todos: [{ id: '1', text, status: 'pending' }],
  });
  const turns = [
    { createdAt: '2026-11-02T00:00:00Z', tools: [snapshot('最初的清单')] },
    { createdAt: '2026-11-02T01:00:00Z', timeline: [snapshot('最近的清单')] },
    { createdAt: '2026-11-02T02:00:00Z', timeline: [{ kind: 'text', text: '继续对话' }] },
  ];
  const tasks = [
    { conversationId: 'a', createdAt: '2026-11-02T00:00:00Z', tools: [snapshot('旧任务缓存')] },
    { conversationId: 'b', createdAt: '2026-11-02T03:00:00Z', tools: [snapshot('其他对话')] },
    {
      conversationId: 'a',
      parentId: 'parent',
      createdAt: '2026-11-02T04:00:00Z',
      tools: [snapshot('补充回执')],
    },
    { conversationId: 'a', createdAt: '2026-11-02T05:00:00Z', timeline: [] },
  ];
  assert.equal(conversationTodo(turns, tasks, 'a').items[0].text, '最近的清单');
  assert.equal(conversationTodo(turns, [], 'a').items[0].text, '最近的清单');
  assert.equal(conversationTodo([], tasks, 'new'), null);
  assert.equal(conversationTodo([], tasks, 'b').items[0].text, '其他对话');
});
test('composer todo orders delayed tasks by execution time and preserves a successful clear', () => {
  const old = { name: 'todo', status: 'done', todos: [{ text: '旧事项', done: false }] };
  const clear = { name: 'todo', status: 'done', todos: [] };
  const turns = [{ createdAt: '2026-11-02T02:00:00Z', tools: [old] }];
  const task = {
    conversationId: 'a',
    createdAt: '2026-11-02T01:00:00Z',
    startedAt: '2026-11-02T03:00:00Z',
    timeline: [clear],
    tools: [old],
  };
  assert.deepEqual(conversationTodo(turns, [task], 'a').items, []);
  assert.equal(
    conversationTodo(
      turns,
      [{ ...task, timeline: [{ ...clear, status: 'error' }], tools: [] }],
      'a',
    ).items[0].text,
    '旧事项',
  );
  const saved = {
    createdAt: '2026-11-02T04:00:00Z',
    execution: { finishedAt: '2026-11-02T04:00:00Z' },
    tools: [clear],
  };
  assert.deepEqual(
    conversationTodo([...turns, saved], [{ ...task, timeline: [old] }], 'a').items,
    [],
  );
});

test('native todo details retain add/toggle/clear snapshots without inventing an active step', () => {
  const result = {
    details: {
      action: 'toggle',
      todos: [
        { id: 1, text: '检查结构', done: true },
        { id: 2, text: '分析问题', done: false },
      ],
    },
  };
  const fields = todoResultFields('todo', result);
  assert.deepEqual(
    fields.todos.map((t) => t.status),
    ['done', 'pending'],
  );
  let timeline = applyPiTimeline([], {
    type: 'tool_start',
    id: 'a',
    name: 'todo',
    arguments: '{"action":"toggle","id":1}',
  });
  timeline = applyPiTimeline(timeline, { type: 'tool_end', id: 'a', ...fields });
  assert.deepEqual(latestTodo(timeline).items, fields.todos);
  assert.deepEqual(todoResultFields('todo', { details: { action: 'clear', todos: [] } }), {
    todos: [],
    todoAction: 'clear',
  });
  assert.equal(todoSnapshot({ name: 'todo', status: 'done', todos: [] }).length, 0);
  assert.equal(todoSnapshot({ name: 'todo', status: 'error', todos: fields.todos }), null);
  assert.equal(todoSnapshot({ name: 'todo', status: 'running', todos: fields.todos }), null);
  assert.deepEqual(todoResultFields('project_read', result), {});
  assert.deepEqual(
    todoResultFields('todo', { details: { ...result.details, error: 'rejected' } }),
    {},
  );
});
test('legacy todo histories parse actual checkboxes and safe tool targets only', () => {
  const legacy = { name: 'todo', status: 'done', output: '[x] #1: 检查结构\n[ ] #2: 分析问题' };
  assert.deepEqual(
    todoSnapshot(legacy).map((t) => t.status),
    ['done', 'pending'],
  );
  assert.equal(todoSnapshot({ name: 'project_read', status: 'done', output: legacy.output }), null);
  assert.equal(
    todoSnapshot({ name: 'todo', status: 'done', output: 'Added todo #1: 检查结构' }),
    null,
  );
  assert.equal(todoSnapshot({ name: 'todo', status: 'done', output: 'No todos' }).length, 0);
  assert.equal(normalizeTodos([{ text: '未知状态', status: 'nonsense' }]), null);
  assert.equal(
    normalizeTodos(Array.from({ length: 300 }, (_, id) => ({ id, text: 'a', done: false }))).length,
    100,
  );
  assert.equal(activityTarget({ arguments: '{"url":"javascript:alert(1)"}' }).url, undefined);
  assert.equal(normalizeTodos([{ text: 'Invalid', status: 'constructor' }]), null);
  assert.equal(activityTarget({ arguments: 'null' }).url, undefined);
  assert.equal(
    activityTarget({ arguments: '{"url":"https://user:pass@example.com"}' }).url,
    undefined,
  );
  assert.equal(
    activityTarget({ arguments: '{"url":"https://example.com/docs"}' }).url,
    'https://example.com/docs',
  );
});
test('activity groups preserve narration order and the thinking visibility preference', () => {
  const items = [
    { kind: 'text', text: '先检查' },
    { kind: 'thinking', text: '比较方案' },
    { kind: 'tool', name: 'read' },
    { kind: 'tool', name: 'todo' },
    { kind: 'text', text: '再修改' },
    { kind: 'tool', name: 'edit' },
    { kind: 'text', text: '完成' },
  ];
  const groups = groupActivities(items, true);
  assert.deepEqual(
    groups.map((g) => g.kind),
    ['text', 'process', 'text', 'process', 'text'],
  );
  assert.equal(groups[1].items.length, 3);
  assert.equal(groupActivities(items, false)[1].items.length, 2);
  assert.equal(
    groupActivities(items, false).some((g) => g.items?.some((i) => i.kind === 'thinking')),
    false,
  );
});
test('usage telemetry sums provider counters and model time without estimating missing tokens', () => {
  let m = applyRunMetrics(undefined, { type: 'response_start' });
  m = applyRunMetrics(m, { type: 'tool_start' });
  m = applyRunMetrics(
    m,
    usageEvent({ input: 100, output: 20, cacheRead: 900, cacheWrite: 0, secret: 'ignored' }, 2000),
  );
  m = applyRunMetrics(
    m,
    usageEvent({ input: 200, output: 40, cacheRead: 800, cacheWrite: 0 }, 1000),
  );
  assert.deepEqual(m, {
    modelTurns: 1,
    toolCalls: 1,
    input: 300,
    output: 60,
    cacheRead: 1700,
    cacheWrite: 0,
    responseMs: 3000,
  });
  assert.deepEqual(metricValues(m), { totalTokens: 2060, tokensPerSecond: 20, cacheHit: 85 });
  assert.equal(metricValues({ modelTurns: 1 }).totalTokens, undefined);
  assert.equal(metricValues({ output: 0 }).tokensPerSecond, undefined);
  assert.equal(usageEvent({ input: -1, output: Infinity, cacheRead: '999' }, 1000), null);
  assert.deepEqual(usageEvent({ output: 0 }, undefined), { type: 'usage', usage: { output: 0 } });
  assert.deepEqual(
    applyRunMetrics(m, { type: 'usage', usage: { input: -1, output: '100' }, responseMs: NaN }),
    m,
  );
});
test('native collector keeps bounded structured todo details and raw actions for historical replay', () => {
  const collector = createCollector({ projectMode: true });
  collector.push(
    JSON.stringify({
      type: 'tool_execution_start',
      toolName: 'todo',
      toolCallId: 'x',
      args: { action: 'add', text: '检查项目' },
    }) + '\n',
  );
  collector.push(
    JSON.stringify({
      type: 'tool_execution_end',
      toolName: 'todo',
      toolCallId: 'x',
      result: {
        content: [{ type: 'text', text: 'Added todo #1: 检查项目' }],
        details: {
          action: 'add',
          todos: [{ id: 1, text: '检查项目', done: false }],
          privateKey: 'must-not-forward',
        },
      },
    }) + '\n',
  );
  const [tool] = collector.result().tools;
  assert.equal(tool.todos[0].text, '检查项目');
  assert.equal(tool.arguments, '{"action":"add","text":"检查项目"}');
  assert.equal(tool.output, 'Added todo #1: 检查项目');
  assert.equal(JSON.stringify(tool).includes('must-not-forward'), false);
});

test('interrupted package mutations retain progress and report unknown outcome in both snapshots', () => {
  const task = {
    tools: [
      {
        id: 'install',
        name: 'package_manage',
        status: 'running',
        output: 'Installing npm:example…',
      },
      { id: 'list', status: 'done', output: '10 packages' },
    ],
    timeline: [
      { kind: 'text', text: '安装前检查' },
      {
        kind: 'tool',
        id: 'install',
        name: 'package_manage',
        status: 'running',
        output: 'Installing npm:example…',
      },
    ],
  };
  const frozen = structuredClone(task);
  const result = interruptedTools(task, '执行进程退出 143；需 list/check 核验，禁止直接重放安装。');
  assert.equal(result.tools[0].status, 'error');
  assert.match(result.tools[0].summary, /结果待核验/);
  assert.match(result.tools[0].output, /Installing[\s\S]*143/);
  assert.deepEqual(result.tools[1], task.tools[1]);
  assert.deepEqual(result.timeline[0], task.timeline[0]);
  assert.equal(result.timeline[1].summary, result.tools[0].summary);
  assert.deepEqual(task, frozen);
  assert.deepEqual(interruptedTools(result), result);
});
