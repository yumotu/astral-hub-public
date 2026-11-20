import { useEffect, useRef, useState } from 'react';
import { WandSparkles, RefreshCw, LoaderCircle, Check, Trash2 } from 'lucide-react';
import { api } from './data';
import { serverIdentity } from './session';
import { peekAPI, resourceCache, resourceKey } from './resource-cache';
import {
  waitComputerOperation,
  type ComputerPluginManifest,
  type ComputerPluginOperation,
} from './computer-api';
import { pluginPermissions, parseComputerPlugin } from '../../shared/computer-plugin.mjs';
import type { Settings } from './types';
import { ComputerOnlinePackages } from './ComputerOnlinePackages';
type Installed = { manifest: ComputerPluginManifest; sha256: string; enabled: boolean };
export function ComputerPlugins({
  settings,
  owner,
  deviceId,
  projectId,
  online,
  supportsOnline = false,
  allowExecute = false,
}: {
  settings: Settings;
  owner: string;
  deviceId: string;
  projectId: string;
  online: boolean;
  supportsOnline?: boolean;
  allowExecute?: boolean;
}) {
  const [tab, setTab] = useState<'online' | 'workflow'>('online');
  const cachePath = '/relay/plugins/' + deviceId + '/' + projectId;
  const key =
    'astral.computer.plugins:' +
    JSON.stringify([serverIdentity(settings), owner, deviceId, projectId]);
  const pendingKey = key + ':pending';
  const [items, setItems] = useState<Installed[]>(
    () => peekAPI<{ plugins: Installed[] }>(settings, cachePath)?.plugins || [],
  );
  const [wish, setWish] = useState(''),
    [draft, setDraft] = useState<ComputerPluginManifest | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function request(operation: ComputerPluginOperation) {
    if (sessionStorage.getItem(pendingKey)) throw Error('请先查看上次请求结果，避免重复注册。');
    const id = crypto.randomUUID();
    sessionStorage.setItem(pendingKey, id);
    try {
      await api(settings, '/relay/operations', { id, deviceId, projectId, operation });
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      if (status && status >= 400 && status < 500 && status !== 408)
        sessionStorage.removeItem(pendingKey);
      throw e;
    }
    const r = await waitComputerOperation(settings, id);
    sessionStorage.removeItem(pendingKey);
    if (r.status !== 'done') throw Error(r.error || '电脑未确认请求，未自动重复执行。');
    return r.result as { plugins: Installed[]; summary?: string };
  }
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await fn();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function load(fresh = false) {
    const value = await resourceCache.read(
      resourceKey(settings, cachePath),
      () => request({ kind: 'plugin_list' }),
      { ttl: 30000, force: fresh },
    );
    if (alive.current) setItems(value.plugins);
  }
  useEffect(() => {
    if (online && tab === 'workflow') void action(() => load());
  }, [deviceId, projectId, tab]);
  async function save(manifest: ComputerPluginManifest, enabled: boolean, expectedHash: string) {
    const r = await request({
      kind: 'plugin_register',
      manifest: parseComputerPlugin(manifest),
      enabled,
      expectedHash,
    });
    if (!alive.current) return;
    setItems(r.plugins);
    setStatus(r.summary || '电脑已确认保存。');
    setDraft(null);
    resourceCache.invalidate((k: string) => k === resourceKey(settings, cachePath));
    resourceCache.set(resourceKey(settings, cachePath), { plugins: r.plugins });
  }
  const permissionText = (m: ComputerPluginManifest) => {
    const p = pluginPermissions(m);
    return [
      p.write ? '修改项目文件' : '读取项目文件',
      ...(p.execute ? ['执行本机命令'] : []),
      ...(m.steps.some((s) => s.tool === 'chat_export') ? ['发送文件到聊天'] : []),
    ].join(' · ');
  };
  return (
    <section className="computer-plugins" aria-label="电脑插件">
      <nav className="computer-plugin-actions" aria-label="电脑插件类型">
        <button
          className={tab === 'online' ? 'primary' : 'secondary'}
          onClick={() => setTab('online')}
        >
          安装网上插件
        </button>
        <button
          className={tab === 'workflow' ? 'primary' : 'secondary'}
          onClick={() => setTab('workflow')}
        >
          生成工具
        </button>
      </nav>
      <div className="computer-plugin-pane" hidden={tab !== 'online'}>
        <ComputerOnlinePackages
          settings={settings}
          owner={owner}
          deviceId={deviceId}
          projectId={projectId}
          online={online}
          supported={supportsOnline}
          allowExecute={allowExecute}
        />
      </div>
      <div className="computer-plugin-pane" hidden={tab !== 'workflow'}>
        <p className="field-help">
          描述你想让电脑完成的事情，预览后注册为此项目的工具。在聊天中说出插件名称即可使用；新配置从下一任务加载。
        </p>
        {!online && (
          <p role="status" className="field-help">
            电脑离线，仍可生成和预览草稿；连接后再注册。
          </p>
        )}
        <label className="field-label" htmlFor="computer-plugin-wish">
          许愿一个电脑工具
        </label>
        <textarea
          id="computer-plugin-wish"
          className="standard-textarea"
          value={wish}
          maxLength={4000}
          placeholder="例如：检查项目目录和README；按相对路径把图片发送到聊天…"
          onChange={(e) => setWish(e.target.value)}
        />
        <div className="computer-plugin-actions">
          <button
            className="primary"
            disabled={busy || wish.trim().length < 2}
            onClick={() =>
              void action(async () => {
                const r = await api<{ manifest: ComputerPluginManifest }>(
                  settings,
                  '/relay/plugins/wish',
                  { deviceId, projectId, wish: wish.trim() },
                );
                if (alive.current) setDraft(parseComputerPlugin(r.manifest));
              })
            }
          >
            {busy ? <LoaderCircle size={16} className="spin" /> : <WandSparkles size={16} />}
            生成草稿
          </button>
          <button
            className="secondary"
            disabled={busy || !online || !!sessionStorage.getItem(pendingKey)}
            onClick={() => void action(() => load(true))}
          >
            <RefreshCw size={15} />
            刷新电脑插件
          </button>
        </div>
        {sessionStorage.getItem(pendingKey) && !busy && (
          <button
            className="text-link"
            onClick={() =>
              void action(async () => {
                const id = sessionStorage.getItem(pendingKey)!;
                const r = await waitComputerOperation(settings, id);
                sessionStorage.removeItem(pendingKey);
                if (r.status !== 'done') throw Error(r.error || '上次请求未完成，未自动重发。');
                if (alive.current) {
                  setItems(r.result.plugins || []);
                  setStatus(r.result.summary || '已取回上次请求结果。');
                  resourceCache.set(resourceKey(settings, cachePath), {
                    plugins: r.result.plugins || [],
                  });
                }
              })
            }
          >
            查看上次请求结果
          </button>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {status && (
          <p role="status" className="field-help">
            {status}
          </p>
        )}
        {draft && (
          <article className="computer-plugin-card" aria-label="电脑插件草稿预览">
            <h3>{draft.name}</h3>
            <p>{draft.description}</p>
            <small>{permissionText(draft)}</small>
            <p className="field-help">
              输入：{draft.inputLabel} · {draft.steps.length}步
            </p>
            <pre>{JSON.stringify(draft.steps, null, 2)}</pre>
            {items.some((p) => p.manifest.id === draft.id) && (
              <p className="field-help">此编号已有插件，注册将替换已显示的版本。</p>
            )}
            <button
              className="primary"
              disabled={busy || !online}
              onClick={() =>
                void action(() =>
                  save(draft, true, items.find((p) => p.manifest.id === draft.id)?.sha256 || 'new'),
                )
              }
            >
              <Check size={16} />
              注册到这台电脑的当前项目
            </button>
          </article>
        )}
        <h3>已注册 · {items.length}</h3>
        {!items.length && (
          <p className="field-help">
            还没有自定义电脑插件。目录浏览、文件读取、文件发送和环境检查可直接在聊天中使用。
          </p>
        )}
        {items.map((p) => (
          <article className="computer-plugin-card" key={p.manifest.id}>
            <h4>
              {p.manifest.name}
              <small>{p.enabled ? '已启用' : '已停用'}</small>
            </h4>
            <p>{p.manifest.description}</p>
            <small>{permissionText(p.manifest)}</small>
            <details>
              <summary>查看步骤与参数</summary>
              <pre>{JSON.stringify(p.manifest, null, 2)}</pre>
            </details>
            <div className="computer-plugin-actions">
              <button
                className="secondary"
                disabled={busy || !online}
                onClick={() => void action(() => save(p.manifest, !p.enabled, p.sha256))}
              >
                {p.enabled ? '停用' : '启用'}
              </button>
              <button
                className="text-link"
                disabled={busy || !online}
                onClick={() =>
                  void action(async () => {
                    const r = await request({
                      kind: 'plugin_remove',
                      pluginId: p.manifest.id,
                      expectedHash: p.sha256,
                    });
                    if (alive.current) {
                      setItems(r.plugins);
                      setStatus(r.summary || '已删除。');
                    }
                    resourceCache.invalidate((k: string) => k === resourceKey(settings, cachePath));
                    resourceCache.set(resourceKey(settings, cachePath), { plugins: r.plugins });
                  })
                }
              >
                <Trash2 size={14} />
                删除
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
