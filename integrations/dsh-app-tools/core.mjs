// No SDK import here: the host adapter below registers these exact handlers.
// Native human-command input is deliberately omitted from the session log.
import { createFileTools } from './files.mjs';
export function createAppToolsPlugin({ endpoint, workspaceRoot, request = fetch, now = Date.now }) {
  const base = new URL(endpoint);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/api/agent/dsh/app-access' ||
    (base.protocol !== 'https:' &&
      !(base.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(base.hostname)))
  )
    throw Error('请配置固定的星屿HTTPS软件工具入口。');
  const sessions = new Map();
  const session = (id) => {
    let s = sessions.get(id);
    if (!s) {
      for (const [key, value] of sessions) {
        for (const [requestId, grant] of value.grants)
          if (grant.expiresAt <= now()) value.grants.delete(requestId);
        if (!value.grants.size) sessions.delete(key);
      }
      if (sessions.size >= 256) throw Error('正在授权的软件会话较多，请结束部分任务后重试。');
      sessions.set(id, (s = { grants: new Map(), current: null, turn: null }));
    }
    return s;
  };
  async function call(g, command, signal) {
    signal?.throwIfAborted();
    const timeout = command.name === 'attachments.read' ? 150000 : 60000;
    const response = await request(base, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + g.token },
      body: JSON.stringify({
        taskId: g.taskId,
        sessionId: g.sessionId,
        requestId: g.requestId,
        command,
      }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw Error('星屿软件工具请求被拒绝或结果待核对；勿重放未知操作。');
    const text = await response.text();
    if (Buffer.byteLength(text) > 1000000) throw Error('星屿软件工具结果过大。');
    const result = JSON.parse(text);
    if (command.action !== 'bind') g.expiresAt = now() + 16 * 60000;
    return result;
  }
  const grant = (exec, expected) => {
    const s = sessions.get(exec.agent?.id), g = expected || s?.current;
    exec.signal?.throwIfAborted();
    if (!g || !s?.grants.has(g.requestId) || g.expiresAt <= now()) throw Error('当前星屿任务未启用软件工具，或授权已结束。请从星屿发送新任务。');
    return g;
  };
  const file = createFileTools({ endpoint: base.href, workspaceRoot, grant, call, request });
  return {
    file,
    async bind({ agent, rawInput, signal }) {
      let p;
      try {
        p = JSON.parse(rawInput.trim());
        if (
          !p ||
          Object.keys(p).sort().join(',') !==
            'endpoint,expiresAt,nonce,requestId,taskId,token,version' ||
          p.version !== 1 ||
          p.endpoint !== base.href ||
          !/^[a-f0-9]{64}$/.test(p.token) ||
          !/^[a-f0-9]{48}$/.test(p.nonce) ||
          !/^[0-9a-f-]{36}$/.test(p.taskId) ||
          p.requestId !== p.taskId ||
          !Number.isSafeInteger(p.expiresAt) ||
          p.expiresAt <= now() ||
          p.expiresAt > now() + 17 * 60000 ||
          !agent?.id
        )
          throw Error();
        const g = { ...p, sessionId: agent.id, turn: null };
        const proof = await call(g, { action: 'bind', nonce: p.nonce }, signal);
        if (
          proof.version !== 1 ||
          proof.taskId !== p.taskId ||
          proof.sessionId !== agent.id ||
          proof.nonce !== p.nonce
        )
          throw Error();
        const s = session(agent.id);
        if (s.grants.size >= 64 || s.grants.has(p.requestId)) throw Error();
        s.grants.set(p.requestId, g);
        return { kind: 'success', text: JSON.stringify({ ...proof, fileBridgeVersion: workspaceRoot ? 1 : 0 }) };
      } catch {
        return { kind: 'error', text: '星屿软件工具绑定失败；请在星屿重新核对授权。' };
      }
    },
    observe(nativeSession, event) {
      const s = sessions.get(nativeSession.id);
      if (!s) return;
      if (event.type === 'turn/start') {
        s.turn = event.data.turn;
        s.current = null;
      } else if (event.type === 'user/message' && event.data.source?.kind === 'user') {
        // An unrelated native UI prompt cannot inherit the preceding human's
        // account capability, even in the same native session.
        s.current = s.grants.get(event.data.source.rpcId) || null;
        if (s.current) s.current.turn = event.data.turn ?? s.turn;
      } else if (event.type === 'turn/end') {
        for (const [id, g] of s.grants) if (g.turn === event.data.turn) s.grants.delete(id);
        s.current = null;
      }
      for (const [id, g] of s.grants) if (g.expiresAt <= now()) s.grants.delete(id);
      if (!s.grants.size) sessions.delete(nativeSession.id);
    },
    async execute(args, exec) {
      const s = sessions.get(exec.agent?.id),
        g = s?.current;
      if (!g || !s.grants.has(g.requestId) || g.expiresAt <= now())
        throw Error('当前星屿任务未启用软件工具，或授权已结束。请从星屿发送新任务。');
      if (
        !args ||
        Array.isArray(args) ||
        typeof args !== 'object' ||
        Object.keys(args).some(
          (k) => !['action', 'name', 'input', 'id', 'callId', 'query'].includes(k),
        )
      )
        throw Error('软件工具参数无效。');
      const command = { ...args };
      if (command.action === 'invoke') command.callId = command.callId || exec.callId;
      const result = await call(g, command, exec.signal);
      g.expiresAt = now() + 16 * 60000;
      if (result?.state !== 'prepared') return result;
      // Keep the native tool open while the real account holder confirms the
      // frozen preview in Astral. No model can confirm or deny it itself.
      for (;;) {
        await new Promise((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(Error('任务已取消。'));
          };
          const timer = setTimeout(() => {
            exec.signal?.removeEventListener('abort', abort);
            resolve();
          }, 1200);
          if (exec.signal?.aborted) abort();
          else exec.signal?.addEventListener('abort', abort, { once: true });
        });
        if (!s.grants.has(g.requestId)) throw Error('任务授权已结束。');
        const next = await call(g, { action: 'status', id: result.id }, exec.signal);
        g.expiresAt = now() + 16 * 60000;
        if (next?.state !== 'prepared') return next;
      }
    },
    dispose() {
      sessions.clear();
    },
  };
}
