import { fork } from 'node:child_process';
import { localEnvironment, terminateTree } from './process-tree.mjs';

// Keep ConPTY's native worker threads in a per-terminal process. In node-pty
// 1.1.0 the bundled DLL can retain a worker after onExit; it must not retain
// the whole device agent or prevent graceful shutdown.
export function spawnWindowsPty(shell, args, options) {
  return new Promise((resolve, reject) => {
    const child = fork(new URL('./terminal-worker.mjs', import.meta.url), [], {
      env: localEnvironment(),
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    let ready = false,
      ended = false,
      closing = false,
      force,
      exitEvent,
      dataListener,
      exitListener;
    const buffered = [];
    const finish = (exitCode) => {
      if (ended) return;
      ended = true;
      clearTimeout(force);
      clearTimeout(startup);
      exitEvent = { exitCode };
      exitListener?.(exitEvent);
    };
    const kill = () => {
      if (closing || ended) return;
      closing = true;
      try {
        child.send({ type: 'close' }, () => {});
      } catch {}
      force = setTimeout(() => terminateTree(child, true), 700);
      force.unref();
    };
    const startup = setTimeout(() => {
      kill();
      reject(Error('Windows终端启动超时。'));
    }, 10000);
    startup.unref();
    const result = {
      get pid() {
        return child.pid;
      },
      write(data) {
        if (!closing && !ended) child.send({ type: 'input', data }, () => {});
      },
      resize(cols, rows) {
        if (!closing && !ended) child.send({ type: 'resize', cols, rows }, () => {});
      },
      kill,
      onData(callback) {
        dataListener = callback;
        for (const text of buffered.splice(0)) callback(text);
        return {
          dispose() {
            dataListener = undefined;
          },
        };
      },
      onExit(callback) {
        exitListener = callback;
        if (exitEvent) callback(exitEvent);
        return {
          dispose() {
            exitListener = undefined;
          },
        };
      },
    };
    child.on('message', (m) => {
      if (m?.type === 'ready') {
        ready = true;
        clearTimeout(startup);
        resolve(result);
      }
      if (m?.type === 'data' && typeof m.data === 'string') {
        if (dataListener) dataListener(m.data);
        else buffered.push(m.data);
      }
      if (m?.type === 'error') {
        if (!ready) {
          kill();
          reject(Error('Windows终端组件启动失败，请运行 npm run terminal:setup。'));
        }
      }
      // Complete only when the worker actually exits, not at its native onExit.
      if (m?.type === 'exit') exitEvent = { exitCode: m.exitCode };
    });
    child.once('error', () => {
      clearTimeout(startup);
      reject(Error('Windows终端工作进程启动失败。'));
      finish(1);
    });
    child.once('exit', (code) => {
      if (!ready) reject(Error('Windows终端在启动时退出。'));
      finish(exitEvent?.exitCode ?? null);
    });
    child.send(
      {
        type: 'open',
        shell,
        args,
        options: { cwd: options.cwd, cols: options.cols, rows: options.rows },
      },
      () => {},
    );
  });
}
