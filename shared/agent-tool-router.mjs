// P3 synthetic tool router. This is the single permission boundary used by
// the workbench demo before real mail, learning, investment and Remote
// executors are connected. Every result is synthetic and side-effect free.

export const agentToolPermissionLevels = Object.freeze(['L0', 'L1', 'L2', 'L3', 'L4']);
export const agentToolRuntimes = Object.freeze(['Pi', 'DPH', 'Remote']);

const levelRank = Object.freeze({ L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 });

function text(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be non-empty text`);
  }
  return value.trim();
}

function optionalText(value, field) {
  return value === undefined || value === null ? undefined : text(value, field);
}

function clone(value) {
  return structuredClone(value);
}

function definition(domain, name, permission, effect, description, result) {
  return Object.freeze({ domain, name, permission, effect, description, result });
}

export const agentToolDefinitions = Object.freeze({
  'mail.read': definition('mail', 'mail.read', 'L0', 'read', '读取合成邮件摘要', { items: [{ id: 'demo-mail-1', subject: 'AI 面试预约确认', status: '待确认' }], source: 'synthetic-mailbox' }),
  'mail.search': definition('mail', 'mail.search', 'L0', 'read', '搜索合成邮件', { query: '', count: 3, source: 'synthetic-mailbox' }),
  'mail.draft_reply': definition('mail', 'mail.draft_reply', 'L1', 'draft', '生成回复草稿，不发送邮件', { subject: '关于面试时间的确认', body: '您好，感谢来信。我会在确认时间后及时回复。', send: false }),
  'mail.send': definition('mail', 'mail.send', 'L3', 'external', '发送邮件，需要用户确认', { send: false, confirmationRequired: true }),
  'learning.list_lessons': definition('learning', 'learning.list_lessons', 'L0', 'read', '读取合成学习内容', { lessons: [{ id: 'lesson-rag-1', title: 'RAG 检索底座', progress: 0.64 }], source: 'synthetic-learning' }),
  'learning.generate_lesson': definition('learning', 'learning.generate_lesson', 'L1', 'draft', '生成学习讲解和练习草稿', { title: '合成学习讲解', explanation: '从概念、例子和反例逐步说明。', questions: 3, saved: false }),
  'learning.grade_attempt': definition('learning', 'learning.grade_attempt', 'L1', 'draft', '判定合成练习答案并给出反馈', { score: 0.8, feedback: '答案抓住了主要概念，可补充一个反例。', saved: false }),
  'learning.update_wrong_book': definition('learning', 'learning.update_wrong_book', 'L2', 'reversible', '更新错题本，需要可撤销写权限', { updated: false, confirmationRequired: true }),
  'investment.read_holdings': definition('investment', 'investment.read_holdings', 'L0', 'read', '读取合成持仓快照', { holdings: [{ symbol: '000001', name: '演示指数基金', value: 6800, dayGain: 42.5 }], asOf: 'synthetic-now', source: 'synthetic-portfolio' }),
  'investment.refresh_quotes': definition('investment', 'investment.refresh_quotes', 'L0', 'read', '刷新合成行情快照', { refreshed: true, symbols: 5, source: 'synthetic-market' }),
  'investment.recommendations': definition('investment', 'investment.recommendations', 'L1', 'draft', '生成合成研究建议，不执行交易', { recommendations: [{ symbol: '000001', action: '观察', reason: '示例波动处于风险阈值内' }], disclaimer: '仅为演示数据，不构成投资建议' }),
  'investment.order_preview': definition('investment', 'investment.order_preview', 'L1', 'draft', '生成买卖订单预览，不提交交易', { order: { symbol: '000001', side: 'buy', quantity: 100 }, submitted: false }),
  'investment.order_commit': definition('investment', 'investment.order_commit', 'L4', 'external', '提交真实交易，需要最高权限和再次确认', { submitted: false, confirmationRequired: true }),
  'remote.list_projects': definition('remote', 'remote.list_projects', 'L0', 'read', '读取合成远程项目目录', { projects: [{ id: 'remote-project-1', name: '演示项目', path: '/workspace/demo' }], source: 'synthetic-remote' }),
  'remote.read_file': definition('remote', 'remote.read_file', 'L0', 'read', '读取合成远程文件', { path: '/workspace/demo/README.md', content: '# Demo project\n', source: 'synthetic-remote' }),
  'remote.run_preview': definition('remote', 'remote.run_preview', 'L1', 'draft', '预览远程命令，不执行', { command: 'npm test', cwd: '/workspace/demo', executed: false }),
  'remote.execute': definition('remote', 'remote.execute', 'L4', 'external', '执行远程命令，需要最高权限和再次确认', { executed: false, confirmationRequired: true }),
});

export const agentToolDomains = Object.freeze(['mail', 'learning', 'investment', 'remote']);

const defaultDatasets = Object.freeze({
  mail: Object.freeze({ messageCount: 3 }),
  learning: Object.freeze({ lessonCount: 1 }),
  investment: Object.freeze({ holdingCount: 5 }),
  remote: Object.freeze({ projectCount: 1 }),
});

function normalizeGrant(grant) {
  if (!grant || typeof grant !== 'object') throw new TypeError('tool router requires an explicit grant');
  const accountId = text(grant.accountId || 'demo-account', 'grant.accountId');
  const conversationId = text(grant.conversationId || 'demo-conversation', 'grant.conversationId');
  const projectId = text(grant.projectId || 'demo-project', 'grant.projectId');
  const runtime = text(grant.runtime || 'DPH', 'grant.runtime');
  if (!agentToolRuntimes.includes(runtime)) throw new TypeError(`unsupported grant runtime: ${runtime}`);
  const level = grant.level || 'L0';
  if (!Object.hasOwn(levelRank, level)) throw new TypeError('grant.level must be L0, L1, L2, L3 or L4');
  const allowedDomains = grant.allowedDomains ? [...new Set(grant.allowedDomains.map((value) => text(value, 'grant.allowedDomains')))] : [...agentToolDomains];
  for (const domain of allowedDomains) if (!agentToolDomains.includes(domain)) throw new TypeError(`unsupported grant domain: ${domain}`);
  const expiresAt = grant.expiresAt === undefined ? undefined : new Date(grant.expiresAt).toISOString();
  if (expiresAt && Number.isNaN(Date.parse(expiresAt))) throw new TypeError('grant.expiresAt must be an ISO date');
  const maxCalls = grant.maxCalls === undefined ? undefined : Math.max(1, Math.floor(Number(grant.maxCalls)));
  if (grant.maxCalls !== undefined && !Number.isFinite(maxCalls)) throw new TypeError('grant.maxCalls must be a positive number');
  return Object.freeze({ accountId, conversationId, projectId, runtime, level, allowedDomains: Object.freeze(allowedDomains), ...(expiresAt ? { expiresAt } : {}), ...(maxCalls ? { maxCalls } : {}) });
}

function contextMatches(grant, context) {
  for (const field of ['accountId', 'conversationId', 'projectId', 'runtime']) {
    if (context[field] !== undefined && context[field] !== grant[field]) return `${field} does not match the grant`;
  }
  return null;
}

function syntheticResult(tool, args, datasets) {
  const definitionValue = agentToolDefinitions[tool];
  const result = clone(definitionValue.result);
  if (tool === 'mail.search') result.query = typeof args.query === 'string' ? args.query : '';
  if (tool === 'remote.run_preview' || tool === 'remote.execute') {
    if (typeof args.command === 'string' && args.command.trim()) result.command = args.command.trim();
    if (typeof args.cwd === 'string' && args.cwd.trim()) result.cwd = args.cwd.trim();
  }
  if (tool === 'investment.order_preview' || tool === 'investment.order_commit') {
    result.order = { ...result.order, ...(args.order && typeof args.order === 'object' ? clone(args.order) : {}) };
  }
  result.dataset = datasets[definitionValue.domain] || 'synthetic';
  return result;
}

/**
 * @param {{ grant?: Record<string, unknown>, now?: () => number, datasets?: Record<string, unknown> }} options
 */
export function createAgentToolRouter({ grant, now = Date.now, datasets = defaultDatasets } = {}) {
  const normalizedGrant = normalizeGrant(grant);
  const calls = new Map();
  let callCount = 0;

  function inspect() {
    return Object.freeze({
      mode: 'synthetic',
      readOnly: true,
      grant: clone(normalizedGrant),
      callCount,
      tools: Object.values(agentToolDefinitions).map((item) => ({ name: item.name, domain: item.domain, permission: item.permission, effect: item.effect, description: item.description })),
    });
  }

  function validation(tool, context = {}) {
    const item = agentToolDefinitions[tool];
    if (!item) return { ok: false, code: 'unknown_tool', reason: `unknown tool: ${tool}` };
    if (!normalizedGrant.allowedDomains.includes(item.domain)) return { ok: false, code: 'domain_denied', reason: `domain is not granted: ${item.domain}`, item };
    const mismatch = contextMatches(normalizedGrant, context);
    if (mismatch) return { ok: false, code: 'context_mismatch', reason: mismatch, item };
    if (normalizedGrant.expiresAt && Date.parse(normalizedGrant.expiresAt) <= Number(now())) return { ok: false, code: 'grant_expired', reason: 'grant has expired', item };
    if (normalizedGrant.maxCalls !== undefined && callCount >= normalizedGrant.maxCalls) return { ok: false, code: 'call_limit', reason: 'grant call limit reached', item };
    if (levelRank[normalizedGrant.level] < levelRank[item.permission]) return { ok: false, code: 'permission_denied', reason: `${item.name} requires ${item.permission}`, item };
    return { ok: true, item };
  }

  function canCall(tool, context = {}) {
    const result = validation(tool, context);
    return { allowed: result.ok, ...(result.item ? { permission: result.item.permission, domain: result.item.domain } : {}), ...(result.ok ? {} : { code: result.code, reason: result.reason }) };
  }

  function call(input = {}, operationId) {
    const tool = text(input.tool || input.name, 'tool');
    const op = optionalText(operationId || input.operationId, 'operationId');
    if (op && calls.has(op)) return clone(calls.get(op));
    const validationResult = validation(tool, input.context || {});
    const base = { mode: 'synthetic', readOnly: true, tool, ...(validationResult.item ? { domain: validationResult.item.domain, permission: validationResult.item.permission } : {}) };
    let result;
    if (!validationResult.ok) result = { ...base, ok: false, status: 'rejected', code: validationResult.code, reason: validationResult.reason };
    else if (validationResult.item.effect === 'external') result = { ...base, ok: true, status: 'needs_confirmation', confirmationRequired: true, result: syntheticResult(tool, input.args || {}, datasets) };
    else result = { ...base, ok: true, status: 'completed', result: syntheticResult(tool, input.args || {}, datasets) };
    if (op) calls.set(op, clone(result));
    callCount += 1;
    return clone(result);
  }

  return Object.freeze({ inspect, canCall, call, snapshot: inspect });
}
