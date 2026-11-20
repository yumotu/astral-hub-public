import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from './accounts.mjs';
import {
  deepseekPriceCard,
  providerTokenUsage,
  piTokenUsage,
  priceFor,
  tokenCost,
  formatCny,
} from '../shared/deepseek-pricing.mjs';

const querySchema = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    account: z.string().min(1).max(80).optional(),
    source: z.string().min(1).max(100).optional(),
    cursor: z.coerce.number().int().positive().optional(),
  })
  .strict();
export function createUsage(db, { now = Date.now } = {}) {
  const scopes = new AsyncLocalStorage();
  db.exec(`CREATE TABLE IF NOT EXISTS ai_price_cards(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_usage(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,owner TEXT NOT NULL,source TEXT NOT NULL,reference TEXT,model TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,status TEXT NOT NULL DEFAULT 'unknown',tokens TEXT,price TEXT NOT NULL,cost_nanos TEXT,reason TEXT NOT NULL DEFAULT 'usage_missing');
    CREATE INDEX IF NOT EXISTS ai_usage_owner_time ON ai_usage(owner,started_at,seq);
    CREATE INDEX IF NOT EXISTS ai_usage_time ON ai_usage(started_at,seq);`);
  db.prepare('INSERT OR IGNORE INTO ai_price_cards VALUES(?,?)').run(
    deepseekPriceCard.id,
    JSON.stringify(deepseekPriceCard),
  );
  if (
    db.prepare('SELECT data FROM ai_price_cards WHERE id=?').get(deepseekPriceCard.id).data !==
    JSON.stringify(deepseekPriceCard)
  )
    throw Error('价格版本内容已变化；请追加新版本，不得改写原价卡。');
  const since = new Date(now()).toISOString();
  db.exec('CREATE TABLE IF NOT EXISTS ai_usage_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO ai_usage_settings VALUES(?,?)').run('since', since);
  function resolveOwner(owner) {
    if (!owner) return null;
    return (
      db.prepare('SELECT id FROM users WHERE id=? OR space=?').get(owner, owner)?.id ||
      (owner === 'legacy' ? 'legacy' : null)
    );
  }
  function start(p = {}) {
    const scope = scopes.getStore() || {},
      owner = resolveOwner(p.owner || scope.owner);
    if (!owner) return null;
    const id = p.id || randomUUID(),
      at = p.startedAt || new Date(now()).toISOString(),
      model = p.model || 'unknown',
      source = String(p.source || scope.source || 'app').slice(0, 100),
      price = p.pricingUnknown ? { reason: p.pricingUnknown } : priceFor(model, at);
    db.prepare(
      'INSERT OR IGNORE INTO ai_usage(id,owner,source,reference,model,started_at,price) VALUES(?,?,?,?,?,?,?)',
    ).run(id, owner, source, p.reference || null, model, at, JSON.stringify(price));
    return id;
  }
  function finish(id, raw, { pi = false } = {}) {
    if (!id) return;
    const row = db.prepare('SELECT * FROM ai_usage WHERE id=?').get(id);
    if (!row || row.status === 'recorded') return;
    const tokens = pi ? piTokenUsage(raw) : providerTokenUsage(raw),
      price = JSON.parse(row.price),
      cost = tokenCost(tokens, price);
    const known = [tokens.input, tokens.output, tokens.cacheHit, tokens.cacheMiss].every(
      (v) => v !== null,
    );
    const any = Object.values(tokens).some((v) => v !== null);
    db.prepare(
      'UPDATE ai_usage SET finished_at=?,status=?,tokens=?,cost_nanos=?,reason=? WHERE id=?',
    ).run(
      new Date(now()).toISOString(),
      known ? 'recorded' : 'unknown',
      any ? JSON.stringify(tokens) : null,
      cost.costNanos,
      cost.reason || '',
      id,
    );
  }
  function pi(owner, task, event) {
    if (!['response_start', 'usage', 'billing_start', 'billing_usage'].includes(event.type)) return;
    // Bridge-generated identifiers are stable across SSE replay. Older bridges
    // cannot provide per-request timing; do not invent prices for those events.
    if (!event.requestId || !event.model || !event.startedAt) return;
    const id = start({
      owner,
      id: 'pi:' + owner + ':' + task.id + ':' + event.requestId,
      source:
        event.category === 'compaction'
          ? 'assistant-compaction'
          : event.category === 'auxiliary'
            ? 'assistant-auxiliary'
            : task.assistance
              ? 'mail-agent'
              : 'assistant',
      reference: task.id,
      model: event.model,
      startedAt: event.startedAt,
      pricingUnknown: event.pricingUnknown,
    });
    if (['usage', 'billing_usage'].includes(event.type)) finish(id, event.usage, { pi: true });
  }
  const view = (row) => ({
    id: row.id,
    owner: row.owner,
    source: row.source,
    model: row.model,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    tokens: row.tokens ? JSON.parse(row.tokens) : null,
    price: JSON.parse(row.price),
    costCny: formatCny(row.cost_nanos),
    reason: row.reason || null,
    status: row.status,
  });
  function report(actor, params = {}) {
    if (!actor?.id) throw fail(403, '请使用独立账号查看账户用量。');
    const p = querySchema.parse(params),
      admin = actor.role === 'owner';
    if (p.account && p.account !== actor.id && !admin) throw fail(403, '只能查看自己的账户用量。');
    if (p.from && p.to && p.from > p.to) throw fail(400, '开始日期不能晚于结束日期。');
    const where = [],
      args = [],
      chosen = p.account || (admin ? null : actor.id);
    if (chosen) {
      where.push('owner=?');
      args.push(chosen);
    }
    if (p.from) {
      where.push('started_at>=?');
      args.push(new Date(p.from + 'T00:00:00+08:00').toISOString());
    }
    if (p.to) {
      where.push('started_at<?');
      args.push(new Date(new Date(p.to + 'T00:00:00+08:00').getTime() + 86400000).toISOString());
    }
    if (p.source) {
      where.push('source=?');
      args.push(p.source);
    }
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    // Aggregate in SQLite rather than materializing every request in Node.
    const aggregate = db
      .prepare(
        `SELECT owner,count(*) requests,sum(CASE WHEN status!='recorded' THEN 1 ELSE 0 END) unknownUsage,sum(CASE WHEN cost_nanos IS NULL THEN 1 ELSE 0 END) unpriced,
      sum(COALESCE(json_extract(tokens,'$.input'),0)) input,sum(COALESCE(json_extract(tokens,'$.output'),0)) output,sum(COALESCE(json_extract(tokens,'$.cacheHit'),0)) cacheHit,sum(COALESCE(json_extract(tokens,'$.cacheMiss'),0)) cacheMiss FROM ai_usage${clause} GROUP BY owner`,
      )
      .all(...args);
    // SUM(cost_nanos) as SQLite integer may overflow on a very large history.
    // Costs are decimal integers; streaming rows keeps exact arithmetic.
    const costs = new Map();
    for (const row of db
      .prepare(
        `SELECT owner,cost_nanos FROM ai_usage${clause}${clause ? ' AND' : ' WHERE'} cost_nanos IS NOT NULL`,
      )
      .iterate(...args))
      costs.set(row.owner, (costs.get(row.owner) || 0n) + BigInt(row.cost_nanos));
    const users = db
      .prepare(
        'SELECT id,username,display_name AS displayName FROM users' +
          (chosen ? ' WHERE id=?' : '') +
          ' ORDER BY username',
      )
      .all(...(chosen ? [chosen] : []));
    const accounts = users.map((u) => {
      const a = aggregate.find((a) => a.owner === u.id);
      return {
        ...u,
        requests: a?.requests || 0,
        unknownUsage: a?.unknownUsage || 0,
        unpriced: a?.unpriced || 0,
        input: a?.input || 0,
        output: a?.output || 0,
        cacheHit: a?.cacheHit || 0,
        cacheMiss: a?.cacheMiss || 0,
        costCny: formatCny(costs.get(u.id) || 0n),
      };
    });
    if (admin && !chosen) {
      for (const a of aggregate)
        if (!users.some((u) => u.id === a.owner))
          accounts.push({
            id: a.owner,
            username: a.owner === 'legacy' ? '旧令牌空间' : '已删除账户',
            displayName: '历史记录',
            ...a,
            costCny: formatCny(costs.get(a.owner) || 0n),
          });
    }
    const total = aggregate.reduce(
      (s, a) => {
        for (const k of [
          'requests',
          'unknownUsage',
          'unpriced',
          'input',
          'output',
          'cacheHit',
          'cacheMiss',
        ])
          s[k] += a[k] || 0;
        return s;
      },
      { requests: 0, unknownUsage: 0, unpriced: 0, input: 0, output: 0, cacheHit: 0, cacheMiss: 0 },
    );
    const cursor = p.cursor ? ' AND seq<?' : '',
      limitArgs = p.cursor ? [...args, p.cursor] : args;
    const rows = db
      .prepare(
        `SELECT * FROM ai_usage${clause || ' WHERE 1=1'}${cursor} ORDER BY seq DESC LIMIT 51`,
      )
      .all(...limitArgs);
    return {
      admin,
      currency: 'CNY',
      mode: 'estimate',
      since: db.prepare('SELECT value FROM ai_usage_settings WHERE key=?').get('since').value,
      priceCard: deepseekPriceCard,
      accounts,
      total: { ...total, costCny: formatCny([...costs.values()].reduce((a, b) => a + b, 0n)) },
      requests: rows.slice(0, 50).map(view),
      next: rows.length > 50 ? rows[49].seq : null,
      coverage:
        '服务器模型请求；本机直连和外部插件自带密钥的调用不计入。历史缺失不补造；费用按请求开始时的官网价核算，不扣余额。',
    };
  }
  async function handle(req, url, json, actor) {
    if (url.pathname !== '/api/usage') return false;
    if (req.method !== 'GET') throw fail(405, '用量接口只支持查询。');
    json(200, report(actor, Object.fromEntries(url.searchParams)));
    return true;
  }
  return { scopes, start, finish, pi, report, handle };
}
