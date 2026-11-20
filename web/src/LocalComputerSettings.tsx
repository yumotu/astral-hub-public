import { useEffect, useState } from 'react';
import { FolderPlus, Monitor, Play, ShieldCheck, Square, Trash2 } from 'lucide-react';
import { api } from './data';
import type { Settings } from './types';
import type { LocalComputerPermission, LocalComputerStatus } from './desktop-bridge';

const fullPermissions: LocalComputerPermission[] = [
  'file.read',
  'file.write',
  'terminal.execute',
  'network.outbound',
  'plugin.install',
  'dsh.workspace',
  'computer.background',
];

const permissionLabels: Array<[LocalComputerPermission, string]> = [
  ['file.read', '读取工作区文件'],
  ['file.write', '修改工作区文件'],
  ['terminal.execute', '终端与 Agent 命令'],
  ['network.outbound', '本机网络访问'],
  ['plugin.install', '安装电脑插件'],
  ['dsh.workspace', '关联 DPH 工作区'],
  ['computer.background', '后台任务持续运行'],
];

function connectionLabel(state: LocalComputerStatus | null) {
  if (!state?.configured) return '未配对';
  switch (state.connectionState) {
    case 'connecting':
      return '连接中';
    case 'online':
      return '在线';
    case 'offline':
      return '离线';
    case 'revoked':
      return '授权已撤销';
    case 'paired_stopped':
      return '已配对 · 已停止';
    default:
      return state.running ? '在线' : '已配对 · 已停止';
  }
}

function projectPermissions(project: LocalComputerStatus['projects'][number]) {
  return project.permissions?.length
    ? project.permissions
    : (['file.read', ...(project.allowWrite ? ['file.write'] : []), ...(project.allowExecute ? ['terminal.execute'] : [])] as LocalComputerPermission[]);
}

function togglePermission(permissions: LocalComputerPermission[], permission: LocalComputerPermission, enabled: boolean) {
  const next = new Set(permissions);
  if (enabled) next.add(permission);
  else next.delete(permission);
  return [...next] as LocalComputerPermission[];
}

