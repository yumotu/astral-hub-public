import { createRequire } from 'node:module';
import { localEnvironment } from './process-tree.mjs';
if (process.platform !== 'win32' || !process.send)
  throw Error('Windows PTY worker requires its device parent.');
let pty,
  opened = false,
  closing = false,
  output = '',
  sending = false,
  finalCode,
  timer;
function flush() {
  if (sending) return;
  if (!output) {
    if (finalCode !== undefined)
      process.send({ type: 'exit', exitCode: finalCode }, () => process.exit(0));
    return;
  }
  let end = Math.min(output.length, 32768);
  if (end < output.length && /[\uD800-\uDBFF]/.test(output[end - 1])) end--;
  const data = output.slice(0, end);
  output = output.slice(data.length);
  sending = true;
  pty?.pause();
  process.send({ type: 'data', data }, () => {
    sending = false;
    pty?.resume();
    flush();
  });
}
function stop() {
  if (closing) return;
  closing = true;
  try {
    pty?.kill();
  } catch {}
  setTimeout(() => process.exit(0), 250).unref();
}
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('message', (m) => {
  try {
    if (m?.type === 'open' && !opened) {
      opened = true;
      const native = createRequire(import.meta.url)('node-pty');
      pty = native.spawn(m.shell, m.args, {
        ...m.options,
        env: { ...localEnvironment(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        name: 'xterm-256color',
        useConpty: true,
        useConptyDll: true,
      });
      pty.onData((data) => {
        output += data;
        clearTimeout(timer);
        if (output.length >= 32768) flush();
        else timer = setTimeout(flush, 8);
      });
      pty.onExit(({ exitCode }) => {
        clearTimeout(timer);
        finalCode = exitCode;
        flush();
      });
      process.send({ type: 'ready' });
    } else if (
      m?.type === 'input' &&
      pty &&
      !closing &&
      typeof m.data === 'string' &&
      m.data.length <= 16384
    )
      pty.write(m.data);
    else if (
      m?.type === 'resize' &&
      pty &&
      !closing &&
      Number.isInteger(m.cols) &&
      Number.isInteger(m.rows)
    )
      pty.resize(m.cols, m.rows);
    else if (m?.type === 'close') stop();
  } catch {
    process.send?.({ type: 'error' }, () => process.exit(1));
  }
});
