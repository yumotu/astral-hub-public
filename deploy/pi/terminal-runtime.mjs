import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { realpath, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const fail = (status, message) => Object.assign(new Error(message), { status });
export function terminalSchema(z) {
  return z
    .object({
      action: z.enum([
        'list',
        'open',
        'read',
        'input',
        'resize',
        'close',
        'command',
        'cancel_command',
      ]),
      ownerId: z.string().uuid(),
      sessionId: z.string().uuid().optional(),
      requestId: z.string().uuid().optional(),
      cwd: z.string().min(1).max(1000).optional(),
      data: z.string().max(16384).optional(),
      command: z.string().trim().min(1).max(8000).optional(),
      timeout: z.number().int().min(1000).max(120000).optional(),
      cols: z.number().int().min(20).max(300).optional(),
      rows: z.number().int().min(5).max(100).optional(),
      after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    })
    .strict();
}
export async function createTerminalRuntime({
  target = 'pi',
  pty,
  now = Date.now,
  defaultCwd,
  homeRoot,
  agentDir,
} = {}) {
  if (!pty) {
    const require = createRequire(import.meta.url);
    pty = require(process.env.ASTRAL_TERMINAL_PTY || '/extensions/node_modules/node-pty');
  }
  const sessions = new Map(),
    commands = new Map(),
    activeCommands = new Map();
  let closed = false;
  function session(owner, id) {
    const found = sessions.get(id);
    if (!found || found.owner !== owner) throw fail(404, '终端会话不存在或已过期。');
    return found;
  }
  function view(s) {
    return {
      id: s.id,
      target,
      cwd: s.cwd,
      createdAt: s.createdAt,
      closed: s.closed,
      exitCode: s.exitCode ?? null,
    };
  }
  async function environment(owner) {
    const home = target === 'server' ? '/root' : join(homeRoot, owner, 'home');
    await mkdir(home, { recursive: true, mode: 0o700 });
    return {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: home,
      LANG: 'C.UTF-8',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      PS1: target === 'server' ? '主机·root:\\w# ' : 'Pi:\\w$ ',
      ...(agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {}),
      // No API keys, bridge credentials, parent process environment or startup files.
    };
  }
  const timer = setInterval(() => {
    for (const [id, s] of sessions) {
      if (now() - s.lastInput > 15 * 60000 || now() - s.created > 8 * 3600000) {
        if (!s.closed) s.pty.kill();
        s.closed = true;
        s.events.emit('data');
      }
      if (s.closed && now() - s.lastInput > 30 * 60000) sessions.delete(id);
    }
  }, 30000);
  timer.unref();
  return {
    async handle(p) {
      if (closed) throw fail(503, '终端服务正在关闭。');
      if (p.action === 'list')
        return { sessions: [...sessions.values()].filter((s) => s.owner === p.ownerId).map(view) };
      if (p.action === 'open') {
        if ([...sessions.values()].filter((s) => s.owner === p.ownerId && !s.closed).length >= 4)
          throw fail(429, '每个账号最多开启 4 个终端，请关闭不再使用的会话。');
        if ([...sessions.values()].filter((s) => !s.closed).length >= 12)
          throw fail(429, '终端数量已达到上限。');
        const cwd = await realpath(p.cwd || defaultCwd).catch(() => {
          throw fail(400, '终端目录不存在。');
        });
        const child = pty.spawn('/bin/bash', ['--noprofile', '--norc', '-i'], {
          name: 'xterm-256color',
          cols: p.cols || 100,
          rows: p.rows || 20,
          cwd,
          env: await environment(p.ownerId),
        });
        const s = {
          id: randomUUID(),
          owner: p.ownerId,
          cwd,
          pty: child,
          created: now(),
          createdAt: new Date(now()).toISOString(),
          lastInput: now(),
          closed: false,
          chunks: [],
          seq: 0,
          bytes: 0,
          events: new EventEmitter(),
        };
        s.events.setMaxListeners(10);
        sessions.set(s.id, s);
        child.onData((data) => {
          if (closed) return;
          s.chunks.push({ seq: ++s.seq, data });
          s.bytes += Buffer.byteLength(data);
          while (s.bytes > 1024 * 1024 && s.chunks.length > 1)
            s.bytes -= Buffer.byteLength(s.chunks.shift().data);
          s.events.emit('data');
        });
        child.onExit(({ exitCode }) => {
          s.closed = true;
          s.exitCode = exitCode;
          s.events.emit('data');
        });
        return view(s);
      }
      if (p.action === 'command') {
        if (!p.requestId || !p.command) throw fail(400, '命令参数不完整。');
        const key = p.ownerId + ':' + p.requestId;
        if (commands.has(key)) throw fail(409, '该命令已经提交；执行结果不明时不会自动重跑。');
        commands.set(key, now());
        if (commands.size > 1000)
          for (const [k, t] of commands) if (now() - t > 86400000) commands.delete(k);
        const cwd = await realpath(p.cwd || defaultCwd).catch(() => {
          throw fail(400, '执行目录不存在。');
        });
        const env = await environment(p.ownerId);
        return new Promise((resolve, reject) => {
          const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', p.command], {
            cwd,
            env,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          activeCommands.set(key, child);
          let output = '',
            truncated = false,
            killed = false;
          const append = (b) => {
            output += b.toString();
            if (Buffer.byteLength(output) > 128 * 1024) {
                output = output.slice(-32000);
              truncated = true;
            }
          };
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', append);
            child.stderr.on('data', append);
          const kill = () => {
            killed = true;
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {}
          };
          const deadline = setTimeout(kill, p.timeout || 60000);
          child.once('error', () => {
            clearTimeout(deadline);
            activeCommands.delete(key);
            reject(fail(502, '命令无法启动。'));
          });
          child.once('close', (code) => {
            clearTimeout(deadline);
            activeCommands.delete(key);
            resolve({ output, exitCode: code, truncated, timedOut: killed, target, cwd });
          });
        });
      }
      if (p.action === 'cancel_command') {
        const child = activeCommands.get(p.ownerId + ':' + p.requestId);
        if (child)
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        return { ok: true };
      }
      const s = session(p.ownerId, p.sessionId);
      if (p.action === 'read') {
        if (s.events.listenerCount('data') >= 4) throw fail(429, '终端连接过多。');
        if (!(s.seq > (p.after || 0)) && !s.closed)
          await new Promise((resolve) => {
            const finish = () => {
              clearTimeout(wait);
              s.events.off('data', finish);
              resolve();
            };
            const wait = setTimeout(finish, 20000);
            s.events.once('data', finish);
          });
        const chunks = s.chunks.filter((c) => c.seq > (p.after || 0)).slice(0, 100);
        return {
          ...view(s),
          chunks,
          cursor: chunks.at(-1)?.seq ?? (p.after || 0),
          reset: !!chunks.length && chunks[0].seq > (p.after || 0) + 1,
        };
      }
      if (p.action === 'close') {
        if (!s.closed) s.pty.kill();
        s.closed = true;
        s.events.emit('data');
        return { ok: true };
      }
      if (s.closed) throw fail(409, '终端已关闭。');
      if (p.action === 'input') {
        s.lastInput = now();
        s.pty.write(p.data || '');
        return { ok: true };
      }
      if (p.action === 'resize') {
        s.pty.resize(p.cols || 100, p.rows || 20);
        return { ok: true };
      }
      throw fail(400, '终端操作不受支持。');
    },
    close() {
      closed = true;
      clearInterval(timer);
      for (const s of sessions.values()) {
        try {
          s.pty.kill();
        } catch {}
        s.events.emit('data');
      }
      for (const child of activeCommands.values())
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
    },
  };
}
