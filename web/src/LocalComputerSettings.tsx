import { useEffect, useState } from 'react';
import { Monitor, FolderPlus, Play, Square, Trash2 } from 'lucide-react';
import { api } from './data';
import type { Settings } from './types';
import type { LocalComputerStatus } from './desktop-bridge';

export function LocalComputerSettings({ settings, owner }: { settings: Settings; owner: string }) {
  const bridge = window.astralDesktop?.computer;
  const identity = { server: settings.url || location.origin, owner };
  const [state, setState] = useState<LocalComputerStatus | null>(null);
  const [write, setWrite] = useState(false), [execute, setExecute] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!bridge) return;
    let live = true;
    const load = () => void bridge.status(identity).then(s => { if(live)setState(s); }).catch(e => { if(live)setError(e.message); });
    load(); const timer = setInterval(load, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [bridge, identity.server, owner]);
  if (!bridge) return null;
  async function task(work: () => Promise<LocalComputerStatus>) {
    setBusy(true); setError('');
    try { const next = await work(); if (!next.cancelled) { setState(next); window.dispatchEvent(new Event('astral:computer-changed')); } }
    catch(e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <section className="surface local-computer-settings" aria-label="本机电脑连接">
    <div className="section-title"><Monitor size={19}/><h2>本机电脑</h2><span className="tag">{state?.running ? '已开启' : '未开启'}</span></div>
    <p className="field-help">客户端已内置电脑执行器。选择允许访问的项目后，本机与远程设备都从智能助手的同一项目/对话界面使用。关闭应用会停止本机连接，下次启动按你保存的开启状态恢复。</p>
    {state?.configured ? <>
      <p>{state.name}</p>
      <div className="action-row"><button className="secondary" disabled={busy} onClick={() => void task(() => state.running ? bridge!.stop(identity) : bridge!.start(identity))}>{state.running ? <Square size={15}/> : <Play size={15}/>}{state.running ? '关闭本机连接' : '开启本机连接'}</button></div>
      {state.projects.map(p => <div className="local-project-grant" key={p.id}>
        <strong>{p.name}</strong><code>{p.root}</code>
        <label><input type="checkbox" disabled={busy} checked={p.allowWrite} onChange={e => void task(() => bridge!.grant({...identity,projectId:p.id,allowWrite:e.target.checked,allowExecute:p.allowExecute}))}/>允许修改文件</label>
        <label><input type="checkbox" disabled={busy} checked={p.allowExecute} onChange={e => void task(() => bridge!.grant({...identity,projectId:p.id,allowWrite:p.allowWrite,allowExecute:e.target.checked}))}/>允许终端和Agent执行命令</label>
        <button className="text-link danger" disabled={busy} onClick={() => void task(() => bridge!.grant({...identity,projectId:p.id,remove:true}))}><Trash2 size={14}/>撤销此目录</button>
      </div>)}
    </> : null}
    <div className="local-grant-options"><label><input type="checkbox" checked={write} disabled={busy} onChange={e=>setWrite(e.target.checked)}/>新项目允许修改文件</label><label><input type="checkbox" checked={execute} disabled={busy} onChange={e=>setExecute(e.target.checked)}/>新项目允许终端与Agent命令</label></div>
    {execute && <p className="field-help">命令使用此电脑当前系统用户的权限和网络；项目目录不会限制已授权Shell，服务器Bash联网开关不控制此电脑。</p>}
    <button className="secondary" disabled={busy || !state} onClick={() => void task(async () => {
      if(state?.configured)return bridge!.grant({...identity,allowWrite:write,allowExecute:execute});
      const pairing=await api<{code:string}>(settings,'/relay/pairing',{});
      return bridge!.pair({...identity,code:pairing.code,allowWrite:write,allowExecute:execute});
    })}><FolderPlus size={16}/>{busy ? '处理中…' : state?.configured ? '添加本机项目' : '选择项目并开启本机连接'}</button>
    {(error || state?.error) && <p className="error" role="alert">{error || state?.error}</p>}
  </section>;
}
