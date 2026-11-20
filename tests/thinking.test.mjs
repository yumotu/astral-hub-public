import test from 'node:test';
import assert from 'node:assert/strict';
import { configureThinking, resolveThinkingLevel } from '../deploy/pi/thinking.mjs';
test('provider thinking configuration preserves distinct low, high and max efforts and disables off', () => {
  const original = {
    id: 'deepseek-flash',
    samplingParams: { thinking: { type: 'disabled' } },
    compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: false },
  };
  for (const level of ['off', 'low', 'high', 'max']) {
    const model = configureThinking(original, level);
    assert.equal(model.samplingParams.thinking.type, level === 'off' ? 'disabled' : 'enabled');
    assert.equal(model.samplingParams.reasoning_effort, level === 'off' ? 'none' : level);
    assert.equal(model.thinkingLevelMap.max, 'max');
    assert.equal(model.compat.supportsReasoningEffort, true);
  }
  assert.equal(original.compat.supportsReasoningEffort, false);
  assert.equal(original.samplingParams.thinking.type, 'disabled');
  assert.equal(resolveThinkingLevel(undefined, true), 'high');
  assert.equal(resolveThinkingLevel('off', true), 'off');
  assert.throws(
    () => resolveThinkingLevel('ultra'),
    (e) => e.status === 400,
  );
});
