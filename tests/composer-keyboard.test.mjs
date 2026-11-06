import test from 'node:test';
import assert from 'node:assert/strict';
import { historyComposerEnter, editorComposerEnter } from '../web/src/composer-keyboard.ts';

function fixture() {
  const body = { closest: () => null },
    root = {},
    history = { contains: (target) => target?.history === true };
  const button = { disabled: false },
    submitted = [],
    overlays = [];
  const doc = {
    body,
    documentElement: root,
    visibilityState: 'visible',
    querySelectorAll: () => overlays,
  };
  let focused = 0;
  const form = {
    querySelector: (selector) => (selector.includes('pi-command-menu') ? null : button),
    requestSubmit: (target) => submitted.push(target),
  };
  const area = {
    isConnected: true,
    disabled: false,
    readOnly: false,
    closest: () => null,
    getClientRects: () => [{}],
    ownerDocument: doc,
    form,
    focus: () => focused++,
  };
  const event = (patch = {}) => ({
    key: 'Enter',
    target: body,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...patch,
  });
  return { area, history, doc, button, form, overlays, submitted, event, focused: () => focused };
}

test('history Enter uses the live guarded submit button exactly once and restores editor focus', () => {
  const f = fixture(),
    event = f.event({ target: { history: true, closest: () => null } });
  assert.equal(historyComposerEnter(event, f.area, f.history), true);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(f.submitted, [f.button]);
  assert.equal(f.focused(), 1);
  assert.equal(historyComposerEnter(event, f.area, f.history), false);
  assert.equal(f.submitted.length, 1);
  f.button.disabled = true;
  assert.equal(historyComposerEnter(f.event(), f.area, f.history), true);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.focused(), 2);
  f.area.form = null; // An empty running composer has Stop, never submit or stop it.
  assert.equal(historyComposerEnter(f.event(), f.area, f.history), true);
  assert.equal(f.submitted.length, 1);
});

test('IME confirmation, held Enter, line breaks and modified keys cannot trigger history submission', () => {
  const f = fixture();
  for (const patch of [
    { isComposing: true },
    { keyCode: 229 },
    { repeat: true },
    { shiftKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { key: ' ' },
    { defaultPrevented: true },
  ])
    assert.equal(historyComposerEnter(f.event(patch), f.area, f.history), false);
  assert.equal(f.focused(), 0);
  assert.deepEqual(f.submitted, []);
});

test('history Enter cannot bypass an unavailable but focusable send action', () => {
  const f = fixture();
  f.button.getAttribute = (name) => (name === 'aria-disabled' ? 'true' : null);
  assert.equal(historyComposerEnter(f.event(), f.area, f.history), true);
  assert.equal(f.submitted.length, 0);
});

test('temporary history submits its own form while blocking the underlying main conversation and nested dialogs', () => {
  const f = fixture();
  const scope = { closest: () => null, getClientRects: () => [{}], contains: () => false };
  f.overlays.push(scope);
  const event = f.event();
  assert.equal(historyComposerEnter(event, f.area, f.history), false);
  f.area.closest = (selector) => (selector === '[data-composer-scope]' ? scope : null);
  assert.equal(historyComposerEnter(event, f.area, f.history), true);
  assert.deepEqual(f.submitted, [f.button]);
  f.overlays.push({ closest: () => null, getClientRects: () => [{}], contains: () => false });
  assert.equal(historyComposerEnter(f.event(), f.area, f.history), false);
});

test('all composer editors share Enter submission without IME, repeated or modified sends', () => {
  let submissions = 0;
  const key = (patch = {}) => ({
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    defaultPrevented: false,
    nativeEvent: { isComposing: false, keyCode: 13 },
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...patch,
  });
  const submit = () => {
    submissions++;
  };
  assert.equal(editorComposerEnter(key(), submit), true);
  assert.equal(submissions, 1);
  for (const patch of [
    { shiftKey: true },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { defaultPrevented: true },
    { key: 'a' },
    { nativeEvent: { isComposing: true, keyCode: 13 } },
    { nativeEvent: { isComposing: false, keyCode: 229 } },
  ]) {
    assert.equal(editorComposerEnter(key(patch), submit), false);
  }
  assert.equal(editorComposerEnter(key({ repeat: true }), submit), true);
  assert.equal(submissions, 1);
});

test('other controls, hidden chats, overlays and command completion retain their own keyboard handling', () => {
  const f = fixture();
  assert.equal(
    historyComposerEnter(
      f.event({ target: { history: true, closest: () => ({}) } }),
      f.area,
      f.history,
    ),
    false,
  );
  assert.equal(
    historyComposerEnter(f.event({ target: { closest: () => null } }), f.area, f.history),
    false,
  );
  f.area.closest = () => ({});
  assert.equal(historyComposerEnter(f.event(), f.area, f.history), false);
  f.area.closest = () => null;
  f.overlays.push({ closest: () => null, getClientRects: () => [{}] });
  assert.equal(historyComposerEnter(f.event(), f.area, f.history), false);
  f.overlays.length = 0;
  f.area.disabled = true;
  assert.equal(historyComposerEnter(f.event(), f.area, f.history), false);
  f.area.disabled = false;
  f.doc.visibilityState = 'hidden';
  assert.equal(historyComposerEnter(f.event(), f.area, f.history), false);
  f.doc.visibilityState = 'visible';
  f.form.querySelector = () => ({});
  assert.equal(historyComposerEnter(f.event(), f.area, f.history), true);
  assert.equal(f.focused(), 1);
  assert.deepEqual(f.submitted, []);
});
