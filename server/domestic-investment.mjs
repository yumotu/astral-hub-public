import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createDomesticInvestmentService } from './domestic-investment-bundle/tool-definitions.mjs';
import { recommendDailyActions, summarizePortfolio } from './domestic-investment-bundle/core/recommendation.mjs';

const riskProfile = z.enum(['conservative', 'balanced', 'growth']);
const assetType = z.enum([
  'domestic_equity',
  'international_equity',
  'fund',
  'gold',
  'fx',
  'bond',
  'cash',
  'cash_management',
  'other',
]);
const holdingInput = z
  .object({
    asset_type: assetType,
    symbol: z.string().trim().max(32).default(''),
    name: z.string().trim().min(1).max(120),
    quantity: z.number().finite().positive().max(1e12),
    cost_basis: z.number().finite().nonnegative().nullable().default(null),
    current_price: z.number().finite().nonnegative().nullable().default(null),
    currency: z.string().trim().regex(/^[A-Z]{3}$/).default('CNY'),
    price_as_of: z.string().datetime().nullable().default(null),
    source: z.enum(['manual', 'tencent', 'eastmoney', 'tushare']).default('manual'),
  })
  .strict();
const fail = (status, message) => Object.assign(new Error(message), { status });

/**
 * The independent research window uses the same maintained service as the
 * DSH tools. It exposes public market research to signed-in users and keeps
 * personal portfolio input optional and server-configured.
 */
export async function createDomesticInvestment(options = {}) {
  const db = options.db;
  if (db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS investment_holdings(
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        symbol TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        quantity REAL NOT NULL,
        cost_basis REAL,
        current_price REAL,
        currency TEXT NOT NULL,
        price_as_of TEXT,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS investment_holdings_owner ON investment_holdings(owner, updated_at);
    `);
  }
  const service =
    options.service ||
    (await createDomesticInvestmentService({
      workspaceRoot: options.workspaceRoot || '/var/astral-investment',
      ...(options.dataFile ? { dataFile: options.dataFile } : {}),
      ...(options.bondEvidenceFile ? { bondEvidenceFile: options.bondEvidenceFile } : {}),
    }));

  function readHoldings(owner) {
    if (!db) return [];
    return db
      .prepare('SELECT id,asset_type,symbol,name,quantity,cost_basis,current_price,currency,price_as_of,source,created_at,updated_at FROM investment_holdings WHERE owner=? ORDER BY updated_at DESC')
      .all(owner)
      .map((holding) => ({
        id: holding.id,
        asset_type: holding.asset_type,
        symbol: holding.symbol,
        name: holding.name,
        quantity: holding.quantity,
        cost_basis: holding.cost_basis,
        current_price: holding.current_price,
        currency: holding.currency,
        price_as_of: holding.price_as_of,
        source: holding.source,
        value:
          holding.current_price === null ? null : Number((holding.quantity * holding.current_price).toFixed(4)),
        cost_value:
          holding.cost_basis === null ? null : Number((holding.quantity * holding.cost_basis).toFixed(4)),
        created_at: holding.created_at,
        updated_at: holding.updated_at,
      }));
  }

  function portfolioFor(owner) {
    const holdings = readHoldings(owner);
    const dates = holdings.map((holding) => holding.price_as_of).filter(Boolean).sort();
    return {
      source: 'account_holdings',
      data_as_of: dates.at(-1) ?? null,
      currency: 'CNY',
      holdings,
    };
  }

  function saveHolding(owner, input) {
    if (!db) throw fail(503, '持仓保存暂不可用。');
    const now = new Date().toISOString();
    const id = randomUUID();
    db.prepare(
      'INSERT INTO investment_holdings(id,owner,asset_type,symbol,name,quantity,cost_basis,current_price,currency,price_as_of,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      owner,
      input.asset_type,
      input.symbol,
      input.name,
      input.quantity,
      input.cost_basis,
      input.current_price,
      input.currency,
      input.price_as_of,
      input.source,
      now,
      now,
    );
    return readHoldings(owner).find((holding) => holding.id === id);
  }

  function deleteHolding(owner, id) {
    if (!db) throw fail(503, '持仓删除暂不可用。');
    const result = db.prepare('DELETE FROM investment_holdings WHERE owner=? AND id=?').run(owner, id);
    if (!result.changes) throw fail(404, '持仓不存在。');
  }

  async function refreshHoldings(owner) {
    if (!db || typeof service.quoteHoldings !== 'function') return { updated: 0, holdings: readHoldings(owner) };
    const current = readHoldings(owner);
    const quotes = await service.quoteHoldings(current);
    const now = new Date().toISOString();
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const quote of quotes) {
        db.prepare('UPDATE investment_holdings SET current_price=?,price_as_of=?,source=?,updated_at=? WHERE owner=? AND id=?').run(
          quote.current_price,
          quote.price_as_of,
          quote.source,
          now,
          owner,
          quote.id,
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { updated: quotes.length, holdings: readHoldings(owner) };
  }

  async function handle(req, url, json, actor, readBody) {
    if (!url.pathname.startsWith('/api/investment/')) return false;
    if (!actor?.id) throw fail(401, '请先登录账号查看投资研究。');
    if (url.pathname === '/api/investment/dashboard') {
      if (req.method !== 'GET') throw fail(405, '投资研究面板只提供读取操作。');
      const profile = riskProfile.parse(url.searchParams.get('risk_profile') || 'balanced');
      const dashboard = await service.dashboard({ risk_profile: profile });
      if (db) {
        const portfolio = portfolioFor(actor.id);
        const summary = summarizePortfolio(portfolio);
        const asOf = dashboard.international?.market?.as_of ?? dashboard.market?.as_of ?? new Date().toISOString().slice(0, 10);
        dashboard.portfolio = { ...portfolio, summary };
        dashboard.daily_actions = recommendDailyActions({
          portfolio,
          domesticMarket: dashboard.market,
          internationalMarket: dashboard.international?.market,
          riskProfile: profile,
          asOf,
        });
      }
      json(200, dashboard);
      return true;
    }
    if (url.pathname === '/api/investment/methodology') {
      if (req.method !== 'GET') throw fail(405, '投资研究方法只提供读取操作。');
      json(200, service.methodology());
      return true;
    }
    if (url.pathname === '/api/investment/holdings' && req.method === 'GET') {
      const portfolio = portfolioFor(actor.id);
      json(200, { ...portfolio, summary: summarizePortfolio(portfolio) });
      return true;
    }
    if (url.pathname === '/api/investment/holdings' && req.method === 'POST') {
      const input = holdingInput.parse(await readBody(req, { maxBytes: 64 * 1024 }));
      json(201, { holding: saveHolding(actor.id, input) });
      return true;
    }
    if (url.pathname === '/api/investment/holdings/refresh' && req.method === 'POST') {
      json(200, await refreshHoldings(actor.id));
      return true;
    }
    const deleteMatch = url.pathname.match(/^\/api\/investment\/holdings\/([0-9a-f-]{36})$/i);
    if (deleteMatch && req.method === 'DELETE') {
      deleteHolding(actor.id, deleteMatch[1]);
      json(200, { deleted: true });
      return true;
    }
    throw fail(404, '投资研究接口不存在。');
  }

  return { service, handle };
}