export function LocalComputerSettings({ settings, owner }: { settings: Settings; owner: string }) {
  const bridge = window.astralDesktop?.computer;
  const identity = { server: settings.url || location.origin, owner };
  const [state, setState] = useState<LocalComputerStatus | null>(null);
  const [fullAccess, setFullAccess] = useState(true);
  const [write, setWrite] = useState(true);
  const [execute, setExecute] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!bridge) return;
    let live = true;
    const load = () =>
      void bridge
        .status(identity)
        .then((next) => {
          if (live) setState(next);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    load();
    const timer = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [bridge, identity.server, owner]);

  if (!bridge) return null;

  async function task(work: () => Promise<LocalComputerStatus>) {
    setBusy(true);
    setError('');
    try {
      const next = await work();
      if (!next.cancelled) {
        setState(next);
        window.dispatchEvent(new Event('astral:computer-changed'));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const requestedPermissions = fullAccess
    ? fullPermissions
    : ([
        'file.read',
        ...(write ? (['file.write'] as const) : []),
        ...(execute ? (['terminal.execute'] as const) : []),
      ] as LocalComputerPermission[]);

  return (
    <section className="surface local-computer-settings" aria-label="本机电脑连接">
      <div className="section-title">
        <Monitor size={19} />
        <h2>本机电脑</h2>
        <span className="tag">{connectionLabel(state)}</span>
      </div>
      <p className="field-help">
        本机电脑配对后会保留连接档。项目、文件和对话在同一目录中使用，切换项目不会重复配对。连接停止时保留历史和草稿，重新开启后继续核验。
      </p>
      {state?.configured ? (
        <>
          <p>{state.name}</p>
          <div className="action-row">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void task(() => (state.running ? bridge.stop(identity) : bridge.start(identity)))}
            >
              {state.running ? <Square size={15} /> : <Play size={15} />}
              {state.running ? '关闭本机连接' : '开启本机连接'}
            </button>
          </div>
          {state.projects.map((project) => {
            const permissions = projectPermissions(project);
            const full = fullPermissions.every((permission) => permissions.includes(permission));
            return (
              <div className="local-project-grant" key={project.id}>
                <strong>{project.name}</strong>
                <code>{project.root}</code>
                <label>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={permissions.includes('file.write')}
                    onChange={(event) =>
                      void task(() => {
                        const next = togglePermission(permissions, 'file.write', event.target.checked);
                        return bridge.grant({ ...identity, projectId: project.id, permissions: next, allowWrite: next.includes('file.write'), allowExecute: next.includes('terminal.execute') });
                      })
                    }
                  />
                  允许修改文件
                </label>
                <label>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={permissions.includes('terminal.execute')}
                    onChange={(event) =>
                      void task(() => {
                        const next = togglePermission(permissions, 'terminal.execute', event.target.checked);
                        return bridge.grant({ ...identity, projectId: project.id, permissions: next, allowWrite: next.includes('file.write'), allowExecute: next.includes('terminal.execute') });
                      })
                    }
                  />
                  允许终端和 Agent 执行命令
                </label>
                <div className="local-permission-summary">
                  <ShieldCheck size={14} />
                  <span>{full ? '完整工作权限' : '按项目授权'}</span>
                  <small>
                    {permissionLabels
                      .filter(([permission]) => permissions.includes(permission))
                      .map(([, label]) => label)
                      .join(' · ') || '读取工作区文件'}
                  </small>
                </div>
                <button className="text-link danger" disabled={busy} onClick={() => void task(() => bridge.grant({ ...identity, projectId: project.id, remove: true }))}>
                  <Trash2 size={14} />
                  撤销此目录
                </button>
              </div>
            );
          })}
        </>
      ) : null}
      <div className="local-grant-options">
        <label>
          <input
            type="checkbox"
            checked={fullAccess}
            disabled={busy}
            onChange={(event) => {
              setFullAccess(event.target.checked);
              if (event.target.checked) {
                setWrite(true);
                setExecute(true);
              }
            }}
          />
          新项目默认授予完整工作权限
        </label>
        {!fullAccess && (
          <>
            <label>
              <input type="checkbox" checked={write} disabled={busy} onChange={(event) => setWrite(event.target.checked)} />
              新项目允许修改文件
            </label>
            <label>
              <input type="checkbox" checked={execute} disabled={busy} onChange={(event) => setExecute(event.target.checked)} />
              新项目允许终端与 Agent 命令
            </label>
          </>
        )}
      </div>
      {(fullAccess || execute) && (
        <p className="field-help">
          完整工作权限仍受本机用户确认和服务器项目边界约束。命令使用此电脑当前系统用户的权限和网络，项目目录不会限制已授权 Shell。
        </p>
      )}
      <button
        className="secondary"
        disabled={busy || !state}
        onClick={() =>
          void task(async () => {
            if (state?.configured)
              return bridge.grant({ ...identity, permissionProfile: fullAccess ? 'full-workspace' : 'legacy', permissions: requestedPermissions, allowWrite: requestedPermissions.includes('file.write'), allowExecute: requestedPermissions.includes('terminal.execute') });
            const pairing = await api<{ code: string }>(settings, '/relay/pairing', {});
            return bridge.pair({ ...identity, code: pairing.code, permissionProfile: fullAccess ? 'full-workspace' : 'legacy', permissions: requestedPermissions, allowWrite: requestedPermissions.includes('file.write'), allowExecute: requestedPermissions.includes('terminal.execute') });
          })
        }
      >
        <FolderPlus size={16} />
        {busy ? '处理中…' : state?.configured ? '添加工作区项目' : '选择工作区并完成配对'}
      </button>
      {(error || state?.error) && <p className="error" role="alert">{error || state?.error}</p>}
    </section>
  );
}
