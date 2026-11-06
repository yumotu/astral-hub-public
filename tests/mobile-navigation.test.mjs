import test from 'node:test';
import assert from 'node:assert/strict';
import {
  swipePanel,
  swipeStartPanel,
  panelDrag,
  gestureRange,
} from '../shared/mobile-navigation.mjs';
const swipe = (patch = {}) =>
  swipePanel({
    panel: null,
    width: 375,
    startX: 22,
    startY: 100,
    endX: 85,
    endY: 103,
    duration: 150,
    conversationsAvailable: true,
    ...patch,
  });
test('phone edge gestures open opposite panels and an inward gesture closes each', () => {
  assert.equal(swipe(), 'workspace');
  assert.equal(swipe({ startX: 353, endX: 250 }), 'conversations');
  assert.equal(swipe({ panel: 'workspace', startX: 210, endX: 100 }), null);
  assert.equal(swipe({ panel: 'conversations', startX: 100, endX: 220 }), null);
  assert.equal(swipe({ panel: 'workspace' }), 'workspace');
});
test('vertical scrolling, text selection, editing, slow or short gestures never open a panel', () => {
  for (const patch of [
    { endY: 210 },
    { blocked: true },
    { duration: 900 },
    { endX: 20 },
    { startX: 100, endX: 210 },
    { width: 1200 },
  ])
    assert.equal(swipe(patch), null, JSON.stringify(patch));
  assert.equal(swipe({ width: 800 }), null);
  assert.equal(swipe({ startX: 353, endX: 250, conversationsAvailable: false }), null);
  assert.equal(swipe({ startX: 180, endX: 80, fromHeader: true }), 'conversations');
});
test('gesture range leaves the OS edge free and is configurable or disabled', () => {
  const start = (startX, range = 40) =>
    swipeStartPanel({
      panel: null,
      width: 375,
      startX,
      conversationsAvailable: true,
      range,
    });
  assert.equal(start(0), null);
  assert.equal(start(15), null);
  assert.equal(start(16), 'workspace');
  assert.equal(start(56), 'workspace');
  assert.equal(start(57), null);
  assert.equal(start(319), 'conversations');
  assert.equal(start(359), 'conversations');
  assert.equal(start(360), null);
  assert.equal(start(70, 64), 'workspace');
  assert.equal(start(22, 0), null);
  assert.equal(gestureRange('64'), 64);
  assert.equal(gestureRange('bad'), 40);
  assert.equal(gestureRange(-1), 40);
});
test('drag progress clamps to panel bounds and supports cancel or close', () => {
  const partial = panelDrag({ panel: 'workspace', open: false, dx: 70, size: 240 });
  assert.equal(partial.offset, -170);
  assert.ok(Math.abs(partial.progress - 70 / 240) < 1e-12);
  assert.deepEqual(panelDrag({ panel: 'conversations', open: true, dx: 400, size: 310 }), {
    offset: 310,
    progress: 0,
  });
  assert.deepEqual(panelDrag({ panel: 'workspace', open: true, dx: 50, size: 240 }), {
    offset: 0,
    progress: 1,
  });
  assert.equal(swipe({ startX: 0 }), null);
  assert.equal(swipe({ range: 0 }), null);
});

test('assistant content opens either drawer from its center while preserving gesture exclusions', () => {
  assert.equal(swipe({ fromConversation: true, startX: 180, endX: 280 }), 'workspace');
  assert.equal(swipe({ fromConversation: true, startX: 180, endX: 80 }), 'conversations');
  assert.equal(swipe({ fromConversation: true, startX: 30, endX: 100 }), 'workspace');
  for (const patch of [
    { range: 0 },
    { blocked: true },
    { endY: 250 },
    { startX: 2 },
    { startX: 370 },
    { duration: 900 },
    { width: 1200 },
  ])
    assert.equal(swipe({ fromConversation: true, startX: 180, endX: 280, ...patch }), null);
  assert.equal(
    swipe({ fromConversation: true, startX: 180, endX: 80, conversationsAvailable: false }),
    null,
  );
  assert.equal(swipe({ fromConversation: true, width: 800, startX: 300, endX: 400 }), null);
  assert.equal(
    swipe({ fromConversation: true, width: 800, startX: 300, endX: 200 }),
    'conversations',
  );
});
