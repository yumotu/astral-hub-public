import { useEffect, useState } from 'react';
import { FolderPlus, Monitor, RefreshCw } from 'lucide-react';
import { ConversationDialog } from './ConversationMenu';
import { matchesLocalProjectComputer } from '../../shared/computer-project-setup.mjs';
import type { LocalComputerPermission, LocalComputerStatus } from './desktop-bridge';
import type { Settings } from './types';
import './computer-project-setup.css';

export type ProjectSetupComputer = {
  name: string;
  target: { origin: 'computer'; deviceId: string } | { origin: 'remote'; connectionId: string };
};

export function ComputerProjectSetup({
  computers,
  settings,
  owner,
  close,
  refresh,
  manage,
  directoryError,
}: {
  computers: ProjectSetupComputer[];
  settings: Settings;
  owner: string;
  close: () => void;
  refresh: () => Promise<void>;
  manage: () => void;
  directoryError?: string;
}) {
  const [selection, setSelection] = useState(0),
    [busy, setBusy] = useState(false);
  const selected = computers[selection];
  return (
    <ConversationDialog
      title="添加电脑项目"
      close={() => {
        if (!busy) close();
      }}
      className="computer-project-setup"
    >
      {computers.length > 1 && (
        <div className="conversation-targets" aria-label="选择电脑连接">
          {computers.map((computer, index) => (
            <button
              key={JSON.stringify(computer.target)}
              type="button"
              disabled={busy}
              aria-pressed={index === selection}
              onClick={() => setSelection(index)}
            >
              {computer.name} · {computer.target.origin === 'computer' ? 'Pi' : 'DPH'}
            </button>
          ))}
        </div>
      )}
      {selected && (
        <ProjectSetupDetails
          key={JSON.stringify(selected.target)}
          computer={selected}
          settings={settings}
          owner={owner}
          refresh={refresh}
          directoryError={directoryError}
          busy={busy}
          setBusy={setBusy}
          manage={() => {
            close();
            manage();
          }}
        />
      )}
    </ConversationDialog>
  );
}

