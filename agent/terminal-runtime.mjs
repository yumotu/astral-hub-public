import { createRequire } from 'node:module';
import { join } from 'node:path';
import { checkGrant } from './workspace.mjs';
import { localEnvironment } from './process-tree.mjs';
import { spawnWindowsPty } from './windows-pty.mjs';
export function createComputerTerminals({ projects, pty, now = Date.now }) {
  const sessions = new Map(),
    require = createRequire(import.meta.url);
  let closed = false;
  function flush(s) {
    clearTimeout(s.outputTimer);
    s.outputTimer = null;
    const data = s.pending;
    s.pending = '';
    for (let start = 0; start < data.length;) {
      let end = Math.min(data.length, start + 8192);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
      const text = data.slice(start, end);
      s.chunks.push({ seq: ++s.seq, data: text });
      s.bytes += Buffer.byteLength(text);
      start = end;
    }
    while (s.bytes > 524288 && s.chunks.length > 1)
      s.bytes -= Buffer.byteLength(s.chunks.shift().data);
  }
  const kill = (s) => {
    if (s.closed) return;
    s.closed = true;
    s.closedAt = now();
    try {
      s.pty.kill();
    } catch {}
    s.force = setTimeout(() => {
      if (!s.exited)
        try {
          s.pty.kill('SIGKILL');
        } catch {}
    }, 700);
  };
  const sweep = setInterval(() => {
    for (const s of sessions.values())
      if (!s.closed && (now() - s.lastInput > 15 * 60000 || now() - s.created > 8 * 3600000))
        kill(s);
  }, 1000);
  sweep.unref();
  function snapshot(s, maxBytes) {
    const available = s.chunks.filter((c) => c.seq > s.ack);
    let bytes = 0;
    const chunks = [];
    for (const c of available) {
      if (chunks.length >= 128) break;
      const size = Buffer.byteLength(JSON.stringify(c));
      if (chunks.length && bytes + size > maxBytes) break;
      if (!chunks.length && size > maxBytes) break;
      bytes += size;
      chunks.push(c);
    }
    const delivered = chunks.at(-1)?.seq || s.ack;
    return {
      id: s.id,
      closed: s.closed && delivered >= s.seq,
      exitCode: s.exitCode ?? null,
      chunks,
      reset: !!chunks.length && chunks[0].seq > s.ack + 1,
    };
  }
  return {
    get active() {
      return [...sessions.values()].some((s) => !s.closed);
    },
    async handle(op, grant) {
      if (closed) throw Error('本机终端已停止。');
      await checkGrant(grant);
      if (!grant.allowExecute) throw Error('本机没有授权终端执行。');
      if (op.kind === 'terminal_open') {
        if (now() - op.issuedAt > 45000) throw Error('终端启动请求已过期，未自动重开。');
        if (sessions.has(op.sessionId)) return { id: op.sessionId };
        if ([...sessions.values()].filter((s) => !s.closed).length >= 12)
          throw Error('本机终端已满。');
        for (const [id, s] of sessions) if (s.closed && sessions.size >= 24) sessions.delete(id);
        let runtime = pty;
        if (!runtime && process.platform !== 'win32')
          try {
            runtime = require('node-pty');
          } catch {
            throw Error(
              '本机终端组件未就绪，请在执行器目录运行 npm run terminal:setup，再重新启动执行器。',
            );
          }
        const win = process.platform === 'win32',
          shell = win
            ? join(
                process.env.SystemRoot || 'C:\\Windows',
                'System32',
                'WindowsPowerShell',
                'v1.0',
                'powershell.exe',
              )
            : process.platform === 'darwin'
              ? '/bin/zsh'
              : '/bin/bash';
        let child;
        try {
          child = await (win ? spawnWindowsPty : (...args) => runtime.spawn(...args))(
            shell,
            win
              ? ['-NoLogo', '-NoProfile']
              : process.platform === 'darwin'
                ? ['-f', '-i']
                : ['--noprofile', '--norc', '-i'],
            {
              name: 'xterm-256color',
              cwd: grant.root,
              cols: op.cols,
              rows: op.rows,
              env: { ...localEnvironment(), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
              useConpty: true,
              // The bundled ConPTY avoids node-pty 1.1.0's built-in-console
              // enumeration race on shutdown (microsoft/node-pty#952).
              useConptyDll: win,
            },
          );
        } catch {
          throw Error('本机终端启动失败，请运行 npm run terminal:setup 并核对Shell是否可用。');
        }
        const s = {
          id: op.sessionId,
          projectId: grant.id,
          grant,
          pty: child,
          created: now(),
          lastInput: now(),
          closed: false,
          exited: false,
          chunks: [],
          pending: '',
          outputTimer: null,
          seq: 0,
          ack: 0,
          bytes: 0,
          exitCode: null,
          force: null,
        };
        sessions.set(s.id, s);
        s.exit = new Promise((resolve) => {
          child.onExit(({ exitCode }) => {
            flush(s);
            s.closed = true;
            s.exited = true;
            s.closedAt = now();
            s.exitCode = exitCode;
            clearTimeout(s.force);
            resolve();
          });
        });
        child.onData((data) => {
          s.pending += data;
          if (s.pending.length >= 8192) flush(s);
          else if (!s.outputTimer)
            s.outputTimer = setTimeout(() => {
              s.outputTimer = null;
              flush(s);
            }, 15);
        });
        return { id: s.id };
      }
      const s = sessions.get(op.sessionId);
      if (!s || s.projectId !== grant.id) throw Error('本机终端不存在或已因重启结束，未自动重开。');
      if (grant.root !== s.grant.root || grant.ino !== s.grant.ino || grant.dev !== s.grant.dev) {
        kill(s);
        throw Error('本机授权目录已变化，终端已关闭。');
      }
      if (op.kind === 'terminal_close') {
        kill(s);
        return { id: s.id, closed: true };
      }
      if (s.closed) throw Error('本机终端已经关闭，输入未执行。');
      if (op.kind === 'terminal_input') {
        if (now() - op.issuedAt > 10000) throw Error('终端输入已过期，未在重连后重发。');
        s.lastInput = now();
        s.pty.write(op.data);
        return { id: s.id, accepted: true };
      }
      if (op.kind === 'terminal_resize') {
        s.pty.resize(op.cols, op.rows);
        return { id: s.id };
      }
      throw Error('不支持此终端操作。');
    },
    snapshots() {
      let budget = 600000;
      const result = [];
      for (const s of sessions.values()) {
        flush(s);
        s.outputTimer = null;
        const item = snapshot(s, Math.max(0, budget));
        budget -= Buffer.byteLength(JSON.stringify(item));
        result.push(item);
      }
      return result;
    },
    acknowledge(result) {
      for (const [id, ack] of Object.entries(result.acks || {})) {
        const s = sessions.get(id);
        if (s && Number.isSafeInteger(ack)) s.ack = Math.max(s.ack, Math.min(ack, s.seq));
      }
      for (const id of result.close || []) {
        const s = sessions.get(id);
        if (s) kill(s);
      }
    },
    async revoke() {
      for (const s of sessions.values())
        if (!s.closed) {
          try {
            const p = await checkGrant(projects().find((p) => p.id === s.projectId));
            if (
              !p.allowExecute ||
              p.root !== s.grant.root ||
              p.ino !== s.grant.ino ||
              p.dev !== s.grant.dev
            )
              kill(s);
          } catch {
            kill(s);
          }
        }
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(sweep);
      for (const s of sessions.values()) kill(s);
      await Promise.all(
        [...sessions.values()].map((s) =>
          Promise.race([s.exit, new Promise((r) => setTimeout(r, 1500))]),
        ),
      );
    },
  };
}
