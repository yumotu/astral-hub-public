import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from './accounts.mjs';
import { dshTerminalInfo, dshTerminalEnvironment } from '../shared/dsh-controls.mjs';

const uuid = z.string().uuid();
const dimensions = {
  cols: z.number().int().min(20).max(300),
  rows: z.number().int().min(5).max(100),
};
const localRejected = (message) => Object.assign(fail(409, message), { localRejected: true });

// Native shells belong to an exact login, connection and immutable conversation.
// There is no generic RPC, raw cwd, shell executable or browser-supplied grant.
export function createDshWorkbench({
  body,
  ensure,
  target,
  row,
  view,
  action,
  active,
  rate,
  now = Date.now,
}) {
  const terminals = new Map();
  let closed = false;
  const key = (owner, conversation, id) => JSON.stringify([owner, conversation, id]);
  function authorize(actor, r) {
    if (closed || !actor.sessionHash || !active(actor))
      throw fail(403, '请重新登录后使用DSH工作台。');
    target(actor.id, row(actor.id, r.id));
  }
  function owned(actor, r, id) {
    authorize(actor, r);
    const entry = terminals.get(key(actor.id, r.id, id));
    if (!entry || entry.login !== actor.sessionHash || entry.revoked)
      throw fail(404, '此终端不属于当前登录，或授权已经结束。请新建终端。');
    entry.touched = now();
    return entry;
  }
  async function dispose(entry) {
    entry.revoked = true;
    entry.control.abort();
    if (entry.cleaning) return entry.cleaning;
    entry.cleaning = (async () => {
      await entry.source?.close().catch(() => {});
      try {
        await entry.chat.terminalClose(entry.session, entry.id);
        entry.cleaned = true;
      } catch {
        /* An unknown close is not reported as a completed process cleanup. */
      }
      if (entry.cleaned) terminals.delete(entry.key);
    })();
    try {
      await entry.cleaning;
    } finally {
      entry.cleaning = null;
    }
  }
  function revoke(owner, conversation) {
    for (const entry of terminals.values())
      if (entry.owner === owner && (!conversation || entry.conversation === conversation))
        void dispose(entry);
  }
  const sweep = setInterval(() => {
    for (const entry of terminals.values()) {
      try {
        if (entry.revoked || now() - entry.touched > 10 * 60 * 1000) throw Error('expired');
        authorize(entry.actor, row(entry.owner, entry.conversation));
      } catch {
        void dispose(entry);
      }
    }
  }, 15000);
  sweep.unref?.();
  async function follow(entry) {
    entry.source = await entry.chat.terminalFollow(
      entry.session,
      entry.id,
      entry.attachment,
      entry.control.signal,
    );
    const iterator = entry.source[Symbol.asyncIterator]();
    const first = await iterator.next();
    consume(entry, first.value);
    if (first.done || first.value?.type !== 'snapshot') throw Error('DSH终端未返回屏幕快照。');
    void (async () => {
      try {
        while (!entry.control.signal.aborted) {
          const next = await iterator.next();
          if (next.done) break;
          consume(entry, next.value);
        }
        if (!entry.revoked && entry.info?.state === 'running')
          entry.error = '终端连接已断开，输入不会自动重放。';
      } catch {
        if (!entry.revoked) entry.error = '终端连接已断开，输入不会自动重放。';
      } finally {
        entry.writable = false;
      }
    })();
  }
  function consume(entry, frame) {
    if (entry.revoked || !frame || JSON.stringify(frame).length > 2 * 1024 * 1024) return;
    if (frame.type === 'snapshot' || frame.type === 'state') {
      entry.info = dshTerminalInfo.parse(frame.info);
      entry.writable =
        frame.info.controllerId === entry.attachment && entry.info.state === 'running';
    }
    if (frame.type === 'snapshot' || frame.type === 'output') {
      const data = frame.type === 'snapshot' ? frame.screen : frame.data;
      if (typeof data !== 'string') throw Error('Invalid terminal output');
      entry.chunks.push({ seq: ++entry.cursor, data });
      entry.bytes += Buffer.byteLength(data);
      while (entry.bytes > 2 * 1024 * 1024 && entry.chunks.length > 1)
        entry.bytes -= Buffer.byteLength(entry.chunks.shift().data);
    }
  }
  function read(entry, cursor = 0) {
    return {
      ...entry.info,
      id: entry.id,
      writable: entry.writable && !entry.error && !entry.revoked,
      chunks: entry.chunks.filter((c) => c.seq > cursor),
      cursor: entry.cursor,
      reset: cursor < (entry.chunks[0]?.seq || 1) - 1,
      error: entry.error || '',
    };
  }
  return {
    revoke,
    connected(owner, connectionId, chat) {
      // A newly authenticated channel can finish closing an old, revoked shell.
      // It never reattaches input or recreates that terminal identity.
      for (const entry of terminals.values())
        if (
          entry.revoked &&
          entry.owner === owner &&
          entry.connection === connectionId &&
          entry.chat !== chat
        ) {
          entry.chat = chat;
          void dispose(entry);
        }
    },
    async handle(req, url, json, actor, r) {
      const base = '/api/agent/remote/conversations/' + r.id;
      const path = url.pathname.slice(base.length);
      if (!/^\/(controls|terminals)(?:\/|$)/.test(path)) return false;
      authorize(actor, r);
      if (path === '/controls') {
        rate(
          actor.id,
          'workbench-controls-' + (req.method === 'GET' ? 'read' : 'write'),
          req.method === 'GET' ? 120 : 60,
        );
        if (req.method === 'GET') {
          const { chat, r: current } = await ensure(actor.id, r.id);
          const controls = await chat.controls(current.session_id);
          authorize(actor, current);
          json(200, { controls });
          return true;
        }
        if (req.method !== 'POST') return false;
        const p = z
          .object({
            id: uuid,
            kind: z.enum(['thinking', 'permission']),
            value: z.string().min(1).max(200),
          })
          .strict()
          .parse(await body(req));
        const { chat, r: current } = await ensure(actor.id, r.id);
        let confirmed;
        const operation = await action(actor.id, r.id, p.id, 'setting-' + p.kind, p, async () => {
          authorize(actor, current);
          confirmed =
            p.kind === 'thinking'
              ? await chat.selectThinking(current.session_id, p.value)
              : await chat.selectPermission(current.session_id, p.value);
          authorize(actor, current);
          return confirmed;
        });
        const controls = await chat.controls(current.session_id);
        authorize(actor, current);
        // Values here are exact native receipts, never optimistic client choices.
        if (confirmed?.model) controls.model = confirmed.model;
        if (confirmed?.permissions) controls.permissions = confirmed.permissions;
        json(200, { operation, controls, conversation: view(row(actor.id, r.id)) });
        return true;
      }
      rate(
        actor.id,
        'workbench-terminal-' + (req.method === 'GET' ? 'read' : 'write'),
        req.method === 'GET' ? 240 : 1200,
      );
      if (path === '/terminals' && req.method === 'GET') {
        json(200, {
          terminals: [...terminals.values()]
            .filter(
              (e) =>
                e.owner === actor.id &&
                e.conversation === r.id &&
                e.login === actor.sessionHash &&
                !e.revoked,
            )
            .map((e) => read(e, e.cursor)),
        });
        return true;
      }
      if (path === '/terminals' && req.method === 'POST') {
        const p = z
          .object({ id: uuid, terminalId: uuid, ...dimensions })
          .strict()
          .parse(await body(req));
        const operation = await action(actor.id, r.id, p.id, 'terminal-create', p, async () => {
          const k = key(actor.id, r.id, p.terminalId);
          if (terminals.has(k)) throw localRejected('终端编号已存在，请刷新终端列表。');
          if (
            terminals.size >= 64 ||
            [...terminals.values()].filter((e) => e.owner === actor.id).length >= 8
          )
            throw localRejected('打开的终端较多，请先关闭不再使用的终端。');
          const { chat, r: current } = await ensure(actor.id, r.id);
          authorize(actor, current);
          const limits = dshTerminalEnvironment.parse(
            await chat.terminalEnvironment(current.session_id),
          );
          authorize(actor, current);
          if (p.cols > limits.maxCols || p.rows > limits.maxRows)
            throw localRejected('终端尺寸超出主机支持范围。');
          // Recheck after asynchronous host discovery, then reserve synchronously.
          if (
            terminals.has(k) ||
            terminals.size >= 64 ||
            [...terminals.values()].filter((e) => e.owner === actor.id).length >= 8
          )
            throw localRejected('终端编号已存在或数量已达到上限，请先关闭不使用的终端。');
          const entry = {
            key: k,
            owner: actor.id,
            actor,
            login: actor.sessionHash,
            conversation: r.id,
            connection: current.connection_id,
            session: current.session_id,
            id: p.terminalId,
            chat,
            limits,
            attachment: randomUUID(),
            control: new AbortController(),
            chunks: [],
            bytes: 0,
            cursor: 0,
            touched: now(),
            writable: false,
            revoked: false,
            chain: Promise.resolve(),
          };
          terminals.set(k, entry);
          try {
            entry.info = dshTerminalInfo.parse(
              await chat.terminalCreate(entry.session, {
                id: entry.id,
                cols: p.cols,
                rows: p.rows,
              }),
            );
            if (entry.info.id !== entry.id) throw Error('DSH terminal identity mismatch');
            authorize(actor, current);
            await follow(entry);
            authorize(actor, current);
            return { terminalId: entry.id };
          } catch (e) {
            void dispose(entry);
            throw e;
          }
        });
        const entry = terminals.get(key(actor.id, r.id, p.terminalId));
        json(200, { operation, terminal: entry && !entry.revoked ? read(entry) : null });
        return true;
      }
      const match = path.match(/^\/terminals\/([^/]+)(?:\/(input|resize|close))?$/);
      if (!match) return false;
      const entry = owned(actor, r, uuid.parse(match[1]));
      if (req.method === 'GET' && !match[2]) {
        const cursor = z.coerce
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .parse(url.searchParams.get('cursor') || 0);
        json(200, { terminal: read(entry, cursor) });
        return true;
      }
      if (req.method !== 'POST' || !match[2]) return false;
      const kind = match[2];
      const p = (
        kind === 'input'
          ? z.object({ id: uuid, data: z.string().min(1).max(16384) })
          : kind === 'resize'
            ? z.object({ id: uuid, ...dimensions })
            : z.object({ id: uuid })
      )
        .strict()
        .parse(await body(req));
      const work = entry.chain
        .catch(() => {})
        .then(() =>
          action(
            actor.id,
            r.id,
            p.id,
            'terminal-' + kind,
            { terminalId: entry.id, ...p },
            async () => {
              owned(actor, r, entry.id);
              if (kind === 'close') {
                await dispose(entry);
                if (!entry.cleaned) throw fail(502, '终端关闭结果待主机确认。');
                return { closed: true };
              }
              if (!entry.writable || entry.error)
                throw localRejected('终端输入连接不可用，未发送输入。');
              if (kind === 'input') {
                if (Buffer.byteLength(p.data) > entry.limits.maxInputBytes)
                  throw localRejected('输入超过主机单次上限。');
                try {
                  await entry.chat.terminalWrite(entry.session, entry.id, entry.attachment, p.data);
                } catch (e) {
                  entry.error = '输入结果待核对，不会重发。';
                  entry.writable = false;
                  throw e;
                }
              } else {
                if (p.cols > entry.limits.maxCols || p.rows > entry.limits.maxRows)
                  throw localRejected('终端尺寸超出主机上限。');
                await entry.chat.terminalResize(
                  entry.session,
                  entry.id,
                  entry.attachment,
                  p.cols,
                  p.rows,
                );
              }
              authorize(actor, r);
              return { accepted: true };
            },
          ),
        );
      entry.chain = work;
      json(200, { operation: await work });
      return true;
    },
    close() {
      closed = true;
      clearInterval(sweep);
      for (const entry of terminals.values()) void dispose(entry);
    },
  };
}
