import { useEffect, useRef, useState } from 'react';
import { BarChart3, RefreshCw, ChevronDown } from 'lucide-react';
import { api } from './data';
import type { Settings } from './types';
type Totals = {
  requests: number;
  unknownUsage: number;
  unpriced: number;
  input: number;
  output: number;
  cacheHit: number;
  cacheMiss: number;
  costCny: string;
};
type Account = Totals & { id: string; username: string; displayName: string };
type UsageRequest = {
  id: string;
  owner: string;
  model: string;
  source: string;
  startedAt: string;
  tokens: { input: number | null; output: number | null } | null;
  costCny: string | null;
  reason: string | null;
};
type Report = {
  admin: boolean;
  since: string;
  coverage: string;
  total: Totals;
  accounts: Account[];
  requests: UsageRequest[];
  next: number | null;
  priceCard: {
    verifiedAt: string;
    source: string;
    models: Record<string, { offPeak: Record<string, string>; peak: Record<string, string> }>;
  };
};
const money = (v: string | null) =>
  v === null ? '待核算' : '¥' + v.replace(/0+$/, '').replace(/\.$/, '');
const sourceLabel = (source: string) =>
  (
    ({
      assistant: '智能助手',
      computer: '电脑任务',
      'computer-legacy': '电脑任务',
      learning: '学习',
      mail: '邮件整理',
      'mail-agent': '邮件助手',
      'conversation-title': '对话命名',
      'assistant-compaction': '上下文压缩',
      'assistant-auxiliary': '缓存等辅助调用',
      'plugins/run': '文本插件',
      'plugins/wish': '插件许愿',
      'tarot/questions': '推荐问题',
      'tarot/interpret': '塔罗解读',
    }) as Record<string, string>
  )[source] || '其他AI功能';
