import { useEffect, useState } from 'react';
import { Folder, ArrowLeft, X, Plus } from 'lucide-react';
import { api } from './data';
import type { Settings } from './types';
import type { ServerProject } from './ProjectBrowser';

export function NewProject({
  settings,
  sources,
  created,
  close,
}: {
  settings: Settings;
  sources: ServerProject[];
  created: (p: ServerProject) => void;
  close: () => void;
}) {
  const [sourceId, setSourceId] = useState(sources[0]?.id || ''),
    [path, setPath] = useState('.'),
    [name, setName] = useState(''),
    [folder, setFolder] = useState(''),
    [entries, setEntries] = useState<{ name: string; path: string; type: string }[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0);
  const source = sources.find((p) => p.id === sourceId);
  useEffect(() => {
    let live = true;
    setBusy(true);
    setError('');
    api<{ entries: typeof entries }>(
      settings,
      `/pi/projects/${sourceId}/list?path=${encodeURIComponent(path)}`,
    )
      .then((r) => {
        if (live) setEntries(r.entries.filter((e) => e.type === 'directory'));
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setBusy(false);
      });
    return () => {
      live = false;
    };
  }, [sourceId, path, revision, settings]);
  async function create() {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ project: ServerProject }>(settings, '/pi/projects', {
        name: name.trim() || (path === '.' ? source?.name : path.split('/').at(-1)),
        sourceId,
        path,
      });
      created(r.project);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="assistant-modal-backdrop">
      <section
        className="surface assistant-modal"
        role="dialog"
        aria-modal="true"
        aria-label="新建项目"
      >
        <div className="section-title">
          <Folder size={20} />
          <h2>新建项目</h2>
          <button
            className="icon-btn push-right"
            aria-label="关闭新建项目"
            disabled={busy}
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <p className="field-help">
          选择服务器上的实际文件夹。项目中的对话默认只访问这个文件夹及其子目录。
          {source?.userRoot && '普通用户的新项目仅可建立在自己的用户名目录中。'}
        </p>
        <label>
          项目名称
          <input
            aria-label="项目名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            placeholder="留空使用文件夹名称"
          />
        </label>
        <label>
          服务器目录
          <select
            aria-label="服务器目录"
            value={sourceId}
            disabled={busy}
            onChange={(e) => {
              setSourceId(e.target.value);
              setPath('.');
            }}
          >
            {sources.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · {p.readOnly ? '只读' : '支持修改'}
              </option>
            ))}
          </select>
        </label>
        <div className="project-path">
          <button
            className="icon-btn"
            aria-label="选择上级文件夹"
            disabled={busy || path === '.'}
            onClick={() => setPath(path.split('/').slice(0, -1).join('/') || '.')}
          >
            <ArrowLeft size={16} />
          </button>
          <code>
            {source?.serverPath}
            {path !== '.' ? '/' + path : ''}
          </code>
        </div>
        <div className="folder-picker">
          {entries.map((e) => (
            <button key={e.path} disabled={busy} onClick={() => setPath(e.path)}>
              <Folder size={17} />
              {e.name}
            </button>
          ))}
          {!entries.length && !busy && (
            <p className="field-help">此文件夹没有可选择的子目录，可直接选择当前文件夹。</p>
          )}
        </div>
        {!source?.readOnly && (
          <form
            className="project-search"
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              void api(settings, `/pi/projects/${sourceId}/mkdir`, {
                path: (path === '.' ? '' : path + '/') + folder,
              })
                .then(() => {
                  setFolder('');
                  setRevision((n) => n + 1);
                })
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            <input
              aria-label="新文件夹名称"
              placeholder="新文件夹名称"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              maxLength={100}
            />
            <button className="secondary" disabled={busy || !folder.trim()}>
              <Plus size={15} />
              新建文件夹
            </button>
          </form>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="action-row">
          <button className="primary" disabled={busy || !source} onClick={() => void create()}>
            选择此文件夹并创建项目
          </button>
          <button className="secondary" disabled={busy} onClick={close}>
            取消
          </button>
        </div>
      </section>
    </div>
  );
}

