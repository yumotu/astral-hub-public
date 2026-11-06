import { useMemo, useState } from 'react';
import { ChevronDown, FileDiff, RotateCcw } from 'lucide-react';
import { api } from './data';
import { useFileWorkbench } from './FileWorkbench';
import type { Settings } from './types';
import type { ToolRun } from './ToolLog';
type Change = ToolRun & { backupId: string };
type Diff = {
  path: string;
  added: number;
  removed: number;
  patch: string;
  truncated: boolean;
  restored: boolean;
};
export function FileChanges({
  tools,
  settings,
  projectId,
}: {
  tools: ToolRun[];
  settings: Settings;
  projectId?: string | null;
}) {
  const workbench = useFileWorkbench();
  const [expanded, setExpanded] = useState(false),
    [selected, setSelected] = useState(''),
    [diff, setDiff] = useState<Diff | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [restored, setRestored] = useState<string[]>([]);
  const changes = useMemo(
    () =>
      tools.filter(
        (t): t is Change =>
          ['project_write', 'project_edit'].includes(t.name) && t.status === 'done' && !!t.backupId,
      ),
    [tools],
  );
  if (!changes.length)
    return tools.some((t) => t.name === 'bash') ? (
      <small className="file-changes-note">Bash 命令的文件变更暂未自动统计。</small>
    ) : null;
  const unique = new Set(changes.map((t) => `${t.projectId || projectId}:${t.path}`)).size;
  const allCounts = changes.every((t) => t.added !== undefined && t.removed !== undefined);
  const added = changes.reduce((sum, t) => sum + (t.added || 0), 0),
    removed = changes.reduce((sum, t) => sum + (t.removed || 0), 0);
  async function show(t: Change) {
    const id = t.projectId || projectId;
    if (!id) return;
    if (workbench) {
      workbench.openFile({ projectId: id, path: t.path, backupId: t.backupId });
      return;
    }
    setSelected(t.backupId);
    setDiff(null);
    setError('');
    setBusy(true);
    try {
      setDiff(
        await api<Diff>(
          settings,
          `/pi/projects/${id}/diff`,
          { backupId: t.backupId },
          undefined,
          false,
          { timeout: 20000 },
        ),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function restore(t: Change) {
    const id = t.projectId || projectId;
    if (!id) return;
    setError('');
    setBusy(true);
    try {
      await api(settings, `/pi/projects/${id}/restore`, { backupId: t.backupId });
      setRestored((old) => [...old, t.backupId]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const shown = expanded ? changes : changes.slice(0, 3);
  return (
    <section className="file-changes" aria-label="文件修改">
      <div className="file-changes-heading">
        <FileDiff size={18} />
        <div>
          <strong>已编辑 {unique} 个文件</strong>
          {allCounts && (
            <small>
              操作行数 <span className="diff-add">+{added}</span>{' '}
              <span className="diff-remove">−{removed}</span>
            </small>
          )}
        </div>
        <button
          className="text-link"
          onClick={() => {
            if (expanded) {
              setExpanded(false);
              setSelected('');
              setDiff(null);
            } else {
              setExpanded(true);
              void show(changes[0]);
            }
          }}
        >
          {expanded ? '收起' : '查看变更'} <ChevronDown size={14} />
        </button>
      </div>
      {shown.map((t) => (
        <div key={t.id} className="file-change-row">
          <span title={t.path}>{t.path}</span>
          <span>
            {t.added !== undefined && <span className="diff-add">+{t.added}</span>}{' '}
            {t.removed !== undefined && <span className="diff-remove">−{t.removed}</span>}
          </span>
          <button className="text-link" disabled={busy} onClick={() => void show(t)}>
            详情
          </button>
          <button
            className="text-link"
            disabled={busy || restored.includes(t.backupId)}
            onClick={() => void restore(t)}
          >
            <RotateCcw size={13} />
            {restored.includes(t.backupId) ? '已恢复' : '恢复'}
          </button>
        </div>
      ))}
      {!expanded && changes.length > 3 && (
        <button className="text-link file-changes-more" onClick={() => setExpanded(true)}>
          再显示 {changes.length - 3} 次修改 <ChevronDown size={14} />
        </button>
      )}
      {tools.some((t) => t.name === 'bash') && (
        <small className="file-changes-note">
          此列表统计文件工具的修改；Bash 命令的文件变更未包含。
        </small>
      )}
      {selected && (
        <div className="file-diff">
          <div>
            <b>{diff?.path || '读取变更'}</b>
            <button
              className="text-link"
              onClick={() => {
                setSelected('');
                setDiff(null);
              }}
            >
              关闭
            </button>
          </div>
          {busy && !diff ? (
            <small>加载中…</small>
          ) : (
            diff && (
              <>
                <pre>{diff.patch || '无文本差异'}</pre>
                {diff.truncated && <small>变更较长，已截断显示。</small>}
              </>
            )
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
