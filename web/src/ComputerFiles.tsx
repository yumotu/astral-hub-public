import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Download,
  FileText,
  Folder,
  LoaderCircle,
  RefreshCw,
  Save,
  Undo2,
} from 'lucide-react';
import { api } from './data';
import { resourceCache, resourceKey, peekAPI, invalidateAPI } from './resource-cache';
import { serverIdentity } from './session';
import type { Settings } from './types';
import type { ComputerProject, ComputerOperation, OperationResult } from './computer-api';
import { waitComputerOperation } from './computer-api';
import { readComputerDraft, computerFileDraft } from '../../shared/computer-draft.mjs';
const FilePreview = lazy(() => import('./FilePreview'));
type Entry = { name: string; path: string; type: string };
type Document = {
  path: string;
  content: string;
  sha256: string;
  readOnly: boolean;
  redacted?: boolean;
};
export function ComputerFiles({
  settings,
  owner,
  deviceId,
  project,
}: {
  settings: Settings;
  owner: string;
  deviceId: string;
  project: ComputerProject;
}) {
  const prefix = '/relay/files/' + deviceId + '/' + project.id + '/',
    key =
      'astral.computer.files:' +
      JSON.stringify([serverIdentity(settings), owner, deviceId, project.id]);
  const [saved] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(key) || '{}');
    } catch {
      return {};
    }
  });
  const [savedDraft] = useState(() => readComputerDraft(sessionStorage, key + ':draft'));
  const [path, setPath] = useState<string>(saved.path || '.'),
    [entries, setEntries] = useState<Entry[]>(
      () =>
        peekAPI<{ entries: Entry[] }>(
          settings,
          prefix + 'list/' + encodeURIComponent(saved.path || '.'),
        )?.entries || [],
    ),
    [file, setFile] = useState<Document | null>(savedDraft?.file || null),
    [text, setText] = useState(savedDraft?.text || ''),
    [backup, setBackup] = useState<string>(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [preview, setPreview] = useState<{ id: string; name: string; blob: Blob } | null>(null);
  const alive = useRef(true),
    view = useRef(0),
    pendingKey = key + ':pending';
  const listView = useRef({ path, revision });
  useEffect(() => {
    try {
      if (file && text !== file.content)
        sessionStorage.setItem(key + ':draft', JSON.stringify(computerFileDraft(file, text)));
      else sessionStorage.removeItem(key + ':draft');
    } catch {
      /* An unavailable session store must not block file editing. */
    }
  }, [key, file, text]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const finish = (r: OperationResult) => {
    if (r.status !== 'done') throw Error(r.error || '电脑请求未完成，未自动重复执行。');
    return r.result;
  };
  async function request(op: ComputerOperation, id = crypto.randomUUID()) {
    const pending = sessionStorage.getItem(pendingKey);
    if (pending && JSON.parse(pending).id !== id)
      throw Error('请先查看上次请求的结果，避免重复操作。');
    sessionStorage.setItem(pendingKey, JSON.stringify({ id, operation: op }));
    try {
      await api(settings, '/relay/operations', {
        id,
        deviceId,
        projectId: project.id,
        operation: op,
      });
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      if (status && status >= 400 && status < 500 && status !== 408)
        sessionStorage.removeItem(pendingKey);
      throw e;
    }
    const r = await waitComputerOperation(settings, id);
    sessionStorage.removeItem(pendingKey);
    return finish(r);
  }
  useEffect(() => {
    let live = true;
    const version = ++view.current;
    sessionStorage.setItem(key, JSON.stringify({ path }));
    if (listView.current.path !== path || listView.current.revision !== revision) setFile(null);
    listView.current = { path, revision };
    setError('');
    const cachePath = prefix + 'list/' + encodeURIComponent(path),
      cached = peekAPI<{ entries: Entry[] }>(settings, cachePath);
    setEntries(cached?.entries || []);
    setBusy(true);
    void resourceCache
      .read(resourceKey(settings, cachePath), () => request({ kind: 'list', path }), {
        ttl: 30000,
        force: false,
      })
      .then((r: any) => {
        if (live && view.current === version) setEntries(r.entries);
      })
      .catch((e: Error) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [settings, project.id, path, revision]);
  async function action(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function downloadBlob(name: string, blob: Blob) {
    const url = URL.createObjectURL(blob),
      a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  async function binary(name: string, download = false) {
    const r = await request({ kind: 'download', path: name }),
      bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0)),
      blob = new Blob([bytes]);
    if (!alive.current) return;
    if (download) downloadBlob(name.split('/').at(-1) || name, blob);
    else setPreview({ id: crypto.randomUUID(), name: name.split('/').at(-1) || name, blob });
  }
  async function open(e: Entry) {
    if (e.type === 'directory') {
      setPath(e.path);
      return;
    }
    await action(async () => {
      if (
        /\.(?:txt|md|markdown|json|[cm]?js|jsx|tsx?|css|html?|py|ya?ml|toml|xml|csv|sh|rs|go|java|c|cpp|h|ini)$/i.test(
          e.name,
        ) ||
        /^(?:README|LICENSE|Makefile)$/i.test(e.name)
      ) {
        const cachePath = prefix + 'read/' + encodeURIComponent(e.path);
        const r = (await resourceCache.read(
          resourceKey(settings, cachePath),
          () => request({ kind: 'read', path: e.path }),
          { ttl: 30000 },
        )) as Document;
        if (alive.current) {
          setFile(r);
          setText(r.content);
        }
      } else await binary(e.path);
    });
  }
  return (
    <section className="computer-files" aria-label="电脑项目文件">
      <div className="computer-toolbar">
        <strong>文件</strong>
        <button
          className="icon-btn"
          aria-label="返回上一级电脑文件夹"
          disabled={busy || path === '.'}
          onClick={() => setPath(path.includes('/') ? path.split('/').slice(0, -1).join('/') : '.')}
        >
          <ArrowLeft size={16} />
        </button>
        <span title={path}>{path}</span>
        <button
          className="icon-btn"
          aria-label="刷新电脑文件"
          disabled={busy}
          onClick={() => {
            invalidateAPI(settings, prefix);
            setRevision((n) => n + 1);
          }}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {busy && (
        <p role="status">
          <LoaderCircle className="spin" size={16} /> 等待目标电脑响应…
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {sessionStorage.getItem(pendingKey) && !busy && (
        <button
          className="secondary"
          onClick={() =>
            void action(async () => {
              const p = JSON.parse(sessionStorage.getItem(pendingKey) || '{}');
              const r = await waitComputerOperation(settings, p.id);
              sessionStorage.removeItem(pendingKey);
              finish(r);
              setRevision((n) => n + 1);
            })
          }
        >
          查看上次请求
        </button>
      )}
      <div className="computer-file-list">
        {entries.map((e) => (
          <button
            key={e.path}
            className="computer-file-row"
            disabled={busy}
            onClick={() => void open(e)}
          >
            {e.type === 'directory' ? <Folder size={16} /> : <FileText size={16} />}
            <span>{e.name}</span>
          </button>
        ))}
        {!entries.length && !busy && <p className="field-help">此目录没有可显示文件。</p>}
      </div>
      {file && (
        <section className="computer-editor">
          <header className="computer-toolbar">
            <strong>{file.path}</strong>
            <button
              className="icon-btn"
              aria-label="下载电脑文件"
              disabled={busy}
              onClick={() => void action(() => binary(file.path, true))}
            >
              <Download size={16} />
            </button>
          </header>
          <textarea
            className="standard-input"
            aria-label="电脑文件内容"
            value={text}
            disabled={busy}
            readOnly={project.readOnly || file.readOnly}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
          />
          <div className="action-row">
            <button
              className="primary"
              disabled={busy || project.readOnly || file.readOnly || text === file.content}
              onClick={() =>
                void action(async () => {
                  const r = await request({
                    kind: 'write',
                    path: file.path,
                    content: text,
                    expectedHash: file.sha256,
                  });
                  invalidateAPI(settings, prefix);
                  if (alive.current) {
                    setBackup(r.backupId || '');
                    setFile({ ...file, content: text, sha256: r.sha256 });
                  }
                })
              }
            >
              <Save size={16} /> 保存并备份
            </button>
            {backup && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await request({ kind: 'restore', backupId: backup });
                    invalidateAPI(settings, prefix);
                    if (alive.current) {
                      setBackup('');
                      setFile(null);
                      setRevision((n) => n + 1);
                    }
                  })
                }
              >
                <Undo2 size={16} /> 恢复上次备份
              </button>
            )}
          </div>
          <p className="field-help">
            {project.readOnly || file.readOnly
              ? '此文件仅允许预览。'
              : '保存前核对原文件哈希，目标电脑变化时拒绝覆盖。'}{' '}
            下载/非文本预览支持1 MiB以内文件。
          </p>
        </section>
      )}
      {preview && (
        <Suspense fallback={<p>正在准备预览…</p>}>
          <FilePreview
            file={{ id: preview.id, name: preview.name, bytes: preview.blob.size }}
            settings={settings}
            conversation=""
            blob={preview.blob}
            close={() => setPreview(null)}
            download={async () => downloadBlob(preview.name, preview.blob)}
          />
        </Suspense>
      )}
    </section>
  );
}
