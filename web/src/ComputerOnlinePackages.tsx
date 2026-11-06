import { useEffect, useRef, useState } from 'react';
import {
  Download,
  Search,
  RefreshCw,
  LoaderCircle,
  RotateCcw,
  Trash2,
  ExternalLink,
} from 'lucide-react';
import { api } from './data';
import { serverIdentity } from './session';
import { peekAPI, resourceCache, resourceKey } from './resource-cache';
import { waitComputerOperation, type OnlinePackageOperation } from './computer-api';
import { packageAuthority } from '../../shared/computer-package.mjs';
import type { Settings } from './types';
type Package = { name: string; version: string; integrity: string; enabled?: boolean };
type Preview = Package & {
  previewId: string;
  description: string;
  reason: string;
  limitations: string;
  npmUrl: string;
  repository: string;
  hasInstallScripts: boolean;
  dependencies: string[];
  resources: string[];
  engines: Record<string, string>;
};
type Snapshot = {
  revision: string;
  packages: Package[];
  canRollback: boolean;
  activation?: { extensions?: number; tools?: string[]; skills?: string[]; warnings?: string[] };
  summary?: string;
};
export function ComputerOnlinePackages({
  settings,
  owner,
  deviceId,
  projectId,
  online,
  supported,
  allowExecute,
}: {
  settings: Settings;
  owner: string;
  deviceId: string;
  projectId: string;
  online: boolean;
  supported: boolean;
  allowExecute: boolean;
}) {
  const cachePath = '/relay/online-packages/' + deviceId + '/' + projectId;
  const pendingKey =
    'astral.online-packages.pending:' +
    JSON.stringify([serverIdentity(settings), owner, deviceId, projectId]);
  const [state, setState] = useState<Snapshot>(
    () =>
      peekAPI<Snapshot>(settings, cachePath) || {
        revision: 'new',
        packages: [],
        canRollback: false,
      },
  );
  const [wish, setWish] = useState(''),
    [previews, setPreviews] = useState<Preview[]>([]),
    [ack, setAck] = useState('');
  const [busy, setBusy] = useState(''),
    [message, setMessage] = useState(''),
    [error, setError] = useState('');
  const alive = useRef(true),
    pending = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  function remember(result: Snapshot) {
    resourceCache.set(resourceKey(settings, cachePath), result);
    if (alive.current) {
      setState(result);
      setMessage(result.summary || '已读取这台电脑的插件组合。');
    }
  }
  async function receipt(id: string) {
    const r = await waitComputerOperation(settings, id);
    sessionStorage.removeItem(pendingKey);
    if (r.status !== 'done') throw Error(r.error || '电脑未确认结果，未自动重放。');
    remember(r.result as Snapshot);
  }
  async function request(operation: OnlinePackageOperation) {
    if (sessionStorage.getItem(pendingKey)) throw Error('请先查看上次请求结果，避免重复安装。');
    const id = crypto.randomUUID();
    sessionStorage.setItem(pendingKey, id);
    try {
      await api(settings, '/relay/operations', { id, deviceId, projectId, operation });
    } catch (e) {
      const code = (e as Error & { status?: number }).status;
      if (code && code >= 400 && code < 500 && code !== 408) sessionStorage.removeItem(pendingKey);
      throw e;
    }
    await receipt(id);
  }
  async function action(label: string, fn: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(label);
    setMessage('');
    setError('');
    try {
      await fn();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      pending.current = false;
      if (alive.current) setBusy('');
    }
  }
  useEffect(() => {
    if (online && supported && !sessionStorage.getItem(pendingKey) && !peekAPI(settings, cachePath))
      void action('读取电脑插件', () => request({ kind: 'package_list' }));
  }, [deviceId, projectId, supported, online]);
  const writable = online && supported && allowExecute && !busy;
  return (
    <div className="computer-online-packages" aria-label="网上插件许愿安装">
      <p className="field-help">
        描述想做的事情，AI会从npm查找已有Pi插件。先核对推荐、来源和权限，再安装到这台电脑的当前项目。
      </p>
      <label className="field-label" htmlFor="online-package-wish">
        想安装什么能力
      </label>
      <textarea
        id="online-package-wish"
        className="standard-textarea"
        value={wish}
        maxLength={4000}
        placeholder="例如：我想读取Word和PPT、制作演示文稿，帮我找现成插件"
        onChange={(e) => setWish(e.target.value)}
      />
      <div className="computer-plugin-actions">
        <button
          className="primary"
          disabled={!!busy || wish.trim().length < 2}
          onClick={() =>
            void action('查找网上插件', async () => {
              const r = await api<{ packages: Preview[]; message: string }>(
                settings,
                '/relay/packages/wish',
                { deviceId, projectId, wish: wish.trim() },
                undefined,
                false,
                { timeout: 120000 },
              );
              if (alive.current) {
                setPreviews(r.packages);
                setMessage(r.message);
                setAck('');
              }
            })
          }
        >
          <Search size={16} />
          查找推荐
        </button>
        <button
          className="secondary"
          disabled={!!busy || !online || !supported}
          onClick={() => void action('读取电脑插件', () => request({ kind: 'package_list' }))}
        >
          <RefreshCw size={15} />
          刷新已安装
        </button>
      </div>
      {!supported && (
        <p className="field-help">
          这台电脑的执行器尚不支持网上插件。请在电脑同步0.8.5执行器，保留原设备配置后重启；仍可先查找推荐。
        </p>
      )}
      {!allowExecute && (
        <p className="field-help">
          本机尚未为此项目授予命令执行权限。推荐和预览可用，安装/启用需要先在目标电脑授权。
        </p>
      )}
      {!online && <p className="field-help">电脑离线。查找推荐可用，连接后再安装。</p>}
      {busy && (
        <p role="status">
          <LoaderCircle size={16} className="spin" /> {busy}…
        </p>
      )}
      {message && (
        <p className="field-help" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {sessionStorage.getItem(pendingKey) && !busy && (
        <button
          className="text-link"
          onClick={() =>
            void action('查询上次请求', () => receipt(sessionStorage.getItem(pendingKey)!))
          }
        >
          查看上次请求结果
        </button>
      )}
      {previews.map((p) => (
        <article
          className="computer-plugin-card"
          key={p.previewId}
          aria-label={'安装预览 ' + p.name}
        >
          <h3>
            {p.name} <span className="tag">{p.version}</span>
          </h3>
          <p>{p.description}</p>
          <p>{p.reason}</p>
          {p.limitations && <p className="field-help">适配说明：{p.limitations}</p>}
          <div className="computer-plugin-actions">
            <a href={p.npmUrl} target="_blank" rel="noopener noreferrer">
              npm来源 <ExternalLink size={13} />
            </a>
            {p.repository && (
              <a href={p.repository} target="_blank" rel="noopener noreferrer">
                源码仓库 <ExternalLink size={13} />
              </a>
            )}
          </div>
          <p className="field-help">
            固定版本并核对SHA-512；依赖安装脚本关闭。
            {p.hasInstallScripts ? '此包声明了安装脚本，部分功能可能需要额外适配。' : ''}
            加载检查验证Pi资源注册，运行时依赖以实际调用为准；第三方终端交互界面不保证兼容。
          </p>
          <details>
            <summary>包信息与依赖</summary>
            <p>资源：{p.resources.join('、') || '由安装后的Pi加载检查确认'}</p>
            <p>
              运行环境：
              {Object.entries(p.engines)
                .map(([k, v]) => k + ' ' + v)
                .join('、') || '未声明'}
            </p>
            <p>直接依赖：{p.dependencies.join('、') || '未声明'}</p>
            <p className="computer-package-integrity">{p.integrity}</p>
          </details>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={ack === p.previewId}
              onChange={(e) => setAck(e.target.checked ? p.previewId : '')}
            />
            <span>{packageAuthority}</span>
          </label>
          <button
            className="primary"
            disabled={!writable || ack !== p.previewId || !!sessionStorage.getItem(pendingKey)}
            onClick={() =>
              void action('电脑正在下载并检查插件', async () => {
                await request({
                  kind: 'package_install',
                  previewId: p.previewId,
                  expectedRevision: state.revision,
                  confirmed: true,
                });
                if (alive.current) {
                  setPreviews((old) => old.filter((x) => x.previewId !== p.previewId));
                  setAck('');
                }
              })
            }
          >
            <Download size={16} />
            安装到此电脑项目
          </button>
        </article>
      ))}
      <h3>此电脑项目已安装</h3>
      {!state.packages.length && (
        <p className="field-help">还没有安装网上插件。生成的电脑工作流在“生成工具”中管理。</p>
      )}
      {state.packages.map((p) => (
        <article className="computer-plugin-card" key={p.name}>
          <h4>{p.name}</h4>
          <small>
            {p.version} · {p.enabled ? '已启用' : '已停用'}
          </small>
          <div className="computer-plugin-actions">
            <button
              className="secondary"
              disabled={!writable}
              onClick={() =>
                void action('更新插件启用状态', () =>
                  request({
                    kind: 'package_enable',
                    name: p.name,
                    enabled: !p.enabled,
                    expectedRevision: state.revision,
                  }),
                )
              }
            >
              {p.enabled ? '停用' : '启用'}
            </button>
            <button
              className="text-link"
              disabled={!writable}
              onClick={() =>
                void action('移除插件', () =>
                  request({
                    kind: 'package_remove',
                    name: p.name,
                    expectedRevision: state.revision,
                  }),
                )
              }
            >
              <Trash2 size={14} />
              移除
            </button>
          </div>
        </article>
      ))}
      {!!state.packages.length && (
        <p className="field-help">
          加载检查：{state.activation?.extensions || 0}个扩展，
          {state.activation?.tools?.length || 0}个工具，{state.activation?.skills?.length || 0}
          个技能。仅在本机允许、且聊天勾选“执行命令”的新任务中加载。
        </p>
      )}
      {state.activation?.warnings?.map((w, i) => (
        <p key={i} className="field-help">
          {w}
        </p>
      ))}
      {state.canRollback && (
        <button
          className="secondary"
          disabled={!writable}
          onClick={() =>
            void action('恢复上一插件组合', () =>
              request({
                kind: 'package_rollback',
                expectedRevision: state.revision,
                confirmed: true,
              }),
            )
          }
        >
          <RotateCcw size={15} />
          恢复上一插件组合
        </button>
      )}
    </div>
  );
}
