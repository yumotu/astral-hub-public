import { useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import type { Settings } from './types';
import { api } from './data';
import { useBackLayer } from './back-navigation';

type Item = {
  name: string;
  revision: string;
  state: string;
  description?: string;
  version?: string;
  transport?: string;
  url?: string;
  command?: string;
  args?: string[];
  envKeys?: string[];
  headerKeys?: string[];
  connection?: { state: string; tools: number };
  application?: string;
  enabled?: boolean;
};
type Catalog = {
  version: number;
  skills: Item[];
  plugins: Item[];
  mcps: Item[];
  nativePlugins: Item[];
  pending?: Preview[];
};
type Preview = {
  plan: string;
  title: string;
  target: string;
  expiresAt: number;
  scope: string;
  notice: string;
  state?: string;
  markdown?: string;
  resourceNames?: string[];
  detail?: { name?: string; version?: string; description?: string };
  configuration?: {
    transport: string;
    url?: string;
    command?: string;
    args?: string[];
    envKeys?: string[];
    headerKeys?: string[];
  };
};
export function DshExtensions({
  settings,
  owner,
  id,
  close,
  updated,
}: {
  settings: Settings;
  owner: string;
  id: string;
  close: () => void;
  updated: () => void;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [tab, setTab] = useState<'skills' | 'plugins' | 'mcps'>('skills'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [preview, setPreview] = useState<Preview | null>(null),
    [editing, setEditing] = useState<Item | null>(null),
    [name, setName] = useState(''),
    [markdown, setMarkdown] = useState(''),
    [spec, setSpec] = useState(''),
    [transport, setTransport] = useState('stdio'),
    [command, setCommand] = useState(''),
    [args, setArgs] = useState('[]'),
    [url, setUrl] = useState(''),
    [secrets, setSecrets] = useState('{}'),
    [operation, setOperation] = useState<string | null>(() => {
      try {
        const value = sessionStorage.getItem(
          `astral.dsh.extension-operation:${settings.url}:${owner}:${id}`,
        );
        return value && /^[a-f0-9-]{36}$/.test(value) ? value : null;
      } catch {
        return null;
      }
    });
  const base = '/agent/remote/conversations/' + id + '/extensions';
  const alive = useRef(true),
    lock = useRef(false);
  useBackLayer(true, close, 90);
  async function reload() {
    const value = await api<{ extensions: Catalog }>(settings, base, undefined, undefined, false, {
      fresh: true,
    });
    if (alive.current) setCatalog(value.extensions);
  }
  useEffect(() => {
    alive.current = true;
    void run(reload);
    return () => {
      alive.current = false;
    };
  }, [id]);
  async function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  function reset() {
    setEditing(null);
    setName('');
    setMarkdown('');
    setSpec('');
    setCommand('');
    setArgs('[]');
    setUrl('');
    setSecrets('{}');
    setPreview(null);
  }
  async function prepare(change: object) {
    await run(async () => {
      const r = await api<{ preview: Preview }>(settings, base + '/preview', { change });
      if (alive.current) {
        setPreview(r.preview);
        setSecrets('{}');
        setNotice('');
      }
    });
  }
  async function confirm() {
    if (!preview) return;
    await run(async () => {
      const op = crypto.randomUUID();
      setOperation(op);
      // Only the opaque operation ID is saved, never package/MCP secrets.
      sessionStorage.setItem(`astral.dsh.extension-operation:${settings.url}:${owner}:${id}`, op);
      setPreview(null);
      const r = await api<{ operation: { state: string }; result: { state: string } | null }>(
        settings,
        base + '/confirm',
        { plan: preview.plan, id: op },
      );
      if (!alive.current) return;
      setPreview(null);
      setNotice(
        r.result?.state === 'restart-required'
          ? '配置已保存，原生主机要求稍后重启才生效；没有自动重启。'
          : ['failed', 'cancelled'].includes(r.result?.state || '')
            ? '主机未应用此次更改，请刷新目录核对；没有自动重试。'
            : ['applied', 'accepted', 'observed'].includes(r.result?.state || r.operation.state)
              ? '操作已完成，请查看实际目录。'
              : '操作结果待核对，请点击核对原操作；不会重新安装。',
      );
      reset();
      await reload();
      updated();
    });
  }
  async function discard() {
    if (!preview) return;
    await run(async () => {
      await api(settings, base + '/discard', { plan: preview.plan });
      setPreview(null);
      await reload();
    });
  }
  async function checkOperation() {
    if (!operation) return;
    await run(async () => {
      const r = await api<{ result: { state: string } }>(
        settings,
        base + '/operations/' + operation,
      );
      setNotice(
        r.result.state === 'applied'
          ? '主机已确认应用。'
          : r.result.state === 'restart-required'
            ? '已保存，等待主机稍后重启。'
            : '原操作状态：' + r.result.state + '；不会重新执行。',
      );
      await reload();
      updated();
    });
  }
  const stateLabel = (s: string) =>
    ({ enabled: '已启用', disabled: '已停用', removed: '已移除，可恢复' })[s] || s;
  return (
    <div
      className="assistant-modal-backdrop dsh-workbench-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className="assistant-modal dsh-extensions-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="DSH扩展管理"
      >
        <header className="workbench-heading">
          <strong>扩展管理</strong>
          <button
            className="icon-btn"
            aria-label="刷新扩展"
            disabled={busy}
            onClick={() => void run(reload)}
          >
            <RefreshCw size={16} />
          </button>
          <button className="icon-btn" aria-label="关闭扩展管理" onClick={close}>
            <X size={18} />
          </button>
        </header>
        <p className="field-help">
          当前 DSH 主机与工作区。安装、修改或移除前会展示具体预览；运行中的任务保持继续。
        </p>
        <nav className="dsh-extension-tabs" aria-label="扩展类型">
          {(['skills', 'plugins', 'mcps'] as const).map((t) => (
            <button
              type="button"
              key={t}
              aria-pressed={tab === t}
              onClick={() => {
                setTab(t);
                reset();
              }}
            >
              {{ skills: '技能 Skill', plugins: '原生插件', mcps: 'MCP 服务' }[t]}
            </button>
          ))}
        </nav>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        {operation && (
          <button className="secondary" disabled={busy} onClick={() => void checkOperation()}>
            核对原操作
          </button>
        )}
        {!preview && !!catalog?.pending?.length && (
          <div className="dsh-extension-list">
            <h3>聊天准备的待确认更改</h3>
            {catalog.pending.map((p) => (
              <button
                key={p.plan}
                className="secondary"
                disabled={busy}
                onClick={() => setPreview(p)}
              >
                {p.title} · {p.target}
              </button>
            ))}
          </div>
        )}
        {preview ? (
          <div className="dsh-extension-preview">
            <h3>
              {preview.title} · {preview.target}
            </h3>
            <p>作用范围：{preview.scope}</p>
            {preview.state && <p>{stateLabel(preview.state)}</p>}
            {preview.detail && (
              <p>
                {preview.detail.name} {preview.detail.version} {preview.detail.description}
              </p>
            )}
            {preview.markdown && <pre>{preview.markdown}</pre>}
            {!!preview.resourceNames?.length && <p>资源：{preview.resourceNames.join('、')}</p>}
            {preview.configuration && <pre>{JSON.stringify(preview.configuration, null, 2)}</pre>}
            <p>{preview.notice}</p>
            <div className="dsh-extension-buttons">
              <button className="secondary" disabled={busy} onClick={() => void discard()}>
                取消
              </button>
              <button
                className="primary"
                disabled={busy || Date.now() >= preview.expiresAt}
                onClick={() => void confirm()}
              >
                {busy ? '正在处理…' : '确认应用'}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="dsh-extension-list">
              {!catalog ? (
                <p>{busy ? '正在读取主机扩展…' : '主机尚未提供扩展管理，请更新工具桥后刷新。'}</p>
              ) : !catalog[tab].length ? (
                <p>此工作区还没有管理过这类扩展。</p>
              ) : (
                catalog[tab].map((item) => (
                  <article key={item.name}>
                    <strong>{item.name}</strong>{' '}
                    <small>{item.version || item.description || item.transport}</small>
                    <p>
                      {stateLabel(item.state)}
                      {item.connection
                        ? ` · ${item.connection.state === 'connected' ? '已连接' : '未连接'} · ${item.connection.tools} 个工具`
                        : ''}
                      {item.application === 'restart-required' ? ' · 等待主机重启' : ''}
                    </p>
                    {item.envKeys?.length || item.headerKeys?.length ? (
                      <p>
                        已保存凭据字段：
                        {[...(item.envKeys || []), ...(item.headerKeys || [])].join('、')}
                        （值不回显）
                      </p>
                    ) : null}
                    <div className="dsh-extension-buttons">
                      {tab === 'skills' && (
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              const s = await api<{ skill: { markdown: string } }>(
                                settings,
                                base + '/skills/' + item.name,
                              );
                              setEditing(item);
                              setName(item.name);
                              setMarkdown(s.skill.markdown);
                            })
                          }
                        >
                          编辑
                        </button>
                      )}
                      {tab === 'plugins' && (
                        <button
                          className="secondary"
                          disabled={busy || item.state === 'removed'}
                          onClick={() => {
                            setEditing(item);
                            setName(item.name);
                            setSpec(item.name + '@');
                          }}
                        >
                          更新版本
                        </button>
                      )}
                      {tab === 'mcps' && (
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => {
                            setEditing(item);
                            setName(item.name);
                            setTransport(item.transport || 'stdio');
                            setCommand(item.command || '');
                            setArgs(JSON.stringify(item.args || []));
                            setUrl(item.url || '');
                            setSecrets('{}');
                          }}
                        >
                          重新配置
                        </button>
                      )}
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void prepare({
                            kind:
                              tab === 'skills'
                                ? 'skill-state'
                                : tab === 'mcps'
                                  ? 'mcp-state'
                                  : 'plugin-state',
                            name: item.name,
                            revision: item.revision,
                            state: item.state === 'enabled' ? 'disabled' : 'enabled',
                          })
                        }
                      >
                        {item.state === 'enabled'
                          ? '停用'
                          : item.state === 'removed'
                            ? '恢复'
                            : '启用'}
                      </button>
                      {item.state !== 'removed' && (
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            void prepare({
                              kind:
                                tab === 'skills'
                                  ? 'skill-state'
                                  : tab === 'mcps'
                                    ? 'mcp-state'
                                    : 'plugin-state',
                              name: item.name,
                              revision: item.revision,
                              state: 'removed',
                            })
                          }
                        >
                          移除
                        </button>
                      )}
                    </div>
                  </article>
                ))
              )}
            </div>
            <form
              className="dsh-extension-form"
              onSubmit={(e) => {
                e.preventDefault();
                if (tab === 'skills')
                  void prepare({
                    kind: 'skill-save',
                    name,
                    markdown,
                    ...(editing ? { revision: editing.revision } : {}),
                  });
                else if (tab === 'plugins')
                  void prepare(
                    editing
                      ? {
                          kind: 'plugin-update',
                          name: editing.name,
                          spec,
                          revision: editing.revision,
                        }
                      : { kind: 'plugin-install', spec },
                  );
                else {
                  try {
                    const config =
                      transport === 'stdio'
                        ? { transport, command, args: JSON.parse(args), env: JSON.parse(secrets) }
                        : { transport, url, headers: JSON.parse(secrets) };
                    void prepare({
                      kind: 'mcp-save',
                      name,
                      config,
                      ...(editing ? { revision: editing.revision } : {}),
                    });
                  } catch {
                    setError('参数或凭据格式不正确，请填写 JSON。');
                  }
                }
              }}
            >
              <h3>
                {editing
                  ? '修改 ' + editing.name
                  : tab === 'skills'
                    ? '导入技能'
                    : tab === 'plugins'
                      ? '安装原生插件'
                      : '添加 MCP'}
              </h3>
              {tab !== 'plugins' && (
                <label>
                  名称
                  <input
                    required
                    disabled={!!editing}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如 research-helper"
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  />
                </label>
              )}
              {tab === 'skills' && (
                <>
                  <label>
                    导入 SKILL.md
                    <input
                      type="file"
                      accept=".md,text/markdown,text/plain"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f && f.size <= 60000) void f.text().then(setMarkdown);
                        else if (f) setError('技能定义最多60 KB。');
                        e.target.value = '';
                      }}
                    />
                  </label>
                  <label>
                    技能内容
                    <textarea
                      required
                      value={markdown}
                      onChange={(e) => setMarkdown(e.target.value)}
                      placeholder={
                        '---\nname: research-helper\ndescription: 说明技能用途\n---\n详细执行说明'
                      }
                    />
                  </label>
                </>
              )}
              {tab === 'plugins' && (
                <label>
                  npm 包与固定版本
                  <input
                    required
                    value={spec}
                    onChange={(e) => setSpec(e.target.value)}
                    placeholder="@scope/dsh-plugin@1.2.3"
                  />
                </label>
              )}
              {tab === 'mcps' && (
                <>
                  <fieldset>
                    <legend>连接方式</legend>
                    <div className="dsh-extension-buttons">
                      {['stdio', 'streamable-http'].map((t) => (
                        <button
                          type="button"
                          key={t}
                          aria-pressed={transport === t}
                          onClick={() => setTransport(t)}
                        >
                          {t === 'stdio' ? '主机进程' : '远程 HTTP'}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  {transport === 'stdio' ? (
                    <>
                      <label>
                        主机上的可执行程序
                        <input
                          required
                          value={command}
                          onChange={(e) => setCommand(e.target.value)}
                          placeholder="例如 node 或已安装的 MCP 命令"
                        />
                      </label>
                      <label>
                        参数（JSON 数组）
                        <textarea required value={args} onChange={(e) => setArgs(e.target.value)} />
                      </label>
                    </>
                  ) : (
                    <label>
                      MCP 地址
                      <input
                        required
                        type="url"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        placeholder="https://example.com/mcp"
                      />
                    </label>
                  )}
                  <label>
                    {transport === 'stdio' ? '环境变量' : '请求头'}（JSON，凭据不回显）
                    <textarea
                      spellCheck={false}
                      autoComplete="off"
                      value={secrets}
                      onChange={(e) => setSecrets(e.target.value)}
                    />
                  </label>
                  {editing && (
                    <p className="field-help">
                      重新配置会替换旧参数和凭据，请填写需要保留的完整内容。
                    </p>
                  )}
                </>
              )}
              <div className="dsh-extension-buttons">
                {editing && (
                  <button type="button" className="secondary" onClick={reset}>
                    取消修改
                  </button>
                )}
                <button className="primary" disabled={busy || !catalog}>
                  {busy ? '正在读取…' : '查看操作预览'}
                </button>
              </div>
            </form>
            {tab === 'plugins' && !!catalog?.nativePlugins.length && (
              <details>
                <summary>主机原有插件（保留原配置）</summary>
                {catalog.nativePlugins
                  .filter((p) => !catalog.plugins.some((m) => m.name === p.name))
                  .map((p) => (
                    <p key={p.name}>
                      {p.name} {p.version} · {p.enabled ? '已启用' : '未启用'}
                    </p>
                  ))}
              </details>
            )}
          </>
        )}
      </section>
    </div>
  );
}