const n = (v: number | null) => (v === null ? '未知' : v.toLocaleString('zh-CN'));
const day = (date: Date) => new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10);
export function UsagePanel({ settings }: { settings: Settings }) {
  const [from, setFrom] = useState(() => day(new Date(Date.now() - 29 * 86400000))),
    [to, setTo] = useState(() => day(new Date())),
    [account, setAccount] = useState(''),
    [report, setReport] = useState<Report | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]),
    scope = useRef(0);
  async function load(cursor?: number, selectedAccount = account) {
    const generation = scope.current;
    setBusy(true);
    setError('');
    try {
      const q = new URLSearchParams({
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(selectedAccount ? { account: selectedAccount } : {}),
        ...(cursor ? { cursor: String(cursor) } : {}),
      });
      const r = await api<Report>(settings, '/usage?' + q, undefined, undefined, false, {
        fresh: true,
      });
      if (scope.current !== generation) return;
      if (!selectedAccount) setAccounts(r.accounts);
      setReport((old) =>
        cursor && old ? { ...r, requests: [...old.requests, ...r.requests] } : r,
      );
    } catch (e) {
      if (scope.current === generation) setError((e as Error).message);
    } finally {
      if (scope.current === generation) setBusy(false);
    }
  }
  useEffect(() => {
    scope.current++;
    setReport(null);
    setAccounts([]);
    setAccount('');
    if (settings.sessionToken) void load(undefined, '');
    return () => {
      scope.current++;
    };
  }, [settings.url, settings.sessionToken]);
  if (!settings.sessionToken) return null;
  return (
    <section className="surface usage-panel" aria-label="账户用量与费用">
      <div className="section-title">
        <BarChart3 size={21} />
        <h2>账户用量与费用</h2>
        <span className="tag">人民币 · 费用核算</span>
      </div>
      <form
        className="usage-filters"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label>
          开始日期
          <input
            aria-label="用量开始日期"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          结束日期
          <input
            aria-label="用量结束日期"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        {report?.admin && (
          <label>
            账户
            <select
              aria-label="用量账户"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="">全部账户</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName} · {a.username}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" disabled={busy}>
          <RefreshCw size={15} className={busy ? 'spin' : ''} />
          查询
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {report && (
        <>
          <div className="usage-totals">
            <div>
              <span>已核算费用</span>
              <strong>{money(report.total.costCny)}</strong>
            </div>
            <div>
              <span>已记录输入 / 输出 Token</span>
              <strong>
                {n(report.total.input)} / {n(report.total.output)}
              </strong>
            </div>
            <div>
              <span>已记录缓存命中 / 未命中</span>
              <strong>
                {n(report.total.cacheHit)} / {n(report.total.cacheMiss)}
              </strong>
            </div>
            <div>
              <span>计量记录</span>
              <strong>{n(report.total.requests)}</strong>
            </div>
          </div>
          {(report.total.unknownUsage > 0 || report.total.unpriced > 0) && (
            <p className="muted">
              {report.total.unknownUsage} 次用量未知，{report.total.unpriced}{' '}
              次费用待核算；已核算合计不含这些未知费用。
            </p>
          )}
          {report.admin && (
            <div className="usage-table-scroll">
              <table>
                <caption>各账户合计</caption>
                <thead>
                  <tr>
                    <th>账户</th>
                    <th>请求</th>
                    <th>缓存命中</th>
                    <th>未命中</th>
                    <th>输出</th>
                    <th>费用</th>
                    <th>待核算</th>
                  </tr>
                </thead>
                <tbody>
                  {report.accounts.map((a) => (
                    <tr key={a.id}>
                      <th>
                        {a.displayName}
                        <small>{a.username}</small>
                      </th>
                      <td>{n(a.requests)}</td>
                      <td>{n(a.cacheHit)}</td>
                      <td>{n(a.cacheMiss)}</td>
                      <td>{n(a.output)}</td>
                      <td>{money(a.costCny)}</td>
                      <td>{a.unpriced}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <details>
            <summary>
              <ChevronDown size={14} />
              调用明细
            </summary>
            <div className="usage-request-list">
              {report.requests.length === 0 ? (
                <p className="muted">所选日期没有已记录的模型请求。</p>
              ) : (
                report.requests.map((r) => (
                  <article key={r.id}>
                    <div>
                      <strong>{r.model}</strong>
                      <span>
                        {new Date(r.startedAt).toLocaleString('zh-CN', {
                          timeZone: 'Asia/Shanghai',
                          hour12: false,
                        })}
                      </span>
                    </div>
                    <div>
                      <span>
                        {report.admin
                          ? (report.accounts.find((a) => a.id === r.owner)?.displayName ||
                              '历史账户') + ' · '
                          : ''}
                        {sourceLabel(r.source)}
                      </span>
                      <span>
                        {n(r.tokens?.input ?? null)} 输入 · {n(r.tokens?.output ?? null)} 输出
                      </span>
                      <strong>{money(r.costCny)}</strong>
                    </div>
                    {r.reason && (
                      <small>
                        {(
                          {
                            usage_incomplete: '响应缺少完整用量',
                            request_time_missing: '请求起始时刻未知',
                            model_not_priced: '模型暂无已核验价格',
                            price_not_verified_for_date: '该日期价格未核验',
                            holiday_calendar_missing: '该年份节假日未核验',
                          } as Record<string, string>
                        )[r.reason] || '等待完整用量'}
                      </small>
                    )}
                  </article>
                ))
              )}
            </div>
            {report.next && (
              <button type="button" disabled={busy} onClick={() => void load(report.next!)}>
                更多明细
              </button>
            )}
          </details>
          <details>
            <summary>DeepSeek 官方单价</summary>
            <p className="muted">
              每百万 Token，按请求开始时的北京时间区分高峰、空闲时段。价格核验于{' '}
              {report.priceCard.verifiedAt}。
            </p>
            <div className="usage-table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>模型 / 时段</th>
                    <th>缓存命中</th>
                    <th>未命中</th>
                    <th>输出</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(report.priceCard.models).flatMap(([model, bands]) =>
                    Object.entries(bands).map(([band, r]) => (
                      <tr key={model + band}>
                        <th>
                          {model}
                          <small>{band === 'peak' ? '高峰' : '空闲'}</small>
                        </th>
                        <td>¥{r.cacheHit}</td>
                        <td>¥{r.cacheMiss}</td>
                        <td>¥{r.output}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
            <a href={report.priceCard.source} target="_blank" rel="noreferrer">
              查看官方价格
            </a>
          </details>
          <p className="muted usage-note">
            从 {new Date(report.since).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}{' '}
            开始记录。{report.coverage} 此处为官网单价估算，实际扣费以 DeepSeek
            账单为准，独立搜索/抓取 API 费用不计入 Token 费用。
          </p>
        </>
      )}
    </section>
  );
}
