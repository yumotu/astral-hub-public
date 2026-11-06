import { useEffect, useRef, useState } from 'react';
import { Brain, Plus, RefreshCw, Pencil, Trash2 } from 'lucide-react';
import { api, dateLabel } from './data';
import type { Settings } from './types';

type Kind = 'fact' | 'preference' | 'goal' | 'task' | 'inference';
type Memory = {
  id: string;
  key: string;
  content: string;
  kind: Kind;
  scope: string;
  revision: number;
  updatedAt: string;
  source: { origin: string; quote?: string; conversationId?: string };
};
type Page = { enabled: boolean; items: Memory[]; next: string | null };
const kinds: Record<Kind, string> = {
  fact: '事实',
  preference: '偏好',
  goal: '目标',
  task: '临时任务',
  inference: '推测',
};
export function MemorySettings({ settings }: { settings: Settings }) {
  const [page, setPage] = useState<Page | null>(null),
    [query, setQuery] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{
    id?: string;
    revision?: number;
    key: string;
    content: string;
    kind: Kind;
  } | null>(null);
  const generation = useRef(0);
  async function load(before?: string) {
    const at = generation.current;
    setBusy(true);
    setError('');
    try {
      const result = await api<Page>(
        settings,
        '/memory?' +
          new URLSearchParams({ ...(query ? { query } : {}), ...(before ? { before } : {}) }),
      );
      if (at === generation.current)
        setPage((old) =>
          before && old ? { ...result, items: [...old.items, ...result.items] } : result,
        );
    } catch (e) {
      if (at === generation.current) setError((e as Error).message);
    } finally {
      if (at === generation.current) setBusy(false);
    }
  }
  useEffect(() => {
    generation.current++;
    setPage(null);
    setDraft(null);
    void load();
    return () => {
      generation.current++;
    };
  }, [settings.url, settings.sessionToken]);
  async function change(action: () => Promise<unknown>, close = false) {
    const at = generation.current;
    setBusy(true);
    setError('');
    try {
      await action();
      if (at === generation.current) {
        if (close) setDraft(null);
        await load();
      }
    } catch (e) {
      if (at === generation.current) setError((e as Error).message);
    } finally {
      if (at === generation.current) setBusy(false);
    }
  }
  return (
    <section className="surface memory-settings" aria-label="用户画像与长期记忆">
      <div className="section-title">
        <Brain size={21} />
        <h2>用户画像与长期记忆</h2>
      </div>
      <p className="field-help">
        同一账号跨对话、跨设备使用。按问题相关性召回；文件与电脑授权独立管理。
      </p>
      {page && (
        <label className="check-line">
          <input
            type="checkbox"
            role="switch"
            aria-label="启用长期记忆"
            checked={page.enabled}
            disabled={busy}
            onChange={(e) =>
              void change(() =>
                api(settings, '/memory/settings', { enabled: e.target.checked }, 'PATCH'),
              )
            }
          />
          <span>
            启用长期记忆<small>关闭后停止自动召回和 Agent 记录，已有内容仍可整理。</small>
          </span>
        </label>
      )}
      <form
        className="action-row"
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <input
          className="standard-input"
          aria-label="搜索记忆"
          placeholder="搜索记忆"
          maxLength={100}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" className="secondary" disabled={busy}>
          <RefreshCw size={15} />
          查询
        </button>
        <button
          type="button"
          className="secondary"
          disabled={busy || !page}
          onClick={() => setDraft({ key: '', content: '', kind: 'fact' })}
        >
          <Plus size={15} />
          添加
        </button>
      </form>
      {draft && (
        <form
          className="memory-editor"
          onSubmit={(e) => {
            e.preventDefault();
            const { id, ...fields } = draft;
            void change(
              () =>
                api(
                  settings,
                  id ? '/memory/' + id : '/memory',
                  id ? fields : { ...fields, id: crypto.randomUUID() },
                  id ? 'PATCH' : 'POST',
                ),
              true,
            );
          }}
        >
          <label className="field-label">
            记忆键
            <input
              className="standard-input"
              required
              maxLength={100}
              value={draft.key}
              onChange={(e) => setDraft({ ...draft, key: e.target.value })}
            />
          </label>
          <label className="field-label">
            类型
            <select
              className="standard-input"
              value={draft.kind}
              onChange={(e) => setDraft({ ...draft, kind: e.target.value as Kind })}
            >
              {Object.entries(kinds).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            内容
            <textarea
              aria-label="记忆内容"
              className="standard-input"
              required
              rows={3}
              maxLength={2000}
              value={draft.content}
              onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            />
          </label>
          <div className="action-row">
            <button className="primary" disabled={busy}>
              保存记忆
            </button>
            <button type="button" className="secondary" onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
        </form>
      )}
      {page?.items.map((m) => (
        <article className="memory-item" key={m.id}>
          <div className="section-title">
            <strong>{m.key}</strong>
            <span className="tag">{kinds[m.kind]}</span>
            <button
              className="icon-btn"
              aria-label={'编辑记忆：' + m.key}
              disabled={busy}
              onClick={() =>
                setDraft({
                  id: m.id,
                  revision: m.revision,
                  key: m.key,
                  content: m.content,
                  kind: m.kind,
                })
              }
            >
              <Pencil size={15} />
            </button>
            <button
              className="icon-btn"
              aria-label={'删除记忆：' + m.key}
              disabled={busy}
              onClick={() =>
                void change(() =>
                  api(settings, '/memory/' + m.id, { revision: m.revision }, 'DELETE'),
                )
              }
            >
              <Trash2 size={15} />
            </button>
          </div>
          <p>{m.content}</p>
          <small className="field-help">
            {m.scope === 'account' ? '账号范围' : '项目范围 · ' + m.scope} ·{' '}
            {dateLabel(m.updatedAt)} · 版本 {m.revision}
          </small>
          <details>
            <summary>来源</summary>
            <p className="field-help">
              {m.source.origin === 'manual'
                ? '手动记录'
                : m.source.origin === 'computer'
                  ? '电脑对话'
                  : '服务器对话'}
              {m.source.conversationId ? ' · ' + m.source.conversationId : ''}
            </p>
            <blockquote>{m.source.quote}</blockquote>
          </details>
        </article>
      ))}
      {page && !page.items.length && (
        <p className="field-help">暂无匹配的记忆。可手动添加，也可在对话中让助手记住明确的信息。</p>
      )}
      {page?.next && (
        <button className="secondary" disabled={busy} onClick={() => void load(page.next!)}>
          更多记忆
        </button>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