export function ProjectPermissions({
  settings,
  project,
  projects,
  saved,
  close,
}: {
  settings: Settings;
  project: ServerProject;
  projects: ServerProject[];
  saved: () => void;
  close: () => void;
}) {
  const [grants, setGrants] = useState(project.grants || []),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <div className="assistant-modal-backdrop">
      <section
        className="surface assistant-modal"
        role="dialog"
        aria-modal="true"
        aria-label="项目文件授权"
      >
        <div className="section-title">
          <h2>项目文件授权</h2>
          <button
            className="icon-btn push-right"
            aria-label="关闭项目文件授权"
            disabled={busy}
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <p className="field-help">
          默认只访问 {project.serverPath}{' '}
          及其子目录。勾选其他文件夹后，本项目下的对话可以在后续文件操作中跨工作区访问；每个文件夹单独选择权限。
        </p>
        {!project.source && (
          <div className="workspace-grants">
            {projects
              .filter((p) => p.id !== project.id)
              .map((p) => {
                const grant = grants.find((g) => g.projectId === p.id);
                return (
                  <div key={p.id}>
                    <label>
                      <input
                        type="checkbox"
                        checked={!!grant}
                        disabled={busy}
                        onChange={(e) =>
                          setGrants((old) =>
                            e.target.checked
                              ? [...old, { projectId: p.id, access: 'read' }]
                              : old.filter((g) => g.projectId !== p.id),
                          )
                        }
                      />
                      <span>
                        {p.name}
                        <small>{p.serverPath}</small>
                      </span>
                    </label>
                    {grant && (
                      <select
                        aria-label={`${p.name}权限`}
                        disabled={busy}
                        value={grant.access}
                        onChange={(e) =>
                          setGrants((old) =>
                            old.map((g) =>
                              g.projectId === p.id
                                ? { ...g, access: e.target.value as 'read' | 'edit' }
                                : g,
                            ),
                          )
                        }
                      >
                        <option value="read">只读</option>
                        <option value="edit" disabled={p.readOnly}>
                          允许修改 · 自动备份
                        </option>
                      </select>
                    )}
                  </div>
                );
              })}
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!project.source && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void api(settings, `/pi/projects/${project.id}/grants`, { grants })
                .then(saved)
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            保存授权
          </button>
        )}
        <ProjectMembers settings={settings} project={project} />
      </section>
    </div>
  );
}

function ProjectMembers({ settings, project }: { settings: Settings; project: ServerProject }) {
  type Member = { userId: string; username: string; access: 'read' | 'edit' };
  const [members, setMembers] = useState<Member[]>([]),
    [username, setUsername] = useState(''),
    [access, setAccess] = useState<'read' | 'edit'>('read'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api<{ members: Member[] }>(settings, `/pi/projects/${project.id}/members`)
      .then((r) => {
        if (live) setMembers(r.members);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [settings, project.id]);
  async function update(username: string, access: 'read' | 'edit' | null) {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ members: Member[] }>(settings, `/pi/projects/${project.id}/members`, {
        username,
        access,
      });
      setMembers(r.members);
      setUsername('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="project-member-access">
      <h3>成员目录授权</h3>
      <p className="field-help">
        仅管理员可授予其他账号访问 <code>{project.serverPath}</code>{' '}
        及全部子目录的权限。用户新建项目仍限制在自己的用户名目录内。撤销前须等待此成员正在运行的任务结束。
      </p>
      {members.map((member) => (
        <div className="project-member-row" key={member.userId}>
          <span>
            @{member.username} · {member.access === 'edit' ? '可读取和修改' : '只读'}
          </span>
          <button
            type="button"
            className="text-link"
            disabled={busy}
            onClick={() => void update(member.username, null)}
          >
            撤销
          </button>
        </div>
      ))}
      <form
        className="project-member-form"
        onSubmit={(event) => {
          event.preventDefault();
          void update(username.trim().toLowerCase(), access);
        }}
      >
        <label>
          已注册用户名
          <input
            aria-label="获得目录授权的用户名"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
            minLength={3}
            maxLength={32}
            placeholder="输入普通用户的用户名"
            disabled={busy}
          />
        </label>
        <label>
          访问权限
          <select
            aria-label="成员目录权限"
            value={access}
            onChange={(event) => setAccess(event.target.value as 'read' | 'edit')}
            disabled={busy}
          >
            <option value="read">只读</option>
            <option value="edit" disabled={project.readOnly}>
              读取和修改
            </option>
          </select>
        </label>
        <button className="primary" disabled={busy || username.trim().length < 3}>
          授权此目录
        </button>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
