import test from 'node:test';
import assert from 'node:assert/strict';
import { runState } from '../shared/run-state.mjs';
test('real task status wins over stale phase and visibly distinguishes execution, waiting and stop', () => {
  assert.equal(runState('running', '已完成').label, '正在执行');
  assert.equal(runState('running', '正在执行工具').state, 'executing');
  assert.equal(runState('running', '等待你的回复').spinning, false);
  assert.equal(runState('stopping', '正在执行工具').label, '正在停止');
  assert.equal(runState('stopping').spinning, true);
  assert.equal(runState('cancelled', '正在执行工具').label, '已停止');
  assert.equal(runState('cancelled').busy, false);
  assert.equal(runState('done', '正在思考').label, '已完成');
  assert.equal(runState('interrupted').state, 'failed');
});
