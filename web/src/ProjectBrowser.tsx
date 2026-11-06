import { useEffect, useState } from 'react';
import { Folder, FileText, ArrowLeft, ArrowRight, Search, LoaderCircle } from 'lucide-react';
import { api } from './data';
import type { Settings } from './types';
export type ServerProject = {
  id: string;
  name: string;
  serverPath: string;
  readOnly: boolean;
  description: string;
  source?: boolean;
  userRoot?: boolean;
  ownerId?: string;
  memberAccess?: 'read' | 'edit';
  grants?: { projectId: string; access: 'read' | 'edit' }[];
};
export function ProjectBrowser({
  settings,
  project,
  ask,
  openFile,
}: {
  settings: Settings;
  project: ServerProject;
  ask: (text: string) => void;
  openFile?: (path: string) => void;
}) {
  const [path, setPath] = useState('.'),
    [entries, setEntries] = useState<{ name: string; path: string; type: string }[]>([]),
    [file, setFile] = useState<{
      path: string;
      content: string;
      sha256: string;
      truncated: boolean;
    } | null>(null),
    [query, setQuery] = useState(''),
    [matches, setMatches] = useState<{ path: string; line: number; text: string }[] | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const base = '/pi/projects/' + project.id;
  useEffect(() => {
    let alive = true;
    setFile(null);
    setMatches(null);
    setError('');
    setBusy(true);
    api<{ entries: typeof entries }>(settings, base + '/list?path=' + encodeURIComponent(path))
      .then((r) => {
        if (alive) setEntries(r.entries);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [project.id, path, settings]);
  async function read(path: string) {
    if (openFile) {
      openFile(path);
      return;
    }
    setBusy(true);
    setError('');
    try {
      setFile(await api(settings, base + '/read?path=' + encodeURIComponent(path)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="surface project-browser">
      <div className="section-title">
        <Folder size={19} />
        <h2>{project.name}</h2>
        <span className="tag">{project.readOnly ? '只读' : '支持修改'}</span>
      </div>
      <p className="field-help">
        {project.serverPath} · {project.description}
      </p>
      {error && <div className="error">{error}</div>}
      <form
        className="project-search"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void api<{ matches: NonNullable<typeof matches> }>(
            settings,
            base +
              '/search?path=' +
              encodeURIComponent(path) +
              '&query=' +
              encodeURIComponent(query),
          )
            .then((r) => {
              setMatches(r.matches);
              setFile(null);
            })
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <input
          className="standard-input"
          aria-label="在服务器项目中搜索"
          placeholder="搜索文本…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={200}
        />
        <button className="secondary" disabled={busy || !query.trim()} aria-label="搜索项目">
          <Search size={16} />
        </button>
      </form>
      <div className="project-path">
        <button
          className="icon-btn"
          aria-label="上级目录"
          disabled={path === '.' || busy}
          onClick={() => setPath(path.split('/').slice(0, -1).join('/') || '.')}
        >
          <ArrowLeft size={16} />
        </button>
        <code>{path}</code>
        {matches && (
          <button className="text-link" onClick={() => setMatches(null)}>
            关闭搜索
          </button>
        )}
        {busy && <LoaderCircle className="spin" size={15} />}
      </div>
      <div className="project-files">
        {matches
          ? matches.map((m, i) => (
              <button key={i} onClick={() => void read(m.path)}>
                <FileText size={15} />
                <span>
                  {m.path}:{m.line}
                  <small>{m.text}</small>
                </span>
              </button>
            ))
          : entries.map((e) => (
              <button
                key={e.path}
                onClick={() => (e.type === 'directory' ? setPath(e.path) : void read(e.path))}
              >
                {e.type === 'directory' ? <Folder size={16} /> : <FileText size={16} />}
                <span>{e.name}</span>
              </button>
            ))}
        {!busy && !(matches || entries).length && <p className="field-help">此处暂无文件。</p>}
      </div>
      {file && (
        <div className="file-preview">
          <div className="project-path">
            <b>{file.path}</b>
            <button
              className="text-link"
              onClick={() => ask(`请读取 ${file.path}，分析它的作用和可以改进的地方。`)}
            >
              交给 Pi 分析 <ArrowRight size={14} aria-hidden="true" />
            </button>
          </div>
          <pre>{file.content}</pre>
          {file.truncated && <small>仅展示部分内容，Pi 可按行继续读取。</small>}
        </div>
      )}
    </section>
  );
}
