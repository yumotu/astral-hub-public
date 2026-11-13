import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Archive, ChevronDown, Monitor, Plus, RefreshCw, X } from 'lucide-react';
import { api, dateLabel } from './data';
import { useMobilePanels } from './MobilePanels';
import {
  ConversationDialog,
  ConversationEditor,
  ConversationMenu,
  ConversationRow,
  type Conversation,
  type ConversationAction,
  type MenuAnchor,
} from './ConversationMenu';
import { ProjectConversationList } from './ProjectConversationList';
import { ProjectSummary } from './ProjectSummary';
import { NativeSegmentHistory } from './ConversationSegmentHistory';
import { serverIdentity } from './session';
import {
  readUnifiedSelection,
  saveUnifiedSelection,
  unifiedSelectionKey,
  activeUnifiedSelection,
  createUnifiedOperationJournal,
} from '../../shared/unified-selection.mjs';
import { visibleConversations } from '../../shared/pi-conversation-list.mjs';
import type { Settings } from './types';
import './unified-conversations.css';

export type NativeConversationRef = {
  origin: 'server' | 'computer' | 'remote';
  nativeId: string;
  runtime: {
    backend: 'pi' | 'dsh';
    location: 'server' | 'computer';
    deviceId: string | null;
    connectionId: string | null;
    projectId: string | null;
    sessionKey: string;
  };
};
export type UnifiedConversation = Conversation & {
  active: NativeConversationRef;
  segments: NativeConversationRef[];
  runState?: { busy: boolean; label: string };
};
export type ConversationTarget = {
  origin: NativeConversationRef['origin'];
  projectId: string | null;
  deviceId?: string;
  connectionId?: string;
  label?: string;
  locationName?: string;
  projectName?: string;
};
type Selection = { origin: NativeConversationRef['origin']; nativeId: string };
type Model = {
  conversations: UnifiedConversation[];
  targets: ConversationTarget[];
  selected: Selection | null;
  defaultBackend: 'pi' | 'dsh';
  ready: boolean;
  error: string;
  busy: boolean;
  select: (value: Selection) => void;
  refresh: () => Promise<void>;
  setDefault: (backend: 'pi' | 'dsh') => Promise<void>;
  create: (target: ConversationTarget) => Promise<void>;
  switchEngine: (conversation: UnifiedConversation, target: ConversationTarget) => Promise<void>;
  patch: (
    c: UnifiedConversation,
    value: { title?: string; pinned?: boolean; archived?: boolean },
  ) => Promise<void>;
  remove: (c: UnifiedConversation) => Promise<void>;
  projectName: (target: ConversationTarget) => string;
  renameProject: (target: ConversationTarget, name: string | null) => Promise<void>;
  importSession: (target: ConversationTarget, sessionId: string) => Promise<void>;
  sessions: (target: ConversationTarget) => Promise<RemoteSession[]>;
};
type RemoteSession = { id: string; title: string; workspaceIds: string[]; running?: boolean };
const projectKey = (t: ConversationTarget) =>
  JSON.stringify([t.origin, t.connectionId || t.deviceId || null, t.projectId]);
const matchesRuntime = (target: ConversationTarget, segment: NativeConversationRef) =>
  target.origin === segment.origin &&
  target.projectId === segment.runtime.projectId &&
  (target.origin === 'remote'
    ? target.connectionId === segment.runtime.connectionId
    : target.origin === 'computer'
      ? target.deviceId === segment.runtime.deviceId
      : true);
const Context = createContext<Model | null>(null);
export const useUnifiedConversations = () => useContext(Context);
const endpoint = '/assistant/conversations';
const targetBody = ({ origin, projectId, deviceId, connectionId }: ConversationTarget) => ({
  origin,
  projectId,
  ...(deviceId ? { deviceId } : {}),
  ...(connectionId ? { connectionId } : {}),
});

