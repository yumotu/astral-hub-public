import { createSyntheticAgentEvents } from '../shared/agent-workbench.mjs';
import { createPersonalAgentStore } from '../shared/personal-agent-core.mjs';
import { createAgentToolRouter } from '../shared/agent-tool-router.mjs';

const now = '2026-11-22T00:00:00.000Z';
const store = createPersonalAgentStore({ ownerId: 'demo-owner', clock: () => Date.parse(now), events: createSyntheticAgentEvents({ now }) });
store.createGoal({ goalId: 'demo-goal-p0', title: '验证个人长程 Agent 生命周期', conversationId: 'demo-conversation-1', engine: 'DPH' }, 'demo-create-goal');
store.createTask({ taskId: 'demo-task-p0', title: '检查合成事件快照', goalId: 'demo-goal-p0', conversationId: 'demo-conversation-1', engine: 'DPH' }, 'demo-create-task');
store.startRun({ runId: 'demo-run-p0', taskId: 'demo-task-p0', conversationId: 'demo-conversation-1', engine: 'DPH' }, 'demo-start-run');
store.reportRun({ runId: 'demo-run-p0', taskId: 'demo-task-p0', progress: 35, report: '快照读取完成' }, 'demo-report-run');
store.createAttention({ attentionId: 'demo-attention-p0', title: '确认演示验收', question: '是否结束本次演示？' }, 'demo-create-attention');

const snapshot = store.snapshot();
const router = createAgentToolRouter({
  now: () => Date.parse(now),
  grant: {
    accountId: 'demo-account',
    conversationId: 'demo-conversation-1',
    projectId: 'demo-project',
    runtime: 'DPH',
    level: 'L1',
    allowedDomains: ['mail', 'learning', 'investment', 'remote'],
  },
});
const toolResults = ['mail.read', 'learning.list_lessons', 'investment.read_holdings', 'remote.list_projects', 'remote.execute'].map((tool, index) => router.call({ tool, operationId: `demo-tool-${index}` }));
console.log(JSON.stringify({
  mode: snapshot.mode,
  readOnly: snapshot.readOnly,
  eventCount: snapshot.eventCount,
  goals: snapshot.goals,
  tasks: snapshot.tasks,
  runs: snapshot.runs,
  attentions: snapshot.attentions,
  toolRouter: {
    mode: router.inspect().mode,
    readOnly: router.inspect().readOnly,
    permissions: router.inspect().grant.level,
    results: toolResults.map((result) => ({ tool: result.tool, status: result.status, code: result.code })),
  },
}, null, 2));
