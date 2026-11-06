import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock3,
  Database,
  Gauge,
  LoaderCircle,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { metricValues } from '../../shared/pi-activity.mjs';
import type { ModelContext, PiContext, PiExecution, PiMetrics, Settings } from './types';
import { api } from './data';
const count = (value: number) =>
  Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const contextCount = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '未知';
  const unit = value >= 1048576 ? 1048576 : 1024;
  return `${Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value / unit)}${unit === 1048576 ? 'M' : 'K'}`;
};
function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}分${seconds % 60}秒`
    : `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
}
export function RunSummary({
  execution,
  status = 'done',
  phase,
}: {
  execution?: Pick<PiExecution, 'startedAt' | 'finishedAt'> | null;
  status?: string;
  phase?: string;
}) {
  const running = status === 'running';
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const start = Date.parse(execution?.startedAt || '');
  const end = running ? now : Date.parse(execution?.finishedAt || '');
  const elapsed = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
  const label = running
    ? phase || '执行中'
    : status === 'done'
      ? '已完成'
      : status === 'cancelled'
        ? '已停止'
        : status === 'interrupted'
          ? '待核对'
          : '未完成';
  return (
    <div
      className={`run-summary ${running ? 'is-running' : ''} ${!running && status !== 'done' ? 'has-error' : ''}`}
      role={running ? 'status' : undefined}
    >
      {running ? (
        <LoaderCircle size={13} className="spin" />
      ) : status === 'done' ? (
        <CheckCircle2 size={13} />
      ) : (
        <CircleAlert size={13} />
      )}
      <span>Pi · {label}</span>
      {elapsed !== null && (
        <span className="run-elapsed">
          <Clock3 size={11} />
          用时 {duration(elapsed)}
        </span>
      )}
    </div>
  );
}
export function RunMetrics({ metrics }: { metrics?: PiMetrics }) {
  if (!metrics) return null;
  const values = metricValues(metrics);
  return (
    <div className="run-metrics" aria-label="本次任务用量">
      {metrics.modelTurns !== undefined && (
        <span title="本次任务的模型响应轮次，包含工具调用后的继续响应">
          {metrics.modelTurns} 轮
        </span>
      )}
      {metrics.toolCalls !== undefined && <span>{metrics.toolCalls} 次工具</span>}
      {values.totalTokens !== undefined && (
        <span title="本次任务累计输入、输出、缓存读取及写入 Token；不是上下文长度">
          {count(values.totalTokens)} tokens
        </span>
      )}
      {values.tokensPerSecond !== undefined && (
        <span title="输出 Token / 模型响应耗时（含等待，不含工具执行时间）">
          {Math.round(values.tokensPerSecond)} tok/s
        </span>
      )}
      {values.cacheHit !== undefined && (
        <span title="缓存读取 Token / 总输入 Token">缓存命中 {Math.round(values.cacheHit)}%</span>
      )}
    </div>
  );
}
export function SessionTelemetry({
  context,
  metrics,
  settings,
  conversationId,
}: {
  context: PiContext | null;
  metrics?: PiMetrics;
  settings: Settings;
  conversationId: string;
}) {
  const panel = useRef<HTMLDetailsElement>(null);
  const [limits, setLimits] = useState<ModelContext | null>(null);
  const [draft, setDraft] = useState('');
  const [automatic, setAutomatic] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const mounted = useRef(true);
  const endpoint = `/pi/conversations/${conversationId}/context`;
  function applyLimits(value: ModelContext) {
    setLimits(value);
    setDraft(String(value.requestedContextWindow ?? value.contextWindow));
    setAutomatic(value.requestedContextWindow === null);
  }
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void api<ModelContext>(settings, endpoint)
      .then((value) => {
        if (!cancelled) applyLimits(value);
      })
      .catch((e) => {
        if (!cancelled) setFailure(e.message);
      });
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [settings, endpoint]);
  async function updateLimits(refresh = false) {
    setSaving(true);
    setFailure('');
    setNotice('');
    try {
      const value = await api<ModelContext>(
        settings,
        endpoint,
        refresh ? { refresh: true } : { contextWindow: automatic ? null : Number(draft) },
      );
      if (mounted.current) {
        applyLimits(value);
        setNotice(refresh ? '已重新查询模型 API。' : '已保存，将用于下一轮任务。');
      }
    } catch (e) {
      if (mounted.current) setFailure((e as Error).message);
    } finally {
      if (mounted.current) setSaving(false);
    }
  }
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node))
        panel.current.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  const stats = context?.stats;
  const tokens = stats?.tokens;
  const sessionTokens =
    tokens?.total ??
    (tokens && Object.values(tokens).some((v) => typeof v === 'number')
      ? ['input', 'output', 'cacheRead', 'cacheWrite'].reduce(
          (n, k) => n + (tokens[k as keyof typeof tokens] || 0),
          0,
        )
      : undefined);
  const values = metricValues(metrics);
  const inputs = (tokens?.input || 0) + (tokens?.cacheRead || 0) + (tokens?.cacheWrite || 0);
  const cache =
    typeof tokens?.cacheRead === 'number' && inputs > 0
      ? (tokens.cacheRead / inputs) * 100
      : undefined;
  const usage = stats?.contextUsage;
  const percent =
    typeof usage?.percent === 'number' && Number.isFinite(usage.percent)
      ? Math.max(0, usage.percent)
      : null;
  const rounds = stats?.assistantMessages;
  const tools = stats?.toolCalls;
  return (
    <details
      className="session-telemetry"
      ref={panel}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && panel.current?.open) {
          event.stopPropagation();
          panel.current.open = false;
        }
      }}
    >
      <summary aria-label="查看会话用量与上下文" title="会话用量与上下文">
        <Gauge size={13} />
        {rounds !== undefined && (
          <span className="telemetry-counts">
            {rounds} 轮{tools !== undefined ? ` ${tools} 次工具` : ''}
          </span>
        )}
        {values.tokensPerSecond !== undefined && (
          <span className="telemetry-secondary">{Math.round(values.tokensPerSecond)} tok/s</span>
        )}
        {sessionTokens !== undefined && (
          <span className="telemetry-tokens">
            <Database size={12} />
            {count(sessionTokens)} tok
          </span>
        )}
        {cache !== undefined && (
          <span className="telemetry-secondary">缓存命中 {Math.round(cache)}%</span>
        )}
        {limits && (
          <span className="telemetry-window">{contextCount(limits.contextWindow)} 上下文</span>
        )}
        {percent !== null ? (
          <span className="context-indicator">
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="6" />
              <circle
                className="context-ring-value"
                cx="8"
                cy="8"
                r="6"
                strokeDasharray={`${Math.min(100, percent) * 0.377} 37.7`}
                transform="rotate(-90 8 8)"
              />
            </svg>
            {Math.round(percent)}%
          </span>
        ) : (
          <span>会话详情</span>
        )}
        <ChevronDown size={11} />
      </summary>
      <div className="telemetry-panel">
        <section className="context-settings" aria-label="上下文设置">
          <div className="context-settings-heading">
            <h3>上下文窗口</h3>
            <button type="button" onClick={() => void updateLimits(true)} disabled={saving}>
              {saving ? '查询中…' : '查询上限'}
            </button>
          </div>
          <p className="context-model">{limits?.model || '正在查询模型…'}</p>
          <p>
            模型上限：{limits?.maxContextWindow?.toLocaleString() || '未确认'} tokens
            {limits?.source === 'cache'
              ? ' · 缓存'
              : limits?.source === 'api'
                ? ' · API 已确认'
                : ''}
          </p>
          <label className="context-follow">
            <input
              type="checkbox"
              checked={automatic}
              disabled={saving || !limits?.maxContextWindow}
              onChange={(e) => {
                setAutomatic(e.target.checked);
                setNotice('');
              }}
            />
            跟随模型上限
          </label>
          <div className="context-size-input">
            <label htmlFor="context-window-tokens">本对话窗口</label>
            <input
              id="context-window-tokens"
              type="number"
              inputMode="numeric"
              step="1"
              min={limits?.minContextWindow || 16384}
              max={limits?.maxContextWindow || undefined}
              value={automatic ? limits?.maxContextWindow || '' : draft}
              placeholder="Token 数量"
              disabled={automatic || saving || !limits?.maxContextWindow}
              onChange={(e) => {
                setDraft(e.target.value);
                setNotice('');
              }}
            />
            <span>tokens</span>
          </div>
          <div className="context-presets" aria-label="常用窗口大小">
            {[65536, 131072, 262144, 524288]
              .filter((v) => v <= (limits?.maxContextWindow || 0))
              .map((v) => (
                <button
                  type="button"
                  key={v}
                  disabled={saving}
                  aria-pressed={!automatic && Number(draft) === v}
                  onClick={() => {
                    setAutomatic(false);
                    setDraft(String(v));
                    setNotice('');
                  }}
                >
                  {v / 1024}K
                </button>
              ))}
          </div>
          <p>
            仅调整模型工作窗口，聊天记录仍保留。调小时按 Pi 原生规则自动压缩；界面展示轮数不变。
          </p>
          {limits?.activeContextWindow && (
            <p>
              当前任务窗口：{limits.activeContextWindow.toLocaleString()} tokens；修改用于下一轮。
            </p>
          )}
          {limits?.warning && <p role="status">{limits.warning}</p>}
          {failure && (
            <p className="context-error" role="alert">
              {failure}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          <button
            type="button"
            className="context-save"
            disabled={
              saving ||
              !limits?.maxContextWindow ||
              (!automatic &&
                (!Number.isSafeInteger(Number(draft)) ||
                  Number(draft) < limits.minContextWindow ||
                  Number(draft) > limits.maxContextWindow))
            }
            onClick={() => void updateLimits()}
          >
            保存上下文设置
          </button>
        </section>
        <h3>会话用量</h3>
        <dl>
          {rounds !== undefined && (
            <>
              <dt>模型响应</dt>
              <dd>{rounds} 轮</dd>
            </>
          )}
          {tools !== undefined && (
            <>
              <dt>工具调用</dt>
              <dd>{tools} 次</dd>
            </>
          )}
          {sessionTokens !== undefined && (
            <>
              <dt>累计 Token</dt>
              <dd>{sessionTokens.toLocaleString()}</dd>
            </>
          )}
          {tokens?.input !== undefined && (
            <>
              <dt>输入</dt>
              <dd>{tokens.input.toLocaleString()}</dd>
            </>
          )}
          {tokens?.output !== undefined && (
            <>
              <dt>输出</dt>
              <dd>{tokens.output.toLocaleString()}</dd>
            </>
          )}
          {tokens?.cacheRead !== undefined && (
            <>
              <dt>缓存读取</dt>
              <dd>{tokens.cacheRead.toLocaleString()}</dd>
            </>
          )}
          {tokens?.cacheWrite !== undefined && (
            <>
              <dt>缓存写入</dt>
              <dd>{tokens.cacheWrite.toLocaleString()}</dd>
            </>
          )}
          {cache !== undefined && (
            <>
              <dt>缓存命中率</dt>
              <dd>{Math.round(cache)}%</dd>
            </>
          )}
          {usage && (
            <>
              <dt>上下文占用</dt>
              <dd>
                {usage.tokens == null ? '待模型返回' : usage.tokens.toLocaleString()} /{' '}
                {usage.contextWindow.toLocaleString()}
                {percent !== null ? ` (${Math.round(percent)}%)` : ''}
              </dd>
            </>
          )}
          {context?.messageCount !== undefined && (
            <>
              <dt>上下文消息</dt>
              <dd>{context.messageCount} 条</dd>
            </>
          )}
          {values.tokensPerSecond !== undefined && (
            <>
              <dt>最近任务输出速度</dt>
              <dd>{Math.round(values.tokensPerSecond)} tok/s</dd>
            </>
          )}
        </dl>
        {!stats && !context?.messageCount && <p>模型返回用量后将在这里显示。</p>}
        <p>
          累计 Token 为会话消耗；上下文占用为 Pi
          最近返回的窗口值。输出速度按模型响应耗时计算，包含等待，排除工具执行时间。
        </p>
      </div>
    </details>
  );
}
