import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from './data';
import type { Settings } from './types';
import type { ServerProject } from './ProjectBrowser';
import { ProjectPermissions } from './ProjectManager';

export function AdminPermissions({ settings }: { settings: Settings }) {
  const [projects, setProjects] = useState<ServerProject[]>([]),
    [selected, setSelected] = useState(''),
    [editing, setEditing] = useState(false),
    [error, setError] = useState(''),
    [revision, refresh] = useState(0);
  useEffect(() => {
    let live = true;
    void api<{ projects: ServerProject[] }>(settings, '/pi/projects', undefined, undefined, false, {
      fresh: true,
    })
      .then((r) => {
        if (live) {
          setProjects(r.projects);
          setSelected((old) =>
            r.projects.some((p) => p.id === old) ? old : r.projects[0]?.id || '',
          );
          setError('');
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [settings, revision]);
  const project = projects.find((p) => p.id === selected);
  return (
    <section className="surface" aria-label="权限与授权">
      <div className="section-title">
        <ShieldCheck size={21} />
        <h2>权限与授权</h2>
        <span className="tag">管理员</span>
      </div>
      <label className="field-label">
        服务器项目
        <select
          className="standard-input"
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
        >
          {!projects.length && <option value="">暂无可管理项目</option>}
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <p className="field-help">
        管理项目目录及成员授权。远程电脑的文件与命令权限由目标电脑本机单独授权。
      </p>
      <button
        type="button"
        className="secondary"
        disabled={!project}
        onClick={() => setEditing(true)}
      >
        管理项目授权
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {editing && project && (
        <ProjectPermissions
          settings={settings}
          project={project}
          projects={projects}
          saved={() => {
            setEditing(false);
            refresh((n) => n + 1);
          }}
          close={() => setEditing(false)}
        />
      )}
    </section>
  );
}