function ProjectSetupDetails({
  computer,
  settings,
  owner,
  refresh,
  busy,
  setBusy,
  manage,
  directoryError,
}: {
  computer: ProjectSetupComputer;
  settings: Settings;
  owner: string;
  refresh: () => Promise<void>;
  busy: boolean;
  setBusy: (value: boolean) => void;
  manage: () => void;
  directoryError?: string;
}) {
  const bridge = window.astralDesktop?.computer;
  const server = settings.url || location.origin;
  const identity = { server, owner };
  const [status, setStatus] = useState<LocalComputerStatus | null>(null);
  const [checking, setChecking] = useState(!!bridge && computer.target.origin === 'computer');
  const [fullAccess, setFullAccess] = useState(true),
    [write, setWrite] = useState(true),
    [execute, setExecute] = useState(true);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    if (!bridge || computer.target.origin !== 'computer') return;
    let live = true;
    void bridge
      .status({ server, owner })
      .then((value) => {
        if (live) setStatus(value);
      })
      .catch((e) => {
        if (live) setError((e as Error).message);
      })
      .finally(() => {
        if (live) setChecking(false);
      });
    return () => {
      live = false;
    };
  }, [bridge, server, owner, computer.target]);
  const local = matchesLocalProjectComputer(computer.target, status, server);
  async function readDirectory() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await refresh();
      setNotice('目录刷新已结束，请查看项目列表。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function addLocalProject() {
    if (!bridge || !local) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      // Recheck immediately before opening a picker. A same-name remote device
      // or a changed desktop pairing must never receive this local grant.
      const current = await bridge.status(identity);
      if (!matchesLocalProjectComputer(computer.target, current, server)) {
        setStatus(current);
        throw Error('本机连接已变化，请在所选电脑上添加项目，再刷新目录。');
      }
      const permissions: LocalComputerPermission[] = fullAccess
        ? [
            'file.read',
            'file.write',
            'terminal.execute',
            'network.outbound',
            'plugin.install',
            'dsh.workspace',
            'computer.background',
          ]
        : (['file.read', ...(write ? ['file.write'] : []), ...(execute ? ['terminal.execute'] : [])] as LocalComputerPermission[]);
      const next = await bridge.grant({
        ...identity,
        permissionProfile: fullAccess ? 'full-workspace' : 'legacy',
        permissions,
        allowWrite: permissions.includes('file.write'),
        allowExecute: permissions.includes('terminal.execute'),
      });
      if (next.cancelled) return;
      setStatus(next);
      window.dispatchEvent(new Event('astral:computer-changed'));
      setNotice('本机目录已添加，正在读取项目列表…');
      await refresh();
      setNotice('本机目录已添加。若尚未显示，稍后刷新项目目录即可。');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <p className="computer-project-setup-target">
        <Monitor size={17} />
        <strong>{computer.name}</strong>
        <span>{computer.target.origin === 'computer' ? 'Pi' : 'DPH'}</span>
      </p>
      {checking ? (
        <p role="status">正在核对本机连接…</p>
      ) : local ? (
        <>
          <p>选择这台电脑上允许访问的项目文件夹。已有项目和权限保持原样。</p>
          <label className="computer-project-setup-option">
            <input
              type="checkbox"
              checked={fullAccess}
              disabled={busy}
              onChange={(e) => {
                setFullAccess(e.target.checked);
                if (e.target.checked) {
                  setWrite(true);
                  setExecute(true);
                }
              }}
            />
            新项目授予完整工作权限
          </label>
          {!fullAccess && (
            <>
              <label className="computer-project-setup-option">
                <input
                  type="checkbox"
                  checked={write}
                  disabled={busy}
                  onChange={(e) => setWrite(e.target.checked)}
                />
                允许修改新项目文件
              </label>
              <label className="computer-project-setup-option">
                <input
                  type="checkbox"
                  checked={execute}
                  disabled={busy}
                  onChange={(e) => setExecute(e.target.checked)}
                />
                允许新项目终端与 Agent 执行命令
              </label>
            </>
          )}
          {(fullAccess || execute) && (
            <p className="field-help">
              命令使用此电脑当前系统用户的权限和网络；项目目录不会限制已授权 Shell。
            </p>
          )}
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void addLocalProject()}
          >
            <FolderPlus size={16} />
            选择本机项目文件夹
          </button>
        </>
      ) : computer.target.origin === 'computer' ? (
        <>
          <p>请在「{computer.name}」上添加允许访问的文件夹，已有配对会继续使用。</p>
          <ol>
            <li>使用星屿电脑客户端：在智能助手中打开「管理电脑连接」，找到「本机电脑」，点击「添加本机项目」。</li>
            <li>
              使用独立执行器：在该电脑的执行器目录运行下方命令，把路径换成实际项目文件夹。若使用自定义配置，请同时传入原来的{' '}
              <code>--config</code> 路径。
            </li>
          </ol>
          <pre>
            <code>node relay-agent.mjs --add-project "/实际项目路径"</code>
          </pre>
          <p className="field-help">
            默认只读。仅在需要时附加 <code>--allow-write</code> 或 <code>--allow-execute</code>
            。目录授权完成后，回到这里刷新即可。
          </p>
        </>
      ) : (
        <>
          <p>
            请在「{computer.name}」的 DeepSeek Harness 中添加或打开工作区，并确保该工作区通过已有
            Remote 连接可见。
          </p>
          <p className="field-help">
            添加完成后刷新目录，工作区就会出现在这台电脑下。星屿目前读取已有 DPH
            工作区，不会替你创建远程目录或扩大主机权限。
          </p>
        </>
      )}
      <div className="action-row">
        <button
          type="button"
          className="secondary"
          disabled={busy || checking}
          onClick={() => void readDirectory()}
        >
          <RefreshCw size={15} />
          刷新项目目录
        </button>
        <button type="button" className="text-link" disabled={busy} onClick={manage}>
          打开电脑连接设置
        </button>
      </div>
      {notice && !directoryError && <p role="status">{notice}</p>}
      {(error || directoryError) && (
        <p className="error" role="alert">
          {error || directoryError}
        </p>
      )}
    </>
  );
}
