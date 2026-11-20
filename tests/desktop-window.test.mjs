import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { createWindowControls, registerWindowControls } = createRequire(import.meta.url)(
  '../desktop/window-controls.cjs',
);
function fixture(platform = 'darwin') {
  const window = new EventEmitter(),
    sent = [],
    calls = [];
  let full = true;
  Object.assign(window, {
    isDestroyed: () => false,
    isFullScreen: () => full,
    webContents: { send: (...args) => sent.push(args) },
    setFullScreen: (value) => {
      calls.push('leave');
      setImmediate(() => {
        full = value;
        window.emit('leave-full-screen');
      });
    },
    minimize: () => calls.push('minimize'),
    close: () => calls.push('close'),
  });
  return { window, sent, calls, controls: createWindowControls(window, platform) };
}
test('Mac full screen controls wait for the native transition before minimizing and publish the actual state', async () => {
  const f = fixture();
  assert.equal(f.controls.status().fullScreen, true);
  const pending = f.controls.action('minimize');
  assert.deepEqual(f.calls, ['leave']);
  await assert.rejects(f.controls.action('close'), /切换/);
  await pending;
  assert.deepEqual(f.calls, ['leave', 'minimize']);
  assert.equal(f.sent[0][1].fullScreen, false);
  await f.controls.action('close');
  assert.equal(f.calls.at(-1), 'close');
  f.window.emit('closed');
  assert.equal(f.window.listenerCount('enter-full-screen'), 0);
});
test('window actions reject arbitrary commands and other platforms without affecting a window', async () => {
  const f = fixture();
  await assert.rejects(f.controls.action('execute'), /不支持/);
  const win = fixture('win32');
  await assert.rejects(win.controls.action('close'), /不支持/);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(win.calls, []);
});

test('native IPC accepts only the currently trusted app renderer and cannot select another window', async () => {
  const handlers = new Map(),
    f = fixture(),
    owner = {};
  registerWindowControls(
    { handle: (name, handler) => handlers.set(name, handler) },
    { current: () => f.controls, trusted: (e) => e === owner },
  );
  assert.equal(handlers.get('astral:window:status')({}), null);
  assert.throws(() => handlers.get('astral:window:action')({}, 'close'), /不可用/);
  assert.deepEqual(f.calls, []);
  await handlers.get('astral:window:action')(owner, 'exit-fullscreen');
  assert.equal(handlers.get('astral:window:status')(owner).fullScreen, false);
});
