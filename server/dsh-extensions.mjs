import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from './accounts.mjs';
import { dshExtensionChange } from '../shared/dsh-extensions.mjs';

const uuid = z.string().uuid();
// This layer freezes a host preview under the exact login/connection/session.
// The host also owns an encrypted durable ledger and refuses duplicate commits.
export function createDshExtensions({
  db,
  body,
  ensure,
  target,
  row,
  action,
  active,
  rate,
  now = Date.now,
}) {
  const previews = new Map(),
    controllers = new Map();
  function authorize(actor, id) {
    if (actor.role !== 'owner' || !actor.sessionHash || !active(actor))
      throw fail(403, '只有当前已登录的管理员可以管理主机扩展。');
    const r = row(actor.id, id);
    target(actor.id, r);
    return r;
  }
  async function native(actor, id, request, signal) {
    const current = authorize(actor, id),
      { chat } = await ensure(actor.id, id);
    authorize(actor, id);
    if (!chat.extensions) throw fail(409, '目标主机尚未提供扩展管理，请更新主机工具桥。');
    signal?.throwIfAborted();
    const value = await chat.extensions(current.session_id, request, signal);
    authorize(actor, id);
    return value;
  }
  async function prepare(actor, id, change) {
    const r = authorize(actor, id),
      plan = randomUUID();
    for (const [key, p] of previews) if (p.expires <= now()) previews.delete(key);
    if (previews.size >= 200) throw fail(429, '待确认扩展较多，请先处理已有预览。');
    const preview = await native(actor, id, {
      action: 'prepare',
      id: plan,
      change: dshExtensionChange.parse(change),
    });
    const current = authorize(actor, id);
    if (preview.plan !== plan || !Number.isFinite(preview.expiresAt))
      throw fail(502, '主机预览编号不符。');
    previews.set(plan, {
      owner: actor.id,
      login: actor.sessionHash,
      conversation: id,
      connection: r.connection_id,
      session: current.session_id,
      expires: Math.min(preview.expiresAt, now() + 5 * 60000),
      preview,
    });
    return preview;
  }
  function ownedPreview(actor, id, plan) {
    const r = authorize(actor, id),
      p = previews.get(plan);
    if (
      !p ||
      p.owner !== actor.id ||
      p.login !== actor.sessionHash ||
      p.conversation !== id ||
      p.connection !== r.connection_id ||
      p.session !== r.session_id ||
      p.expires <= now()
    )
      throw fail(409, '预览已过期或不属于当前登录，请重新查看。');
    return p;
  }
  async function commit(actor, id, plan, operationId) {
    const p = ownedPreview(actor, id, plan);
    const operation = await action(actor.id, id, operationId, 'extensions', { plan }, async () => {
      const control = new AbortController();
      controllers.set(operationId, { owner: actor.id, control });
      const monitor = setInterval(() => {
        try {
          authorize(actor, id);
        } catch {
          control.abort();
        }
      }, 500);
      monitor.unref?.();
      try {
        const result = await native(
          actor,
          id,
          { action: 'commit', id: operationId, plan },
          control.signal,
        );
        if (result.state === 'unknown') throw fail(409, '主机操作结果待核对，不会自动重试。');
        return result;
      } finally {
        clearInterval(monitor);
        controllers.delete(operationId);
      }
    });
    const stored = db
      .prepare('SELECT result FROM dsh_actions WHERE owner=? AND id=?')
      .get(actor.id, operationId);
    if (stored?.result) p.confirmed = true;
    return { operation, result: stored?.result ? JSON.parse(stored.result) : null };
  }
  return {
    authorize,
    catalog: async (actor, id) => {
      const value = await native(actor, id, { action: 'catalog' });
      return {
        ...value,
        pending: [...previews.values()]
          .filter(
            (p) =>
              p.owner === actor.id &&
              p.login === actor.sessionHash &&
              p.conversation === id &&
              p.expires > now() &&
              !p.confirmed,
          )
          .map((p) => p.preview),
      };
    },
    prepare,
    commit,
    async handle(req, url, json, actor, id) {
      const base = '/api/agent/remote/conversations/' + id + '/extensions';
      if (!url.pathname.startsWith(base)) return false;
      authorize(actor, id);
      rate(actor.id, 'extensions', 45);
      if (req.method === 'GET' && url.pathname === base) {
        json(200, { extensions: await this.catalog(actor, id) });
        return true;
      }
      const readSkill = url.pathname.match(/\/extensions\/skills\/([a-z0-9-]+)$/);
      if (req.method === 'GET' && readSkill) {
        json(200, { skill: await native(actor, id, { action: 'read-skill', name: readSkill[1] }) });
        return true;
      }
      const status = url.pathname.match(/\/extensions\/operations\/([^/]+)$/);
      if (req.method === 'GET' && status) {
        const operationId = uuid.parse(status[1]);
        const record = db
          .prepare(
            'SELECT * FROM dsh_actions WHERE owner=? AND id=? AND conversation_id=? AND kind=?',
          )
          .get(actor.id, operationId, id, 'extensions');
        if (!record) throw fail(404, '此对话没有该扩展操作。');
        json(200, { result: await native(actor, id, { action: 'status', id: operationId }) });
        return true;
      }
      if (req.method === 'POST' && url.pathname === base + '/preview') {
        const input = z
          .object({ change: dshExtensionChange })
          .strict()
          .parse(await body(req));
        json(200, { preview: await prepare(actor, id, input.change) });
        return true;
      }
      if (req.method === 'POST' && url.pathname === base + '/confirm') {
        const input = z
          .object({ plan: uuid, id: uuid })
          .strict()
          .parse(await body(req));
        json(200, await commit(actor, id, input.plan, input.id));
        return true;
      }
      if (req.method === 'POST' && url.pathname === base + '/discard') {
        const input = z
          .object({ plan: uuid })
          .strict()
          .parse(await body(req));
        ownedPreview(actor, id, input.plan);
        const result = await native(actor, id, { action: 'discard', plan: input.plan });
        if (result.state !== 'discarded') throw fail(409, '主机尚未确认取消预览。');
        previews.delete(input.plan);
        json(200, result);
        return true;
      }
      return false;
    },
    revoke(owner) {
      for (const [id, p] of previews) if (p.owner === owner) previews.delete(id);
      for (const { owner: account, control } of controllers.values())
        if (account === owner) control.abort();
    },
    close() {
      previews.clear();
      for (const { control } of controllers.values()) control.abort();
      controllers.clear();
    },
  };
}
