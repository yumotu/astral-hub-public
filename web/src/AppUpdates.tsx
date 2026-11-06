import { useEffect, useRef, useState } from 'react';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { Download, RefreshCw, LoaderCircle, PackageCheck } from 'lucide-react';
import type { z } from 'zod';
import { updateManifestSchema, newerVersion } from '../../shared/app-updates.mjs';
import appPackage from '../../package.json';
import { downloadableRelease } from '../../shared/app-downloads.mjs';
import { api } from './data';
import type { Settings } from './types';
type Release = z.infer<typeof updateManifestSchema>;
type Progress = { state: string; received: number; total: number };
const AndroidUpdates = registerPlugin<{
  status: () => Promise<Progress>;
  download: (v: { url: string; asset: Release['assets'][number] }) => Promise<{ ready: boolean }>;
  cancel: () => Promise<void>;
  install: () => Promise<{ opened: boolean }>;
  addListener: (
    event: 'progress',
    listener: (p: Progress) => void,
  ) => Promise<PluginListenerHandle>;
}>('AppUpdates');
export function AppUpdates({ settings }: { settings: Settings }) {
  const android = Capacitor.getPlatform() === 'android' && Capacitor.isNativePlatform();
  const desktop = window.astralDesktop?.updates;
  const native = android ? AndroidUpdates : desktop;
  const [platform, setPlatform] = useState(
    android ? 'android' : navigator.userAgent.includes('Windows') ? 'win-x64' : 'mac-arm64',
  );
  const [release, setRelease] = useState<Release | null>(null),
    [webVersion, setWebVersion] = useState('');
  const [progress, setProgress] = useState<Progress>({ state: 'idle', received: 0, total: 0 });
  const [readyVersion, setReadyVersion] = useState('');
  const [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    if (desktop)
      void desktop.platform().then((p) => {
        if (mounted.current) setPlatform(p);
      });
    if (native)
      void native
        .status()
        .then((p) => {
          if (mounted.current) setProgress(p);
        })
        .catch(() => {});
    const listener = android
      ? AndroidUpdates.addListener('progress', (p) => {
          if (mounted.current) setProgress(p);
        })
      : null;
    const remove = desktop?.onProgress((p) => {
      if (mounted.current) setProgress(p);
    });
    return () => {
      mounted.current = false;
      remove?.();
      void listener?.then((h) => h.remove());
    };
  }, []);
  async function check() {
    setBusy('check');
    setError('');
    setMessage('');
    try {
      const [result, health] = await Promise.all([
        api<{ release: Release | null }>(settings, '/updates'),
        api<{ version: string }>(settings, '/health'),
      ]);
      if (!mounted.current) return;
      setRelease(result.release ? updateManifestSchema.parse(result.release) : null);
      setWebVersion(health.version);
      setMessage(
        result.release
          ? newerVersion(result.release.version, appPackage.version)
            ? `发现新版本 ${result.release.version}`
            : native ? '当前已是最新版本。' : `可下载 ${result.release.version} 的各平台客户端。`
          : '服务器正在准备原生安装包，网页可直接刷新加载服务器版本。',
      );
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy('');
    }
  }
  async function download() {
    if (!downloadableRelease(release, appPackage.version, !!native) || !release) return;
    setBusy('download');
    setReadyVersion('');
    setError('');
    setMessage('');
    try {
      const r = await api<{ path: string; asset: Release['assets'][number] }>(
        settings,
        '/updates/ticket',
        { version: release.version, platform },
      );
      const url = new URL(r.path, settings.url || location.origin).href;
      if (native) {
        await native.download({ url, asset: r.asset });
        if (mounted.current) {
          setReadyVersion(release.version);
          setMessage('下载完成，SHA-256 校验通过。');
        }
      } else {
        const link = document.createElement('a');
        link.href = url;
        link.download = r.asset.name;
        document.body.append(link);
        link.click();
        link.remove();
        setMessage('已开始下载经过服务器校验的安装包，可在浏览器下载列表中查看。');
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy('');
    }
  }
  async function install() {
    if (
      !release ||
      !newerVersion(release.version, appPackage.version) ||
      readyVersion !== release.version
    )
      return;
    setError('');
    try {
      await native?.install();
      setMessage(android ? '已打开系统安装确认。' : '已打开安装包，请按系统提示完成安装。');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const downloading = busy === 'download' || progress.state === 'downloading';
  const available = !!release && newerVersion(release.version, appPackage.version);
  const canDownload = downloadableRelease(release, appPackage.version, !!native);
  return (
    <section className="surface app-updates" aria-label="软件更新">
      <div className="section-title">
        <PackageCheck size={21} />
        <h2>软件更新</h2>
        <span className="tag">当前 {appPackage.version}</span>
      </div>
      <p className="field-help">
        在软件中检查、下载更新。安装包通过完整平台编译后提供，并核对 SHA-256；安装仍由你确认。
      </p>
      {release && canDownload && (
        <p>
          {native ? '可更新版本' : '可下载客户端'} <strong>{release.version}</strong>
        </p>
      )}
      {canDownload && release?.notes && <p className="field-help">{release.notes}</p>}
      {!native && canDownload && (
        <label className="field-label">
          安装平台
          <select
            aria-label="更新安装平台"
            className="standard-input"
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          >
            <option value="mac-arm64">Mac · Apple 芯片</option>
            <option value="mac-x64">Mac · Intel 芯片</option>
            <option value="win-x64">Windows · x64</option>
            <option value="android">Android</option>
          </select>
        </label>
      )}
      <div className="update-actions">
        <button
          type="button"
          className="secondary"
          disabled={!!busy || downloading}
          onClick={() => void check()}
        >
          {busy === 'check' ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
          {native ? '检查更新' : '获取客户端下载'}
        </button>
        {canDownload && release?.assets.some((a) => a.platform === platform) && (
          <button
            type="button"
            className="primary"
            disabled={!!busy || downloading}
            onClick={() => void download()}
          >
            <Download size={15} />
            {native ? '下载更新' : '下载客户端'} {release?.version}
          </button>
        )}
        {downloading && native && (
          <button type="button" className="secondary" onClick={() => void native.cancel()}>
            取消下载
          </button>
        )}
        {available && readyVersion === release?.version && progress.state === 'ready' && native && (
          <button type="button" className="primary" onClick={() => void install()}>
            打开安装包
          </button>
        )}
        {!native && webVersion && (
          <button type="button" className="secondary" onClick={() => location.reload()}>
            刷新加载网页 {webVersion}
          </button>
        )}
      </div>
      {downloading && (
        <label className="field-help">
          正在下载{' '}
          {Math.min(100, Math.round((progress.received / Math.max(1, progress.total)) * 100))}%
          <progress max={Math.max(1, progress.total)} value={progress.received} />
        </label>
      )}
      {message && (
        <p className="field-help" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
