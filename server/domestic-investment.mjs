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
const transactionType = z.enum(['buy', 'sell', 'recurring', 'dividend', 'transfer', 'conversion']);
const transactionStatus = z.enum([
  'draft',
  'confirmed',
  'submitted',
  'priced',
  'confirmed_holding',
  'settled',
  'failed',
  'unknown',
]);
const naturalLanguageTransaction = z
  .object({
    text: z.string().trim().min(1).max(4000),
    source: z.enum(['chat', 'alipay_import', 'manual']).default('chat'),
  })
  .strict();
const scheduleInput = z
  .object({
    kind: z.enum(['quotes', 'recommendations']),
    interval_minutes: z.number().int().min(30).max(24 * 60).default(30),
    enabled: z.boolean().default(true),
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
      CREATE TABLE IF NOT EXISTS investment_transactions(
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        asset_type TEXT NOT NULL,
        symbol TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        amount REAL,
        quantity REAL,
        unit_price REAL,
        requested_at TEXT,
        pricing_date TEXT,
        confirmed_at TEXT,
        source TEXT NOT NULL,
        raw_text TEXT NOT NULL DEFAULT '',
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS investment_transactions_owner ON investment_transactions(owner, created_at);
      CREATE TABLE IF NOT EXISTS investment_schedules(
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        kind TEXT NOT NULL,
        interval_minutes INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run_at TEXT NOT NULL,
        last_run_at TEXT,
        last_status TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS investment_schedules_owner_kind ON investment_schedules(owner, kind);
      CREATE TABLE IF NOT EXISTS investment_recommendations(
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        source_as_of TEXT,
        payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS investment_recommendations_owner ON investment_recommendations(owner, generated_at);
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

  function readTransactions(owner) {
    if (!db) return [];
    return db
      .prepare(
        'SELECT id,type,status,asset_type,symbol,name,amount,quantity,unit_price,requested_at,pricing_date,confirmed_at,source,raw_text,metadata,created_at,updated_at FROM investment_transactions WHERE owner=? ORDER BY created_at DESC',
      )
      .all(owner)
      .map((transaction) => ({
        ...transaction,
        metadata: JSON.parse(transaction.metadata || '{}'),
      }));
  }

  function readSchedules(owner) {
    if (!db) return [];
    return db
      .prepare(
        'SELECT id,kind,interval_minutes,enabled,next_run_at,last_run_at,last_status,created_at,updated_at FROM investment_schedules WHERE owner=? ORDER BY kind',
      )
      .all(owner)
      .map((schedule) => ({ ...schedule, enabled: !!schedule.enabled }));
  }

  function parseNaturalLanguage(text) {
    const symbol = text.match(/\b\d{6}\b/)?.[0] || '';
    const amountMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:元|块)/);
    const quantityMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:份|股)/);
    const type = /卖出|赎回|卖了|卖掉/.test(text)
      ? 'sell'
      : /定投|每月|每周|每个交易日/.test(text)
        ? 'recurring'
        : /分红|红利/.test(text)
          ? 'dividend'
          : 'buy';
    const assetType = /黄金|金价|Au9999|AU9999/i.test(text)
      ? 'gold'
      : /股票|ETF|股份|股/.test(text)
        ? 'domestic_equity'
        : 'fund';
    const name = text
      .replace(/我(今天|现在|刚刚|已经)?(买了|买入|卖出|赎回|卖了|定投|持有)/g, '')
      .replace(/\b\d{6}\b/g, '')
      .replace(/\d+(?:\.\d+)?\s*(?:元|块|份|股)/g, '')
      .replace(/[，。,.、]/g, ' ')
      .trim()
      .slice(0, 120);
    const amount = amountMatch ? Number(amountMatch[1]) : null;
    const quantity = quantityMatch ? Number(quantityMatch[1]) : null;
    const missing = [];
    if (!name && !symbol) missing.push('name');
    if (amount === null && quantity === null) missing.push('amount_or_quantity');
    return {
      type,
      asset_type: assetType,
      symbol,
      name: name || (symbol ? `代码 ${symbol}` : ''),
      amount,
      quantity,
      unit_price: amount !== null && quantity ? Number((amount / quantity).toFixed(8)) : null,
      requested_at: new Date().toISOString(),
      missing,
      confidence: missing.length ? 'low' : symbol ? 'high' : 'medium',
    };
  }

  function saveTransaction(owner, parsed, source, rawText) {
    if (!db) throw fail(503, '交易记录保存暂不可用。');
    const now = new Date().toISOString();
    const id = randomUUID();
    db.prepare(
      'INSERT INTO investment_transactions(id,owner,type,status,asset_type,symbol,name,amount,quantity,unit_price,requested_at,source,raw_text,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      owner,
      parsed.type,
      'draft',
      parsed.asset_type,
      parsed.symbol,
      parsed.name,
      parsed.amount,
      parsed.quantity,
      parsed.unit_price,
      parsed.requested_at,
      source,
      rawText,
      JSON.stringify({ confidence: parsed.confidence, missing: parsed.missing }),
      now,
      now,
    );
    return readTransactions(owner).find((transaction) => transaction.id === id);
  }

  function applyTransaction(owner, transaction) {
    if (!db || transaction.quantity === null || transaction.quantity === undefined) return null;
    const current = db
      .prepare('SELECT * FROM investment_holdings WHERE owner=? AND (symbol=? OR (symbol=\'\' AND name=?)) ORDER BY updated_at DESC LIMIT 1')
      .get(owner, transaction.symbol, transaction.name);
    const quantityDelta = transaction.type === 'sell' ? -transaction.quantity : transaction.quantity;
    if (current) {
      const quantity = Math.max(0, current.quantity + quantityDelta);
      const costBasis =
        transaction.type === 'sell' || transaction.unit_price === null
          ? current.cost_basis
          : current.quantity + quantityDelta > 0
            ? Number(((current.quantity * (current.cost_basis ?? transaction.unit_price) + transaction.quantity * transaction.unit_price) / quantity).toFixed(8))
            : transaction.unit_price;
      db.prepare('UPDATE investment_holdings SET quantity=?,cost_basis=?,current_price=COALESCE(current_price,?),updated_at=? WHERE owner=? AND id=?').run(
        quantity,
        costBasis,
        transaction.unit_price,
        new Date().toISOString(),
        owner,
        current.id,
      );
      return current.id;
    }
    if (transaction.type === 'sell') throw fail(409, '找不到对应持仓，无法记录赎回或卖出。');
    const holding = holdingInput.parse({
      asset_type: transaction.asset_type,
      symbol: transaction.symbol,
      name: transaction.name,
      quantity: transaction.quantity,
      cost_basis: transaction.unit_price,
      current_price: transaction.unit_price,
      currency: 'CNY',
      price_as_of: null,
      source: transaction.source === 'alipay_import' ? 'manual' : 'manual',
    });
    const saved = saveHolding(owner, holding);
    return saved?.id ?? null;
  }

  function commitTransaction(owner, id) {
    if (!db) throw fail(503, '交易记录保存暂不可用。');
    const transaction = db.prepare('SELECT * FROM investment_transactions WHERE owner=? AND id=?').get(owner, id);
    if (!transaction) throw fail(404, '交易记录不存在。');
    if (transaction.status !== 'draft') return readTransactions(owner).find((item) => item.id === id);
    const holdingId = applyTransaction(owner, transaction);
    const now = new Date().toISOString();
    db.prepare('UPDATE investment_transactions SET status=?,confirmed_at=?,updated_at=?,metadata=? WHERE owner=? AND id=?').run(
      holdingId ? 'confirmed_holding' : 'confirmed',
      now,
      now,
      JSON.stringify({ ...JSON.parse(transaction.metadata || '{}'), holding_id: holdingId }),
      owner,
      id,
    );
    return readTransactions(owner).find((item) => item.id === id);
  }

  function recommendationFor(owner) {
    const portfolio = portfolioFor(owner);
    const asOf = portfolio.data_as_of || new Date().toISOString();
    return {
      generated_at: new Date().toISOString(),
      source_as_of: asOf,
      actions: recommendDailyActions({ portfolio, riskProfile: 'balanced', asOf }).actions || [],
    };
  }

  async function runSchedule(owner, schedule) {
    if (schedule.kind === 'quotes') await refreshHoldings(owner);
    else {
      const recommendation = recommendationFor(owner);
      const now = new Date();
      db.prepare('INSERT INTO investment_recommendations(id,owner,generated_at,expires_at,source_as_of,payload) VALUES(?,?,?,?,?,?)').run(
        randomUUID(),
        owner,
        now.toISOString(),
        new Date(now.getTime() + schedule.interval_minutes * 60_000).toISOString(),
        recommendation.source_as_of,
        JSON.stringify(recommendation),
      );
    }
  }

  const schedulerTimer = options.startScheduler && db
    ? setInterval(async () => {
        const now = Date.now();
        const due = db.prepare('SELECT * FROM investment_schedules WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 20').all(new Date(now).toISOString());
        for (const schedule of due) {
          const next = new Date(now + schedule.interval_minutes * 60_000).toISOString();
          db.prepare('UPDATE investment_schedules SET next_run_at=?,last_status=?,updated_at=? WHERE id=?').run(next, 'running', new Date(now).toISOString(), schedule.id);
          try {
            await runSchedule(schedule.owner, schedule);
            db.prepare('UPDATE investment_schedules SET last_run_at=?,last_status=?,updated_at=? WHERE id=?').run(new Date(now).toISOString(), 'done', new Date().toISOString(), schedule.id);
          } catch (error) {
            db.prepare('UPDATE investment_schedules SET last_status=?,updated_at=? WHERE id=?').run(`error:${error.message.slice(0, 180)}`, new Date().toISOString(), schedule.id);
          }
        }
      }, 30_000)
    : null;
  schedulerTimer?.unref?.();

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
    if (url.pathname === '/api/investment/transactions' && req.method === 'GET') {
      json(200, { transactions: readTransactions(actor.id) });
      return true;
    }
    if (url.pathname === '/api/investment/transactions/preview' && req.method === 'POST') {
      const input = naturalLanguageTransaction.parse(await readBody(req, { maxBytes: 16 * 1024 }));
      const parsed = parseNaturalLanguage(input.text);
      const transaction = saveTransaction(actor.id, parsed, input.source, input.text);
      json(201, { transaction, parsed });
      return true;
    }
    const transactionCommit = url.pathname.match(/^\/api\/investment\/transactions\/([0-9a-f-]{36})\/commit$/i);
    if (transactionCommit && req.method === 'POST') {
      json(200, { transaction: commitTransaction(actor.id, transactionCommit[1]) });
      return true;
    }
    if (url.pathname === '/api/investment/recommendations' && req.method === 'GET') {
      const row = db
        ?.prepare('SELECT generated_at,expires_at,source_as_of,payload FROM investment_recommendations WHERE owner=? ORDER BY generated_at DESC LIMIT 1')
        .get(actor.id);
      json(200, row ? { ...row, payload: JSON.parse(row.payload) } : recommendationFor(actor.id));
      return true;
    }
    if (url.pathname === '/api/investment/schedules' && req.method === 'GET') {
      json(200, { schedules: readSchedules(actor.id) });
      return true;
    }
    if (url.pathname === '/api/investment/schedules' && req.method === 'POST') {
      if (!db) throw fail(503, '定时任务保存暂不可用。');
      const input = scheduleInput.parse(await readBody(req, { maxBytes: 16 * 1024 }));
      const now = new Date();
      const id = randomUUID();
      db.prepare(
        'INSERT INTO investment_schedules(id,owner,kind,interval_minutes,enabled,next_run_at,last_status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,kind) DO UPDATE SET interval_minutes=excluded.interval_minutes,enabled=excluded.enabled,next_run_at=excluded.next_run_at,updated_at=excluded.updated_at',
      ).run(id, actor.id, input.kind, input.interval_minutes, input.enabled ? 1 : 0, now.toISOString(), 'scheduled', now.toISOString(), now.toISOString());
      json(201, { schedules: readSchedules(actor.id) });
      return true;
    }
    throw fail(404, '投资研究接口不存在。');
  }

  return {
    service,
    handle,
    close: () => {
      if (schedulerTimer) clearInterval(schedulerTimer);
    },
  };
}