export function UnifiedConversationsProvider({
  settings,
  owner,
  children,
}: {
  settings: Settings;
  owner: string;
  children: ReactNode;
}) {
  const storageKey = unifiedSelectionKey(serverIdentity(settings), owner);
  const [selected, setSelected] = useState<Selection | null>(
    () =>
      readUnifiedSelection(localStorage, sessionStorage, {
        server: serverIdentity(settings),
        url: settings.url,
        owner,
      }) as Selection | null,
  );
  const aliasStorageKey = 'astral.dsh.projectNames:' + settings.url + ':' + owner;
  const [projectAliases, setProjectAliases] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(aliasStorageKey) || '{}');
    } catch {
      return {};
    }
  });
  const [renamedProjects, setRenamedProjects] = useState<Record<string, string>>({});
  const [conversations, setConversations] = useState<UnifiedConversation[]>([]);
  const [targets, setTargets] = useState<ConversationTarget[]>([]);
  const [defaultBackend, setDefaultBackend] = useState<'pi' | 'dsh'>('pi');
  const [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const generation = useRef(0),
    mutationLock = useRef(false);
  const operationIds = useRef(createUnifiedOperationJournal(localStorage, storageKey));
  const refresh = useCallback(async () => {
    const born = generation.current;
    const result = await api<{
      conversations: UnifiedConversation[];
      targets?: ConversationTarget[];
      preferences?: { defaultBackend: 'pi' | 'dsh' };
    }>(settings, endpoint, undefined, undefined, false, { fresh: true });
    if (generation.current !== born) return;
    setConversations(result.conversations);
    setSelected((old) => {
      const next = activeUnifiedSelection(result.conversations, old);
      if (next && (next.origin !== old?.origin || next.nativeId !== old?.nativeId)) {
        saveUnifiedSelection(localStorage, storageKey, next);
        return next;
      }
      return old;
    });
    if (result.targets) setTargets(result.targets);
    if (result.preferences) setDefaultBackend(result.preferences.defaultBackend);
    setReady(true);
    setError('');
  }, [settings, storageKey]);
  useEffect(() => {
    let live = true,
      loading = false;
    const load = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try {
        await refresh();
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        loading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    const focus = () => void load();
    window.addEventListener('focus', focus);
    return () => {
      live = false;
      generation.current++;
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [refresh]);
  const select = useCallback(
    (value: Selection) => {
      setSelected((old) =>
        old?.origin === value.origin && old.nativeId === value.nativeId ? old : value,
      );
      saveUnifiedSelection(localStorage, storageKey, value);
    },
    [storageKey],
  );
  async function mutate(work: () => Promise<void>) {
    if (mutationLock.current) throw Error('请等待当前对话操作完成。');
    mutationLock.current = true;
    setBusy(true);
    setError('');
    try {
      await work();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }
  return (
    <Context.Provider
      value={{
        conversations,
        targets,
        selected,
        defaultBackend,
        ready,
        error,
        busy,
        select,
        refresh,
        setDefault: async (backend) => {
          try {
            await api(settings, '/assistant/preferences', { defaultBackend: backend }, 'PATCH');
            setDefaultBackend(backend);
          } catch (e) {
            setError((e as Error).message);
            throw e;
          }
        },
        create: async (target) =>
          mutate(async () => {
            const key = 'create:' + JSON.stringify(targetBody(target));
            const id = operationIds.current.id(key);
            const r = await api<{ conversation: UnifiedConversation }>(settings, endpoint, {
              id,
              target: targetBody(target),
            });
            select(r.conversation.active);
            operationIds.current.complete(key);
          }),
        switchEngine: async (c, target) =>
          mutate(async () => {
            const key = JSON.stringify([
              c.id,
              c.active.origin,
              c.active.nativeId,
              targetBody(target),
            ]);
            const id = operationIds.current.id(key);
            const r = await api<{ conversation: UnifiedConversation }>(
              settings,
              `${endpoint}/${c.id}/switch`,
              { id, target: targetBody(target) },
            );
            select(r.conversation.active);
            operationIds.current.complete(key);
          }),
        patch: async (c, patch) => {
          await api(settings, `${endpoint}/${c.id}`, patch, 'PATCH');
          await refresh();
        },
        remove: async (c) =>
          mutate(async () => {
            await api(settings, `${endpoint}/${c.id}`, undefined, 'DELETE');
            if (
              selected &&
              c.segments.some(
                (s) => s.origin === selected.origin && s.nativeId === selected.nativeId,
              )
            ) {
              // Move away from the deleted native view immediately. If it was the
              // final chat, show a fresh local draft without creating a model task.
              select(
                conversations.find((other) => other.id !== c.id && !other.archivedAt)?.active || {
                  origin: 'server',
                  nativeId: crypto.randomUUID(),
                },
              );
            }
          }),
        projectName: (target) =>
          renamedProjects[projectKey(target)] ||
          (target.origin === 'remote'
            ? projectAliases[target.connectionId + ':' + target.projectId]
            : '') ||
          target.projectName ||
          target.label ||
          target.projectId ||
          '独立对话',
        renameProject: async (target, name) => {
          if (!target.projectId) return;
          if (target.origin === 'remote') {
            const next = { ...projectAliases },
              key = target.connectionId + ':' + target.projectId;
            if (name) next[key] = name;
            else delete next[key];
            localStorage.setItem(aliasStorageKey, JSON.stringify(next));
            setProjectAliases(next);
          } else {
            const base = target.origin === 'server' ? '/pi/projects/' : '/relay/projects/';
            const query =
              target.origin === 'computer'
                ? '?deviceId=' + encodeURIComponent(target.deviceId!)
                : '';
            await api(
              settings,
              base + encodeURIComponent(target.projectId) + '/display-name' + query,
              { name },
              'PUT',
            );
            setRenamedProjects((old) => {
              const next = { ...old };
              if (name) next[projectKey(target)] = name;
              else delete next[projectKey(target)];
              return next;
            });
            await refresh();
          }
        },
        sessions: async (target) => {
          if (target.origin !== 'remote') return [];
          const result = await api<{ sessions: RemoteSession[] }>(
            settings,
            '/agent/remote/connections/' + target.connectionId + '/catalogue',
            undefined,
            undefined,
            false,
            { fresh: true },
          );
          return result.sessions.filter((s) => s.workspaceIds.includes(target.projectId!));
        },
        importSession: async (target, sessionId) =>
          mutate(async () => {
            const existing = conversations.find((c) =>
              c.segments.some(
                (s) =>
                  s.origin === 'remote' &&
                  s.runtime.connectionId === target.connectionId &&
                  s.runtime.sessionKey === sessionId,
              ),
            );
            if (existing) {
              select(existing.active);
              return;
            }
            const key = 'import:' + target.connectionId + ':' + sessionId;
            const id = operationIds.current.id(key);
            const result = await api<{ conversation: { id: string } }>(
              settings,
              '/agent/remote/conversations',
              { id, connectionId: target.connectionId, workspaceId: target.projectId, sessionId },
            );
            select({ origin: 'remote', nativeId: result.conversation.id });
            operationIds.current.complete(key);
          }),
      }}
    >
      {children}
    </Context.Provider>
  );
}

export function findUnifiedConversation(
  model: Model | null,
  origin: Selection['origin'],
  nativeId: string,
) {
  return model?.conversations.find((c) =>
    c.segments.some((s) => s.origin === origin && s.nativeId === nativeId),
  );
}

export function ConversationEngineSettings({ origin, nativeId }: Selection) {
  const model = useUnifiedConversations();
  const c = findUnifiedConversation(model, origin, nativeId);
  const [open, setOpen] = useState(false);
  if (!model) return null;
  return (
    <div className="conversation-engine-setting">
      <span>本对话引擎</span>
      <button
        type="button"
        className="secondary"
        disabled={model.busy || !!c?.runState?.busy}
        onClick={() => setOpen(true)}
      >
        {(c?.active.runtime.backend || (origin === 'remote' ? 'dsh' : 'pi')) === 'dsh'
          ? 'DeepSeek Harness'
          : 'Pi'}{' '}
        <ChevronDown size={13} />
      </button>
      {c?.runState?.busy && <small>{c.runState.label}，结束并核定后可切换。</small>}
      {!c && <small>尚未保存的对话可选择引擎和执行位置，当前草稿会保留。</small>}
      {open && (
        <ConversationTargetDialog
          title="切换本对话引擎"
          close={() => setOpen(false)}
          current={c?.active}
          backend={c ? undefined : origin === 'remote' ? 'pi' : 'dsh'}
          submit={(target) => (c ? model.switchEngine(c, target) : model.create(target))}
        />
      )}
    </div>
  );
}

export function ConversationTargetDialog({
  title,
  close,
  submit,
  current,
  preferred,
  backend,
}: {
  title: string;
  close: () => void;
  submit: (target: ConversationTarget) => Promise<void>;
  current?: NativeConversationRef;
  preferred?: ConversationTarget;
  backend?: 'pi' | 'dsh';
}) {
  const model = useUnifiedConversations()!;
  const [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const targets = model.targets.filter(
    (t) =>
      (t.origin === 'remote' ? 'dsh' : 'pi') ===
      (current
        ? current.runtime.backend === 'pi'
          ? 'dsh'
          : 'pi'
        : backend || model.defaultBackend),
  );
  const orderedTargets = preferred
    ? [...targets].sort(
        (a, b) =>
          Number(projectKey(b) === projectKey(preferred)) -
          Number(projectKey(a) === projectKey(preferred)),
      )
    : targets;
  return (
    <ConversationDialog
      title={title}
      close={() => {
        if (!pending) close();
      }}
    >
      <p className="field-help">
        {current
          ? '原记录会保留；目标引擎使用可见交流内容续聊，权限需要按目标重新设置。请选择实际执行位置。'
          : `使用 ${(backend || model.defaultBackend) === 'dsh' ? 'DeepSeek Harness' : 'Pi'}，请选择项目与执行位置。`}
      </p>
      <div className="conversation-targets">
        {orderedTargets.map((target, index) => (
          <button
            type="button"
            className="secondary"
            key={JSON.stringify(targetBody(target))}
            disabled={pending}
            onClick={() => {
              setPending(true);
              setError('');
              void submit(target)
                .then(close)
                .catch((e) => setError(e.message))
                .finally(() => setPending(false));
            }}
          >
            <b>
              {target.origin === 'remote' ? 'DeepSeek Harness' : 'Pi'} ·{' '}
              {model.projectName(target) || `项目 ${index + 1}`}
            </b>
            <small>
              {target.locationName || (target.origin === 'server' ? '服务器' : '指定主机')}
              {preferred && projectKey(target) === projectKey(preferred) ? ' · 当前目录' : ''}
            </small>
          </button>
        ))}
      </div>
      {!targets.length && (
        <p className="field-help">没有可用的目标。请先在管理电脑连接中关联主机与授权工作区。</p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </ConversationDialog>
  );
}

export function UnifiedConversationNavigation({
  newProject,
  defaultDirectory,
  manage,
  fallbackNew,
}: {
  newProject?: () => void;
  defaultDirectory?: ReactNode;
  manage: () => void;
  fallbackNew?: () => void;
}) {
  const model = useUnifiedConversations()!;
  const { displayPanel, setPanel } = useMobilePanels();
  const [archived, setArchived] = useState(false),
    [newOpen, setNewOpen] = useState(false);
  const [menu, setMenu] = useState<MenuAnchor | null>(null),
    [editing, setEditing] = useState<UnifiedConversation | null>(null);
  const [deleting, setDeleting] = useState<UnifiedConversation | null>(null);
  const [error, setError] = useState('');
  const [newTarget, setNewTarget] = useState<ConversationTarget | undefined>();
  const open = displayPanel === 'conversations';
  const visible = visibleConversations(model.conversations, archived);
  type Group = {
    title: string;
    target: ConversationTarget;
    items: UnifiedConversation[];
    available: boolean;
  };
  const groups = new Map<string, Group>();
  if (!archived)
    for (const target of model.targets)
      groups.set(projectKey(target), {
        title: target.locationName || (target.origin === 'server' ? '服务器' : '电脑'),
        target,
        items: [],
        available: true,
      });
  for (const c of visible) {
    const first = c.segments[0] || c.active;
    const runtime = first.runtime;
    const target = model.targets.find((t) => matchesRuntime(t, first)) || {
      origin: first.origin,
      projectId: runtime.projectId,
      ...(runtime.deviceId && first.origin === 'computer' ? { deviceId: runtime.deviceId } : {}),
      ...(runtime.connectionId ? { connectionId: runtime.connectionId } : {}),
    };
    const key = projectKey(target);
    if (!groups.has(key))
      groups.set(key, {
        title: target.locationName || (runtime.location === 'server' ? '服务器' : '电脑'),
        target,
        items: [],
        available: model.targets.some((t) => projectKey(t) === key),
      });
    groups.get(key)!.items.push(c);
  }
  function sameDirectory(c: UnifiedConversation) {
    const first = c.segments[0] || c.active;
    setNewTarget(model.targets.find((t) => matchesRuntime(t, first)));
    setNewOpen(true);
  }
  function action(kind: ConversationAction, value: Conversation) {
    const c = model.conversations.find((v) => v.id === value.id)!;
    if (kind === 'rename') setEditing(c);
    else if (kind === 'delete') setDeleting(c);
    else if (kind === 'new') sameDirectory(c);
    else
      void model
        .patch(c, kind === 'pin' ? { pinned: !c.pinnedAt } : { archived: !c.archivedAt })
        .catch((e) => setError(e.message));
  }
  return (
    <>
      <button
        className={`project-navigation-scrim ${open ? 'is-open' : ''}`}
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
        aria-label="关闭项目与对话"
        onClick={() => setPanel(null)}
      />
      <aside
        id="unified-project-navigation"
        aria-label="项目与对话"
        className={`surface contact-list project-conversation-list unified-conversation-navigation ${open ? 'is-open' : ''}`}
      >
        <div className="project-navigation-heading">
          <strong>项目与对话</strong>
          <button className="icon-btn" aria-label="收起项目与对话" onClick={() => setPanel(null)}>
            <X size={18} />
          </button>
        </div>
        <button
          className="secondary new-conversation"
          disabled={model.busy}
          onClick={() => {
            if (!model.ready && fallbackNew) fallbackNew();
            else {
              setNewTarget(undefined);
              setNewOpen(true);
            }
          }}
        >
          <Plus size={17} />
          新对话
        </button>
        <div className="project-tree-heading">
          <h2>{archived ? '已归档' : '全部项目与对话'}</h2>
          {newProject && (
            <button className="icon-btn" aria-label="新建服务器项目" onClick={newProject}>
              <Plus size={16} />
            </button>
          )}
          <button
            className="icon-btn"
            aria-label="刷新项目与对话"
            onClick={() => void model.refresh().catch((e) => setError(e.message))}
          >
            <RefreshCw size={14} />
          </button>
        </div>
        {(error || model.error) && (
          <p className="error" role="status">
            {error || model.error}
          </p>
        )}
        {[...groups].map(([key, group]) => (
          <section key={key} className="unified-location-group">
            <p className="assistant-device-label">
              <Monitor size={13} />
              <span>{group.title}</span>
            </p>
            <details className="project-tree" open>
              {group.target.projectId ? (
                <ProjectSummary
                  name={model.projectName(group.target)}
                  detail={group.items.length || ''}
                  saveName={(name) => model.renameProject(group.target, name)}
                  newConversation={() => {
                    setNewTarget(group.target);
                    setNewOpen(true);
                  }}
                />
              ) : (
                <summary>
                  <span>独立对话</span>
                  <small>{group.items.length}</small>
                </summary>
              )}
              {!group.available && (
                <p className="field-help">主机或项目暂不可用，已有记录仍保留。</p>
              )}
              <ProjectConversationList>
                {group.items.map((c) => (
                  <ConversationRow
                    key={c.id}
                    conversation={c}
                    selected={
                      model.selected?.origin === c.active.origin &&
                      model.selected.nativeId === c.active.nativeId
                    }
                    disabled={model.busy}
                    choose={() => {
                      model.select(c.active);
                      setPanel(null);
                    }}
                    openMenu={setMenu}
                    detail={
                      <>
                        {c.active.runtime.backend === 'dsh' ? 'DPH' : 'Pi'} ·{' '}
                        {c.runState?.busy ? c.runState.label : dateLabel(c.updatedAt)}
                      </>
                    }
                  />
                ))}
              </ProjectConversationList>
              {!archived && group.target.origin === 'remote' && group.available && (
                <RemoteSessionImports target={group.target} />
              )}
            </details>
          </section>
        ))}
        {!visible.length && (
          <p className="field-help">
            {model.ready
              ? archived
                ? '还没有归档的对话。'
                : '你的第一段对话从这里开始。'
              : '正在读取项目与对话…'}
          </p>
        )}
        <div className="pi-navigation-footer">
          <button className="pi-sidebar-control" onClick={() => setArchived(!archived)}>
            <Archive size={15} />
            <span>{archived ? '返回对话' : '已归档'}</span>
            <small>{model.conversations.filter((c) => c.archivedAt).length || ''}</small>
          </button>
          {defaultDirectory}
          <button className="pi-sidebar-control" onClick={manage}>
            <Monitor size={15} />
            <span>管理电脑连接</span>
          </button>
        </div>
      </aside>
      {menu && (
        <ConversationMenu
          anchor={menu}
          close={() => setMenu(null)}
          allowed={[
            'pin',
            'rename',
            'archive',
            'new',
            ...(model.conversations.find((c) => c.id === menu.conversation.id)?.segments.length ===
              1 &&
            model.conversations.find((c) => c.id === menu.conversation.id)?.active.origin !==
              'remote'
              ? ['delete' as const]
              : []),
          ]}
          action={action}
        />
      )}
      {editing && (
        <ConversationEditor
          conversation={editing}
          kind="rename"
          running={false}
          close={() => setEditing(null)}
          submit={async (title) => model.patch(editing, { title })}
        />
      )}
      {deleting && (
        <ConversationEditor
          conversation={deleting}
          kind="delete"
          computer={deleting.active.origin === 'computer'}
          running={!!deleting.runState?.busy}
          close={() => setDeleting(null)}
          submit={async () => model.remove(deleting)}
        />
      )}
      {newOpen && (
        <ConversationTargetDialog
          preferred={newTarget}
          title="新对话"
          close={() => setNewOpen(false)}
          submit={async (target) => {
            await model.create(target);
            setPanel(null);
          }}
        />
      )}
    </>
  );
}

function RemoteSessionImports({ target }: { target: ConversationTarget }) {
  const model = useUnifiedConversations()!;
  const [sessions, setSessions] = useState<RemoteSession[] | null>(null),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const imported = new Set(
    model.conversations.flatMap((c) =>
      c.segments
        .filter((s) => s.origin === 'remote' && s.runtime.connectionId === target.connectionId)
        .map((s) => s.runtime.sessionKey),
    ),
  );
  async function load() {
    setPending(true);
    setError('');
    try {
      setSessions(await model.sessions(target));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <details
      className="unified-native-imports"
      onToggle={(e) => {
        if (e.currentTarget.open && !sessions && !pending && !error) void load();
      }}
    >
      <summary>主机上的其他对话</summary>
      {pending && (
        <p className="field-help" role="status">
          正在读取主机会话…
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
          <button className="text-link" onClick={() => void load()}>
            重试
          </button>
        </p>
      )}
      {sessions
        ?.filter((s) => !imported.has(s.id))
        .map((session) => (
          <button
            className="contact-choice"
            key={session.id}
            disabled={pending || model.busy}
            onClick={() => {
              setError('');
              void model.importSession(target, session.id).catch((e) => setError(e.message));
            }}
          >
            <span>
              <b>{session.title || '未命名对话'}</b>
              <small>{session.running ? '主机正在执行' : '继续已有会话'}</small>
            </span>
          </button>
        ))}
      {sessions && !sessions.some((s) => !imported.has(s.id)) && (
        <p className="field-help">主机上没有尚未关联的对话。</p>
      )}
    </details>
  );
}

export function ConversationSegmentHistory({
  settings,
  origin,
  nativeId,
}: {
  settings: Settings;
  origin: NativeConversationRef['origin'];
  nativeId: string;
}) {
  const model = useUnifiedConversations(),
    c = findUnifiedConversation(model, origin, nativeId);
  if (!c || c.active.origin !== origin || c.active.nativeId !== nativeId) return null;
  return (
    <>
      {c.segments
        .filter((s) => s.origin !== origin || s.nativeId !== nativeId)
        .map((s) => (
          <NativeSegmentHistory key={s.origin + ':' + s.nativeId} settings={settings} segment={s} />
        ))}
    </>
  );
}
