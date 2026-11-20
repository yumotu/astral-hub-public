import test from 'node:test';
import assert from 'node:assert/strict';
import { mobileViewport } from '../shared/mobile-viewport.mjs';
test('overlay keyboards reduce the viewport and account for browser panning', () => {
  assert.deepEqual(
    mobileViewport({
      layoutHeight: 812,
      visualHeight: 420,
      visualTop: 12,
      baselineHeight: 812,
      focused: true,
    }),
    { height: 420, top: 12, keyboard: true },
  );
});
test('native resized WebViews do not subtract the keyboard twice', () => {
  assert.deepEqual(
    mobileViewport({
      layoutHeight: 380,
      visualHeight: 380,
      baselineHeight: 812,
      focused: true,
      nativeKeyboard: true,
    }),
    { height: 380, top: 0, keyboard: true },
  );
  assert.equal(
    mobileViewport({
      layoutHeight: 812,
      visualHeight: 812,
      baselineHeight: 812,
      focused: true,
      nativeKeyboard: false,
    }).keyboard,
    false,
  );
});
test('address bars, invalid metrics and pinch zoom do not masquerade as a keyboard', () => {
  assert.equal(
    mobileViewport({ layoutHeight: 812, visualHeight: 750, baselineHeight: 812, focused: true })
      .keyboard,
    false,
  );
  assert.deepEqual(
    mobileViewport({
      layoutHeight: 812,
      visualHeight: 400,
      visualTop: 12,
      scale: 2,
      baselineHeight: 812,
      focused: true,
    }),
    { height: 812, top: 0, keyboard: false },
  );
  assert.equal(
    mobileViewport({ layoutHeight: 375, visualHeight: 0, baselineHeight: 375, focused: false })
      .height,
    375,
  );
  assert.equal(
    mobileViewport({ layoutHeight: 812, visualHeight: 420, baselineHeight: 812, focused: false })
      .keyboard,
    false,
  );
});
