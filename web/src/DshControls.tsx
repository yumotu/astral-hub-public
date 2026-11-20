import { useEffect, useRef, useState } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { api } from './data';
import type { Settings } from './types';
import { dshPermissionLabel } from '../../shared/dsh-controls.mjs';
import { useBackLayer } from './back-navigation';

export type DshControls = {
  model: { provider: string; model: string; reasoningEffort?: string } | null;
  models: {
    default: { provider: string; model: string; reasoningEffort?: string };
    groups: {
      id: string;
      name: string;
      models: {
        id: string;
        name: string;
        reasoning?: {
          efforts: { id: string; name: string; description?: string }[];
          defaultEffort?: string;
        };
      }[];
    }[];
  } | null;
  permissions: { currentValue: string } | null;
  permissionOptions: { value: string; name: string; description?: string }[] | null;
  skills: { name: string; description: string; modelInvocable: boolean }[] | null;
  terminal: { maxCols: number; maxRows: number; maxInputBytes: number } | null;
};
export function useDshControls(settings: Settings, id: string, connected: boolean) {
  const [controls, setControls] = useState<DshControls | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState('');
  const life = useRef(0),
    lock = useRef(false);
  const base = '/agent/remote/conversations/' + id + '/controls';
  async function reload() {
    if (!connected || lock.current) return;
    const generation = life.current;
    lock.current = true;
    setLoading(true);
    setError('');
    try {
      const r = await api<{ controls: DshControls }>(settings, base, undefined, undefined, false, {
        fresh: true,
      });
      if (generation === life.current) setControls(r.controls);
    } catch (e) {
      if (generation === life.current) setError((e as Error).message);
    } finally {
      if (generation === life.current) {
        lock.current = false;
        setLoading(false);
      }
    }
  }
  useEffect(() => {
    life.current++;
    lock.current = false;
    void reload();
    return () => {
      life.current++;
    };
  }, [settings, id, connected]);
  async function select(kind: 'thinking' | 'permission', value: string) {
    if (!connected || lock.current) return;
    const generation = life.current;
    lock.current = true;
    setLoading(true);
    setError('');
    try {
      const r = await api<{ controls: DshControls; operation: { state: string } }>(settings, base, {
        id: crypto.randomUUID(),
        kind,
        value,
      });
      if (generation === life.current) {
        setControls(r.controls);
        if (!['accepted', 'observed'].includes(r.operation.state))
          setError('设置结果待主机确认，请刷新核对；不会自动重试。');
      }
    } catch (e) {
      if (generation === life.current) setError((e as Error).message + '；请刷新核对实际设置。');
    } finally {
      if (generation === life.current) {
        lock.current = false;
        setLoading(false);
      }
    }
  }
  return { controls, loading, error, reload, select };
}

export function DshPermissions({
  controls,
  disabled,
  select,
}: {
  controls: DshControls | null;
  disabled: boolean;
  select: (value: string) => void;
}) {
  return (
    <fieldset className="dsh-permission-controls" disabled={disabled}>
      <legend>Agent 权限</legend>
      <div role="radiogroup" aria-label="DSH权限">
        {controls?.permissionOptions?.map((o) => (
          <button
            type="button"
            role="radio"
            key={o.value}
            aria-checked={controls.permissions?.currentValue === o.value}
            onClick={() => select(o.value)}
            title={o.description}
          >
            {dshPermissionLabel(o.value, o.name)}
          </button>
        ))}
      </div>
      <p className="field-help">
        {!controls?.permissions
          ? '正在核对主机的权限；未提供时不代为授权。'
          : controls.permissions.currentValue === 'read-only'
            ? '默认只读；修改文件和需要扩大范围的命令，会在对话中等待你审核。'
            : controls.permissions.currentValue === 'workspace-write'
              ? '可修改工作区；超出原生允许范围时等待审核。'
              : controls.permissions.currentValue === 'danger-full-access'
                ? '当前 Agent 使用主机执行账号的完整权限，不再逐次审核；服务器环境仍受容器边界约束。'
                : '主机使用自定义权限，实际限制以主机配置为准。'}
      </p>
    </fieldset>
  );
}

export function DshSkills({
  skills,
  refresh,
  loading,
  choose,
  close,
}: {
  skills: DshControls['skills'];
  refresh: () => void;
  loading: boolean;
  choose: (name: string) => void;
  close: () => void;
}) {
  const [search, setSearch] = useState('');
  useBackLayer(true, close, 80);
  return (
    <div
      className="assistant-modal-backdrop dsh-workbench-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        className="assistant-modal dsh-skills-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="DSH技能"
      >
        <header className="workbench-heading">
          <strong>工作区技能</strong>
          <button
            type="button"
            className="icon-btn"
            aria-label="刷新技能"
            disabled={loading}
            onClick={refresh}
          >
            <RefreshCw size={16} />
          </button>
          <button type="button" className="icon-btn" aria-label="关闭技能" onClick={close}>
            <X size={18} />
          </button>
        </header>
        <p className="field-help">
          来自当前主机和工作区。选择后填入输入框，发送时由 Harness 原生加载。
        </p>
        <input
          className="standard-input"
          aria-label="搜索技能"
          placeholder="搜索技能"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="dsh-skill-list">
          {skills === null ? (
            <p>主机尚未提供技能目录，请检查连接或刷新。</p>
          ) : !skills.length ? (
            <p>此工作区暂未发现可用技能。</p>
          ) : (
            skills
              .filter((s) => (s.name + s.description).toLowerCase().includes(search.toLowerCase()))
              .map((s) => (
                <button
                  type="button"
                  key={s.name}
                  className="secondary"
                  onClick={() => choose(s.name)}
                >
                  <strong>/{s.name}</strong>
                  <span>{s.description}</span>
                  {!s.modelInvocable && <small>仅由你主动调用</small>}
                </button>
              ))
          )}
        </div>
      </section>
    </div>
  );
}
