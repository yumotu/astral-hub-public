import { useEffect, useState } from 'react';
import { Monitor, Plus, RefreshCw, Link, Download } from 'lucide-react';
import { api, dateLabel } from './data';
import { peekAPI } from './resource-cache';
import { serverIdentity } from './session';
import { ToolLog } from './ToolLog';
import type { ToolRun } from './ToolLog';
import type { Settings } from './types';
import appPackage from '../../package.json';
import { LocalComputerSettings } from './LocalComputerSettings';
type Device = {
  id: string;
  name: string;
  platform: string;
  rootLabel: string;
  allowWrite: boolean;
  online: boolean;
  lastSeen: string;
};
type Job = {
  id: string;
  input: string;
  status: string;
  output: string;
  tools: ToolRun[];
  error: string | null;
  createdAt: string;
  projectId?: string;
};
export function RemoteAgentsPage({ settings, owner }: { settings: Settings; owner: string }) {
  const key = 'astral.computer.device:' + JSON.stringify([serverIdentity(settings), owner]);
  const [devices, setDevices] = useState<Device[]>(
      () => peekAPI<{ devices: Device[] }>(settings, '/relay/devices')?.devices || [],
    ),
    [selected, setSelected] = useState(() => sessionStorage.getItem(key) || ''),
    [jobs, setJobs] = useState<Job[]>([]),
    [pair, setPair] = useState<{ code: string; expiresAt: string } | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const device = devices.find((d) => d.id === selected),
    server = settings.url || location.origin;
  useEffect(() => {
    sessionStorage.setItem(key, selected);
  }, [selected, key]);
  async function refresh(fresh = false) {
    const d = await api<{ devices: Device[] }>(
      settings,
      '/relay/devices',
      undefined,
      undefined,
      false,
      { fresh },
    );
    setDevices(d.devices);
  }
  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const d = await api<{ devices: Device[] }>(settings, '/relay/devices');
        if (live) setDevices(d.devices);
        if (selected) {
          const r = await api<{ jobs: Job[] }>(settings, '/relay/jobs?deviceId=' + selected);
          if (live) setJobs(r.jobs.filter((j) => !j.projectId));
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    }
    setJobs([]);
    void load();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [settings, selected]);
  async function task(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={'computer-page' + (device ? ' has-target' : '')}>
      {!device && (
        <div className="page-heading compact">
          <div className="section-title">
            <Monitor size={24} />
            <h1>电脑连接</h1>
          </div>
          <p>在手机、网页或桌面使用目标电脑的项目、文件和任务。目标电脑主动连接服务器。</p>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <LocalComputerSettings settings={settings} owner={owner} />
      <details className="surface remote-pair" open={!devices.length || undefined}>
        <summary>
          <Link size={18} /> 连接另一台电脑
        </summary>
        <p className="field-help">
          在目标电脑安装星屿客户端，从“电脑连接 → 本机电脑”选择项目并开启，即可在各设备的智能助手中使用。也可使用下方高级命令行执行器；目录和命令权限仅在目标电脑授权。
        </p>
        <div className="action-row">
          <a
            className="secondary"
            href={'./downloads/Astral-Remote-Pi-Agent-' + appPackage.version + '.zip'}
            download
          >
            <Download size={16} />
            下载执行器
          </a>
          <button
            className="secondary"
            disabled={busy}
            onClick={() =>
              void task(async () => setPair(await api(settings, '/relay/pairing', {})))
            }
          >
            <Plus size={16} />
            生成一次性配对码
          </button>
        </div>
        {pair && (
          <div className="pair-command">
            <p>
              在解压目录运行 <code>npm install --ignore-scripts</code>，然后：
            </p>
            <pre>
              {'node relay-agent.mjs --server "' +
                server +
                '" --pair-code "' +
                pair.code +
                '" --root "你的本机项目目录"'}
            </pre>
            <p className="field-help">
              有效期至{dateLabel(pair.expiresAt)}，使用一次后失效。允许文件修改加{' '}
              <code>--allow-write</code>；允许终端与Agent执行另外加 <code>--allow-execute</code>
              ，并按执行器说明安装终端组件。执行使用本机当前用户的系统权限，项目目录不是Shell沙箱。
            </p>
          </div>
        )}
      </details>
      <section className="surface">
        <header className="computer-toolbar">
          <label>
            目标电脑
            <select
              className="standard-input"
              aria-label="目标电脑"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">选择一台已配对电脑</option>
              {devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.online ? '在线' : '离线'}
                </option>
              ))}
            </select>
          </label>
          <button
            className="icon-btn"
            aria-label="刷新执行器"
            disabled={busy}
            onClick={() => void task(() => refresh(true))}
          >
            <RefreshCw size={16} />
          </button>
        </header>
        {device ? (
          <>
            <div className="computer-toolbar computer-device-meta">
              <h2>{device.name}</h2>
              <span className="tag">{device.online ? '在线' : '离线'}</span>
              <small>最近连接 {dateLabel(device.lastSeen)}</small>
              <details>
                <summary>设备授权</summary>
                <button
                  className="text-link danger"
                  disabled={busy}
                  onClick={() =>
                    void task(async () => {
                      await api(settings, '/relay/devices/' + device.id, undefined, 'DELETE');
                      setSelected('');
                      await refresh(true);
                    })
                  }
                >
                  撤销此电脑的连接
                </button>
              </details>
            </div>
            {!!jobs.length && (
              <details>
                <summary>旧版任务记录 · 保留原共享上下文</summary>
                {jobs.map((j) => (
                  <article className="relay-job" key={j.id}>
                    <small>
                      {dateLabel(j.createdAt)} · {j.status}
                    </small>
                    <p>{j.input}</p>
                    {j.output && <pre>{j.output}</pre>}
                    {j.error && <p className="error">{j.error}</p>}
                    <ToolLog tools={j.tools} />
                  </article>
                ))}
              </details>
            )}
          </>
        ) : (
          <p className="field-help">完成配对后选择电脑，即可打开它授权的项目。</p>
        )}
      </section>
    </div>
  );
}
