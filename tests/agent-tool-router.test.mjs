import test from 'node:test';
import assert from 'node:assert/strict';
import { agentToolDefinitions, createAgentToolRouter } from '../shared/agent-tool-router.mjs';

const now = () => Date.parse('2026-11-22T00:00:00.000Z');

function router(overrides = {}) {
  return createAgentToolRouter({
    now,
    grant: {
      accountId: 'account-1',
      conversationId: 'conversation-1',
      projectId: 'project-1',
      runtime: 'DPH',
      level: 'L1',
      allowedDomains: ['mail', 'learning', 'investment', 'remote'],
      ...overrides,
    },
  });
}

test('P3 read and draft tools route to synthetic results across all four domains', () => {
  const tools = router();
  for (const name of ['mail.read', 'learning.list_lessons', 'investment.read_holdings', 'remote.list_projects']) {
    const result = tools.call({ tool: name, operationId: `read:${name}` });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'completed');
    assert.equal(result.mode, 'synthetic');
  }
  const draft = tools.call({ tool: 'mail.draft_reply', operationId: 'draft-1' });
  assert.equal(draft.status, 'completed');
  assert.equal(draft.result.send, false);
  assert.equal(tools.inspect().readOnly, true);
});

test('P3 validates unknown, expired and mismatched grants', () => {
  assert.throws(() => createAgentToolRouter(), /explicit grant/);
  assert.throws(() => router({ runtime: 'unknown' }), /unsupported grant runtime/);
  assert.equal(router({ expiresAt: '2026-11-21T23:59:00.000Z' }).call({ tool: 'mail.read' }).code, 'grant_expired');
  assert.equal(router().call({ tool: 'mail.read', context: { conversationId: 'other-conversation' } }).code, 'context_mismatch');
  assert.equal(router({ allowedDomains: ['mail'] }).call({ tool: 'investment.read_holdings' }).code, 'domain_denied');
  assert.equal(router().call({ tool: 'not-a-tool' }).code, 'unknown_tool');
});

test('P3 higher-risk tools are permission gated and never execute', () => {
  const low = router();
  assert.equal(low.call({ tool: 'investment.order_commit' }).code, 'permission_denied');
  assert.equal(low.call({ tool: 'remote.execute' }).code, 'permission_denied');
  const high = router({ level: 'L4' });
  const order = high.call({ tool: 'investment.order_commit', args: { order: { symbol: '000001', quantity: 100 } } });
  assert.equal(order.status, 'needs_confirmation');
  assert.equal(order.result.submitted, false);
  assert.equal(high.call({ tool: 'remote.execute' }).status, 'needs_confirmation');
});

test('P3 operation IDs are idempotent and call limits are enforced', () => {
  const tools = router({ maxCalls: 1 });
  const first = tools.call({ tool: 'mail.read', operationId: 'same-operation' });
  const repeated = tools.call({ tool: 'mail.read', operationId: 'same-operation' });
  assert.deepEqual(repeated, first);
  assert.equal(tools.call({ tool: 'mail.search' }).code, 'call_limit');
  assert.ok(Object.hasOwn(agentToolDefinitions, 'remote.run_preview'));
});
