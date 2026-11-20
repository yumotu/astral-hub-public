import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  ArrowLeft,
  Archive,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Monitor,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Server,
  X,
  Trash2,
} from 'lucide-react';
import { api, dateLabel } from './data';
import { peekAPI } from './resource-cache';
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
import { ManagementSummary, ProjectSummary } from './ProjectSummary';
import { ComputerProjectSetup, type ProjectSetupComputer } from './ComputerProjectSetup';
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
import { createConversationPreparationJournal } from '../../shared/conversation-preparation.mjs';

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
  workspaceId?: string;
  workspaceName?: string;
  workspacePath?: string;
  connectionState?: 'unpaired' | 'paired' | 'connecting' | 'online' | 'offline' | 'revoked';
  online?: boolean;
  label?: string;
  locationName?: string;
  location?: 'server' | 'computer';
  hostId?: string;
  projectName?: string;
};
type Selection = { origin: NativeConversationRef['origin']; nativeId: string };
type ComputerTarget =
  { origin: 'computer'; deviceId: string } | { origin: 'remote'; connectionId: string };
type ManagedProject = {
  target: ConversationTarget;
  name: string;
  originalName?: string;
  removedAt?: string | null;
  revision: number;
};
type ManagedComputer = {
  target: ComputerTarget;
  name: string;
  removedAt?: string | null;
  revision: number;
  hostId?: string;
};
type ProjectManagement = { projects: ManagedProject[]; computers: ManagedComputer[] };
type ConversationCatalogue = {
  conversations: UnifiedConversation[];
  targets?: ConversationTarget[];
  preferences?: { defaultBackend: 'pi' | 'dsh' };
};
export type ConversationPreparation = {
  id: string;
  target: ConversationTarget;
  draft: string;
  createdAt: string;
  state: 'creating' | 'ready' | 'unknown' | 'failed' | 'handed';
  error: string;
  native?: Selection;
  resumeRequired?: boolean;
  message?: { id: string; text: string };
};
type Model = {
  preparations: ConversationPreparation[];
  preparing: ConversationPreparation | null;
  selectPreparation: (id: string) => void;
  preparationDraft: (id: string, text: string) => void;
  preparationQueue: (id: string, text: string) => void;
  preparationEdit: (id: string) => void;
  retryPreparation: (id: string) => Promise<void>;
  resumePreparation: (id: string) => void;
  claimPreparation: (id: string) => ConversationPreparation | null;
  finishPreparation: (id: string) => void;
  discardPreparation: (id: string) => void;
  openPreparedConversation: (id: string) => void;
  settings: Settings;
  owner: string;
  conversations: UnifiedConversation[];
  targets: ConversationTarget[];
  selected: Selection | null;
  defaultBackend: 'pi' | 'dsh';
  ready: boolean;
  targetsLoading: boolean;
  targetsError: string;
  refreshTargets: () => Promise<void>;
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
  management: ProjectManagement;
  refreshManagement: () => Promise<ProjectManagement>;
  removeProject: (project: ManagedProject) => Promise<void>;
  restoreProject: (project: ManagedProject) => Promise<void>;
  removeComputer: (computer: ManagedComputer) => Promise<void>;
  importSession: (target: ConversationTarget, sessionId: string) => Promise<void>;
  sessions: (target: ConversationTarget) => Promise<RemoteSession[]>;
};
type RemoteSession = { id: string; title: string; workspaceIds: string[]; running?: boolean };
const projectKey = (t: ConversationTarget) =>
  JSON.stringify([t.origin, t.connectionId || t.deviceId || null, t.projectId]);
const computerKey = (t: ComputerTarget) =>
  JSON.stringify([t.origin, t.origin === 'computer' ? t.deviceId : t.connectionId]);
const computerFor = (t: ConversationTarget): ComputerTarget | null =>
  t.origin === 'computer' && t.deviceId
    ? { origin: 'computer', deviceId: t.deviceId }
    : t.origin === 'remote' && t.connectionId
      ? { origin: 'remote', connectionId: t.connectionId }
      : null;
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

function toggleNavigationBranch(
  event: MouseEvent<HTMLDetailsElement>,
  update: (expanded: boolean) => void,
) {
  // Keep React as the owner of `open`. Native toggles are asynchronous and can
  // otherwise leave a just-collapsed branch closed when search forces it open.
  const summary = (event.target as Element).closest('summary');
  if (event.defaultPrevented || summary?.parentElement !== event.currentTarget) return;
  event.preventDefault();
  update(!event.currentTarget.open);
}

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
  const preparationJournal = useRef(createConversationPreparationJournal(localStorage, storageKey));
  const [preparations, setPreparations] = useState<ConversationPreparation[]>(
    () => preparationJournal.current.list() as ConversationPreparation[],
  );
  const [preparationId, setPreparationId] = useState<string | null>(() => {
    const id = localStorage.getItem(storageKey + ':preparation-selection');
    return preparationJournal.current.list().some((v: ConversationPreparation) => v.id === id)
      ? id
      : null;
  });
  const preparationSelection = useRef(preparationId);
  const preparationRequests = useRef(new Set<string>());
  const preparationAlive = useRef(true);
  useEffect(() => {
    preparationAlive.current = true;
    return () => {
      preparationAlive.current = false;
    };
  }, []);
  function showPreparation(id: string | null) {
    preparationSelection.current = id;
    setPreparationId(id);
    try {
      if (id) localStorage.setItem(storageKey + ':preparation-selection', id);
      else localStorage.removeItem(storageKey + ':preparation-selection');
    } catch {
      /* Keep navigation responsive; durable intent is still in the journal. */
    }
  }
  function updatePreparations() {
    setPreparations([...preparationJournal.current.list()] as ConversationPreparation[]);
  }
  function resolvePreparation(id: string, ref: Selection) {
    preparationJournal.current.resolve(id, ref);
    updatePreparations();
    if (preparationSelection.current === id) {
      setSelected(ref);
      saveUnifiedSelection(localStorage, storageKey, ref);
    }
  }
  const aliasStorageKey = 'astral.dsh.projectNames:' + settings.url + ':' + owner;
  const [projectAliases, setProjectAliases] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(aliasStorageKey) || '{}');
    } catch {
      return {};
    }
  });
  const [initialCache] = useState(() => {
    const catalogue = peekAPI<ConversationCatalogue>(settings, endpoint + '?targets=deferred');
    const directory = peekAPI<{ targets: ConversationTarget[] }>(settings, '/assistant/targets');
    const piDirectory = peekAPI<{ targets: ConversationTarget[] }>(
      settings,
      '/assistant/targets?backend=pi',
    );
    return {
      management: peekAPI<ProjectManagement>(settings, '/assistant/project-management'),
      catalogue,
      targets: [
        ...(piDirectory?.targets || directory?.targets || catalogue?.targets || []).filter(
          (t) => t.origin !== 'remote',
        ),
        ...(directory?.targets || []).filter((t) => t.origin === 'remote'),
      ],
      directoryReady: !!(piDirectory || directory),
    };
  });
  const [management, setManagement] = useState<ProjectManagement>(
    () => initialCache.management || { projects: [], computers: [] },
  );
  const [managementReady, setManagementReady] = useState(!!initialCache.management);
  const managementRead = useRef(0);
  const refreshManagement = useCallback(async () => {
    const read = ++managementRead.current;
    const result = await api<ProjectManagement>(
      settings,
      '/assistant/project-management',
      undefined,
      undefined,
      false,
      { fresh: true },
    );
    if (managementRead.current === read) {
      setManagement(result);
      setManagementReady(true);
    }
    return result;
  }, [settings]);
  useEffect(() => {
    const load = () => {
      void refreshManagement().catch((e) => setError(e.message));
    };
    load();
    const timer = setInterval(load, 15000);
    window.addEventListener('focus', load);
    window.addEventListener('astral:computer-changed', load);
    return () => {
      managementRead.current++;
      clearInterval(timer);
      window.removeEventListener('focus', load);
      window.removeEventListener('astral:computer-changed', load);
    };
  }, [refreshManagement]);
  const [conversations, setConversations] = useState<UnifiedConversation[]>(() =>
    (initialCache.catalogue?.conversations || []).map((conversation) => ({
      ...conversation,
      // Restored content is readable, but the previous process cannot certify
      // whether this native session is still running or safe to switch.
      runState: { busy: true, label: '正在同步最新状态' },
    })),
  );
  const [targets, setTargets] = useState<ConversationTarget[]>(() => initialCache.targets);
  const [defaultBackend, setDefaultBackend] = useState<'pi' | 'dsh'>(
    () => initialCache.catalogue?.preferences?.defaultBackend || 'pi',
  );
  const [ready, setReady] = useState(!!initialCache.catalogue),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [targetsLoading, setTargetsLoading] = useState(true),
    [targetsError, setTargetsError] = useState('');
  const generation = useRef(0),
    historyRead = useRef(0),
    targetGeneration = useRef(0),
    piDirectoryReady = useRef(initialCache.directoryReady),
    mutationLock = useRef(false);
  const operationIds = useRef(createUnifiedOperationJournal(localStorage, storageKey));
  const refresh = useCallback(async () => {
    const born = generation.current,
      read = ++historyRead.current;
    const result = await api<ConversationCatalogue>(
      settings,
      endpoint + '?targets=deferred',
      undefined,
      undefined,
      false,
      {
        fresh: true,
        timeout: 12000,
      },
    );
    if (generation.current !== born || historyRead.current !== read || mutationLock.current) return;
    setConversations(result.conversations);
    for (const pending of preparationJournal.current.list() as ConversationPreparation[]) {
      const found = result.conversations.find((c) => c.id === pending.id);
      if (found && !['ready', 'handed'].includes(pending.state))
        resolvePreparation(pending.id, found.active);
    }
    setSelected((old) => {
      const next = activeUnifiedSelection(result.conversations, old);
      if (next && (next.origin !== old?.origin || next.nativeId !== old?.nativeId)) {
        saveUnifiedSelection(localStorage, storageKey, next);
        return next;
      }
      return old;
    });
    // Deferred history contains only a partial server directory on a cold server.
    // Once a directory read completes, polling must not erase those Pi projects.
    if (result.targets)
      setTargets((old) => [
        ...(piDirectoryReady.current
          ? old.filter((t) => t.origin === 'server')
          : result.targets!.filter((t) => t.origin === 'server')),
        ...result.targets!.filter((t) => t.origin === 'computer'),
        ...old.filter((t) => t.origin === 'remote'),
      ]);
    if (result.preferences) setDefaultBackend(result.preferences.defaultBackend);
    setReady(true);
    setError('');
  }, [settings, storageKey]);
  const targetRead = useRef<Promise<void> | null>(null);
  const refreshTargets = useCallback(() => {
    if (targetRead.current) return targetRead.current;
    const born = targetGeneration.current;
    setTargetsLoading(true);
    let piApplied = false;
    const readDirectory = (pi: boolean) =>
      api<{ targets: ConversationTarget[] }>(
        settings,
        '/assistant/targets' + (pi ? '?backend=pi' : ''),
        undefined,
        undefined,
        false,
        { fresh: true, timeout: pi ? 8000 : 25000 },
      ).then((result) => {
        if (targetGeneration.current !== born) return;
        piDirectoryReady.current = true;
        if (pi) {
          piApplied = true;
          setTargets((old) => [
            ...result.targets.filter((t) => t.origin !== 'remote'),
            ...old.filter((t) => t.origin === 'remote'),
          ]);
        } else {
          setTargets((old) => [
            ...(piApplied ? old : result.targets).filter((t) => t.origin !== 'remote'),
            ...result.targets.filter((t) => t.origin === 'remote'),
          ]);
        }
      });
    // Pi projects become selectable as soon as their own read finishes, even
    // when an unrelated DPH host is still loading or times out.
    const read = Promise.allSettled([readDirectory(true), readDirectory(false)])
      .then((outcomes) => {
        if (targetGeneration.current !== born) return;
        const failure = outcomes.find((r) => r.status === 'rejected');
        setTargetsError(failure?.status === 'rejected' ? failure.reason.message : '');
      })
      .finally(() => {
        if (targetRead.current === read) {
          targetRead.current = null;
          setTargetsLoading(false);
        }
      });
    targetRead.current = read;
    return read;
  }, [settings]);
  useEffect(() => {
    void refreshTargets();
    const reloadTargets = () => {
      if (!document.hidden) void refreshTargets();
    };
    const timer = setInterval(reloadTargets, 15000);
    window.addEventListener('focus', reloadTargets);
    window.addEventListener('astral:computer-changed', reloadTargets);
    return () => {
      targetGeneration.current++;
      piDirectoryReady.current = false;
      targetRead.current = null;
      clearInterval(timer);
      window.removeEventListener('focus', reloadTargets);
      window.removeEventListener('astral:computer-changed', reloadTargets);
    };
  }, [refreshTargets]);
  useEffect(() => {
    let live = true,
      loading = false;
    const load = async () => {
      if (loading || document.hidden) return;
      loading = true;
      const born = generation.current;
      try {
        await refresh();
      } catch (e) {
        if (live && generation.current === born) setError((e as Error).message);
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
      const preparation = preparationJournal.current
        .list()
        .find((v: ConversationPreparation) => v.id === preparationSelection.current) as
        ConversationPreparation | undefined;
      if (
        preparation?.native?.origin !== value.origin ||
        preparation.native.nativeId !== value.nativeId
      )
        showPreparation(null);
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
      // Ignore reads started before this mutation. A successful create/switch
      // already returns the authoritative record; catalogue refresh is independent.
      generation.current++;
      await work();
      const completed = ++generation.current;
      queueMicrotask(
        () =>
          void refresh().catch((e) => {
            if (generation.current === completed) setError((e as Error).message);
          }),
      );
    } catch (e) {
      setError((e as Error).message);
      throw e;
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  }
  async function createPreparedConversation(id: string) {
    if (preparationRequests.current.has(id)) return;
    const value = preparationJournal.current
      .list()
      .find((v: ConversationPreparation) => v.id === id) as ConversationPreparation | undefined;
    if (!value || value.state === 'handed') return;
    preparationRequests.current.add(id);
    generation.current++;
    try {
      preparationJournal.current.creating(id);
      updatePreparations();
      const r = await api<{ conversation: UnifiedConversation }>(settings, endpoint, {
        id,
        target: targetBody(value.target),
      });
      if (
        !preparationAlive.current ||
        !preparationJournal.current.list().some((v: ConversationPreparation) => v.id === id)
      )
        return;
      generation.current++;
      setConversations((old) => [r.conversation, ...old.filter((c) => c.id !== r.conversation.id)]);
      resolvePreparation(id, r.conversation.active);
      operationIds.current.complete('create:' + JSON.stringify(targetBody(value.target)));
    } catch (e) {
      if (
        !preparationAlive.current ||
        !preparationJournal.current.list().some((v: ConversationPreparation) => v.id === id)
      )
        return;
      const reason = e as Error & { status?: number };
      try {
        preparationJournal.current.fail(
          id,
          reason.message,
          [400, 401, 403, 404, 413].includes(reason.status || 0),
        );
      } catch {
        setError('本地准备记录保存失败，请保留当前内容后重试。');
      }
      updatePreparations();
    } finally {
      preparationRequests.current.delete(id);
    }
  }
  return (
    <Context.Provider
      value={{
        preparations,
        preparing: preparations.find((v) => v.id === preparationId) || null,
        selectPreparation: (id) => {
          const value = preparationJournal.current
            .list()
            .find((v: ConversationPreparation) => v.id === id) as
            ConversationPreparation | undefined;
          if (!value) return;
          showPreparation(id);
          if (value.native) {
            setSelected(value.native);
            saveUnifiedSelection(localStorage, storageKey, value.native);
          }
        },
        preparationDraft: (id, text) => {
          try {
            preparationJournal.current.draft(id, text);
          } finally {
            updatePreparations();
          }
        },
        preparationQueue: (id, text) => {
          preparationJournal.current.queue(id, text);
          updatePreparations();
        },
        preparationEdit: (id) => {
          preparationJournal.current.edit(id);
          updatePreparations();
        },
        retryPreparation: createPreparedConversation,
        resumePreparation: (id) => {
          preparationJournal.current.resume(id);
          updatePreparations();
        },
        claimPreparation: (id) => {
          if (preparationSelection.current !== id) return null;
          try {
            return preparationJournal.current.claim(id) as ConversationPreparation | null;
          } finally {
            updatePreparations();
          }
        },
        finishPreparation: (id) => {
          try {
            preparationJournal.current.remove(id);
          } catch {
            setError('消息已交给发送流程，但本地草稿清理失败；不会自动重复发送。');
          }
          updatePreparations();
          if (preparationSelection.current === id) showPreparation(null);
        },
        discardPreparation: (id) => {
          const value = preparationJournal.current
            .list()
            .find((v: ConversationPreparation) => v.id === id) as
            ConversationPreparation | undefined;
          if (!value) return;
          // Remove durable local intent first. This does not cancel an already
          // issued create/submission or delete the actual native conversation.
          preparationJournal.current.remove(id);
          setError('');
          operationIds.current.complete('create:' + JSON.stringify(targetBody(value.target)));
          generation.current++;
          updatePreparations();
          if (preparationSelection.current === id) showPreparation(null);
        },
        openPreparedConversation: (id) => {
          const value = preparationJournal.current
            .list()
            .find((v: ConversationPreparation) => v.id === id) as
            ConversationPreparation | undefined;
          if (value?.native) {
            setSelected(value.native);
            saveUnifiedSelection(localStorage, storageKey, value.native);
            showPreparation(null);
          }
        },
        settings,
        owner,
        conversations: managementReady ? conversations : [],
        targets: managementReady
          ? targets.filter(
              (t) =>
                !management.projects.some(
                  (p) => p.removedAt && projectKey(p.target) === projectKey(t),
                ) &&
                !management.computers.some(
                  (c) =>
                    c.removedAt &&
                    computerFor(t) &&
                    computerKey(c.target) === computerKey(computerFor(t)!),
                ),
            )
          : [],
        management,
        refreshManagement,
        selected,
        defaultBackend,
        ready: ready && managementReady,
        targetsLoading,
        targetsError,
        refreshTargets,
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
        create: async (target) => {
          const key = 'create:' + JSON.stringify(targetBody(target));
          const id = operationIds.current.id(key);
          preparationJournal.current.begin(id, target);
          updatePreparations();
          showPreparation(id);
          void createPreparedConversation(id);
        },
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
            setConversations((old) => [
              r.conversation,
              ...old.filter((c) => c.id !== r.conversation.id),
            ]);
            select(r.conversation.active);
            operationIds.current.complete(key);
          }),
        patch: async (c, patch) => {
          await mutate(async () => {
            const result = await api<{ conversation: UnifiedConversation }>(
              settings,
              `${endpoint}/${c.id}`,
              patch,
              'PATCH',
            );
            setConversations((old) =>
              old.map((item) => (item.id === c.id ? result.conversation : item)),
            );
          });
        },
        remove: async (c) =>
          mutate(async () => {
            await api(settings, `${endpoint}/${c.id}`, undefined, 'DELETE');
            setConversations((old) => old.filter((item) => item.id !== c.id));
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
          management.projects.find((p) => projectKey(p.target) === projectKey(target))?.name ||
          (target.origin === 'remote'
            ? projectAliases[target.connectionId + ':' + target.projectId]
            : '') ||
          target.projectName ||
          target.label ||
          target.projectId ||
          '独立对话',
        renameProject: async (target, name) => {
          if (!target.projectId) return;
          await api(
            settings,
            '/assistant/project-management/display-name',
            { target: targetBody(target), name },
            'PUT',
          );
          const aliases = { ...projectAliases };
          delete aliases[target.connectionId + ':' + target.projectId];
          localStorage.setItem(aliasStorageKey, JSON.stringify(aliases));
          setProjectAliases(aliases);
          await refreshManagement();
        },
        removeProject: async (project) =>
          mutate(async () => {
            await api(settings, '/assistant/project-management/remove', {
              target: targetBody(project.target),
              revision: project.revision,
            });
            await refreshManagement();
          }),
        restoreProject: async (project) =>
          mutate(async () => {
            await api(settings, '/assistant/project-management/restore', {
              target: targetBody(project.target),
              revision: project.revision,
            });
            await refreshManagement();
          }),
        removeComputer: async (computer) =>
          mutate(async () => {
            await api(settings, '/assistant/computer-management/remove', {
              target: computer.target,
              revision: computer.revision,
            });
            await refreshManagement();
            window.dispatchEvent(new Event('astral:computer-changed'));
          }),
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
  const [choice, setChoice] = useState<'pi' | 'dsh' | null>(null);
  if (!model) return null;
  const activeBackend = c?.active.runtime.backend || (origin === 'remote' ? 'dsh' : 'pi');
  return (
    <div className="conversation-engine-setting">
      <span>本对话引擎</span>
      <div className="conversation-backend-buttons" role="group" aria-label="本对话执行引擎">
        {(['pi', 'dsh'] as const).map((value) => (
          <button
            key={value}
            type="button"
            className="secondary"
            aria-pressed={activeBackend === value}
            disabled={model.busy || !!c?.runState?.busy || (activeBackend === value && !!c)}
            onClick={() => setChoice(value)}
          >
            {value === 'pi' ? 'Pi' : 'DPH'}
          </button>
        ))}
      </div>
      {c?.runState?.busy && <small>{c.runState.label}，结束并核定后可切换。</small>}
      {!c && <small>选择本对话的引擎和实际执行位置，当前草稿会保留。</small>}
      {choice && (
        <ConversationTargetDialog
          title="选择本对话引擎与位置"
          close={() => setChoice(null)}
          current={c?.active}
          backend={choice}
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
  const [engine, setEngine] = useState<'pi' | 'dsh'>(
    () =>
      backend ||
      (preferred
        ? preferred.origin === 'remote'
          ? 'dsh'
          : 'pi'
        : current
          ? current.runtime.backend === 'pi'
            ? 'dsh'
            : 'pi'
          : model.defaultBackend),
  );
  const targets = model.targets.filter((t) => (t.origin === 'remote' ? 'dsh' : 'pi') === engine);
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
          : '为本对话选择引擎与实际执行位置，不会更改新对话的默认设置。'}
      </p>
      <div className="conversation-backend-buttons" role="group" aria-label="选择执行引擎">
        {(['pi', 'dsh'] as const).map((value) => (
          <button
            key={value}
            type="button"
            className="secondary"
            aria-pressed={engine === value}
            disabled={pending || (!!current && current.runtime.backend === value)}
            onClick={() => {
              setEngine(value);
              setError('');
            }}
          >
            {value === 'pi' ? 'Pi' : 'DPH'}
          </button>
        ))}
      </div>
      <div className="conversation-targets">
        {orderedTargets.map((target, index) => (
          <button
            type="button"
            className="secondary"
            key={JSON.stringify(targetBody(target))}
            disabled={pending || model.busy}
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
              {target.origin === 'remote' ? 'DPH' : 'Pi'} ·{' '}
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
        <p className="field-help" role="status">
          {engine === 'dsh' && model.targetsLoading
            ? '正在读取 DPH 工作区，Pi 项目可直接选择。'
            : engine === 'dsh'
              ? '尚无可用的 DPH 工作区。已配对的 Pi 电脑不会自动变成 DPH；需在连接设置中关联该电脑的 DPH Remote。'
              : '没有可用的 Pi 项目，请检查原电脑连接与项目授权。'}
        </p>
      )}
      {model.targetsError && (
        <p className="field-help" role="status">
          部分工作区暂未读取完成。
          <button
            type="button"
            className="text-link"
            disabled={model.targetsLoading}
            onClick={() => void model.refreshTargets()}
          >
            重新读取工作区
          </button>
        </p>
      )}
      {pending && (
        <p className="field-help" role="status">
          正在建立所选对话…
        </p>
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
  const [removed, setRemoved] = useState(false);
  const [removal, setRemoval] = useState<{
    project?: ManagedProject;
    computer?: ManagedComputer;
  } | null>(null);
  const [menu, setMenu] = useState<MenuAnchor | null>(null),
    [editing, setEditing] = useState<UnifiedConversation | null>(null);
  const [deleting, setDeleting] = useState<UnifiedConversation | null>(null);
  const [error, setError] = useState('');
  const [newTarget, setNewTarget] = useState<ConversationTarget | undefined>();
  const [projectSetup, setProjectSetup] = useState<ProjectSetupComputer[] | null>(null);
  const [query, setQuery] = useState('');
  const [projectExpansion, setProjectExpansion] = useState<Record<string, boolean>>({});
  const [workspaceExpansion, setWorkspaceExpansion] = useState<Record<string, boolean>>({});
  const [locationExpansion, setLocationExpansion] = useState<Record<string, boolean>>({});
  const more = useRef<HTMLDetailsElement>(null);
  const open = displayPanel === 'conversations';
  const visible = removed
    ? model.conversations
    : visibleConversations(
        model.conversations.filter((c) => !model.preparations.some((p) => p.id === c.id)),
        archived,
      );
  const search = query.trim().toLocaleLowerCase();
  const selected = (c: UnifiedConversation) =>
    model.selected?.origin === c.active.origin && model.selected.nativeId === c.active.nativeId;
  const removedProjects = model.management.projects.filter((p) => p.removedAt);
  const removedComputers = model.management.computers.filter((c) => c.removedAt);
  const matchingRemovedComputers = removedComputers.filter(
    (c) => !search || c.name.toLocaleLowerCase().includes(search),
  );
  function isRemoved(target: ConversationTarget) {
    const computer = computerFor(target);
    return (
      removedProjects.some((p) => projectKey(p.target) === projectKey(target)) ||
      (!!computer && removedComputers.some((c) => computerKey(c.target) === computerKey(computer)))
    );
  }
  type Group = {
    title: string;
    target: ConversationTarget;
    items: UnifiedConversation[];
    available: boolean;
  };
  const groups = new Map<string, Group>();
  if (!archived && !removed)
    for (const target of model.targets)
      groups.set(projectKey(target), {
        title: target.locationName || (target.origin === 'server' ? '服务器' : '电脑'),
        target,
        items: [],
        available: true,
      });
  if (!archived && !removed)
    for (const pending of model.preparations) {
      const key = projectKey(pending.target);
      if (!groups.has(key))
        groups.set(key, {
          title:
            pending.target.locationName || (pending.target.origin === 'server' ? '服务器' : '电脑'),
          target: pending.target,
          items: [],
          available: model.targets.some((t) => projectKey(t) === key),
        });
    }
  const pendingIn = (target: ConversationTarget) =>
    !archived && !removed
      ? model.preparations.filter(
          (p) =>
            projectKey(p.target) === projectKey(target) &&
            (!search ||
              [p.draft, p.message?.text, model.projectName(p.target)]
                .filter(Boolean)
                .some((v) => v!.toLocaleLowerCase().includes(search))),
        )
      : [];
  for (const c of visible) {
    const first = c.segments[0] || c.active;
    const runtime = first.runtime;
    const target = model.targets.find((t) => matchesRuntime(t, first)) ||
      model.management.projects.find((p) => matchesRuntime(p.target, first))?.target || {
        origin: first.origin,
        projectId: runtime.projectId,
        location: runtime.location,
        ...(runtime.deviceId ? { hostId: runtime.deviceId } : {}),
        ...(runtime.deviceId && first.origin === 'computer' ? { deviceId: runtime.deviceId } : {}),
        ...(runtime.connectionId ? { connectionId: runtime.connectionId } : {}),
      };
    const key = projectKey(target);
    if (isRemoved(target) !== removed) continue;
    if (!groups.has(key))
      groups.set(key, {
        title: target.locationName || (runtime.location === 'server' ? '服务器' : '电脑'),
        target,
        items: [],
        available: model.targets.some((t) => projectKey(t) === key),
      });
    groups.get(key)!.items.push(c);
  }
  if (removed)
    for (const project of removedProjects) {
      const key = projectKey(project.target);
      if (!groups.has(key))
        groups.set(key, {
          title:
            project.target.locationName || (project.target.origin === 'server' ? '服务器' : '电脑'),
          target: project.target,
          items: [],
          available: false,
        });
    }
  const matches = (group: Group, c?: UnifiedConversation) =>
    !search ||
    [c?.title, group.title, model.projectName(group.target)]
      .filter(Boolean)
      .some((value) => value!.toLocaleLowerCase().includes(search));
  const filteredGroups = [...groups]
    .map(([key, group]) => ({
      key,
      ...group,
      items: group.items.filter((c) => matches(group, c)),
    }))
    .filter(
      (group) =>
        group.items.length ||
        pendingIn(group.target).length ||
        (group.target.projectId && matches(group)),
    );
  const workspaceKey = (target: ConversationTarget) => {
    const identity = target.connectionId || target.deviceId || target.origin;
    const value = target.workspaceId || target.workspacePath || 'unassigned';
    return JSON.stringify([target.origin, identity, value]);
  };
  const workspaceName = (target: ConversationTarget) =>
    target.workspaceName ||
    (target.workspacePath ? target.workspacePath.split('/').filter(Boolean).at(-1) : '') ||
    '未分组';
  function workspaceFolders(groups: typeof filteredGroups) {
    const folders = new Map<string, { key: string; title: string; target: ConversationTarget; groups: typeof filteredGroups }>();
    for (const group of groups) {
      const key = workspaceKey(group.target);
      if (!folders.has(key))
        folders.set(key, { key, title: workspaceName(group.target), target: group.target, groups: [] });
      folders.get(key)!.groups.push(group);
    }
    return [...folders.values()];
  }
  function connectionStatus(location: { server: boolean; groups: typeof filteredGroups }) {
    if (location.server) return '';
    if (!location.groups.length) return '已配对';
    const states = location.groups.map((group) => group.target.connectionState).filter(Boolean);
    if (states.includes('revoked')) return '已撤销';
    if (states.includes('online') || location.groups.some((group) => group.target.online)) return '在线';
    if (states.includes('connecting')) return '连接中';
    if (states.includes('offline')) return '离线';
    if (states.includes('paired')) return '已配对';
    return '已连接';
  }
  const locations = new Map<
    string,
    { title: string; server: boolean; groups: typeof filteredGroups }
  >();
  if (
    !archived &&
    !removed &&
    !search &&
    model.targets.some((target) => target.origin === 'server' || target.location === 'server')
  ) {
    locations.set('server', { title: '服务器', server: true, groups: [] });
  }
  for (const group of filteredGroups) {
    if (!group.target.projectId && !group.items.length && !pendingIn(group.target).length) continue;
    const home = group.items[0]?.segments[0] || group.items[0]?.active;
    const server =
      (group.target.location ||
        home?.runtime.location ||
        (group.target.origin === 'server' ? 'server' : 'computer')) === 'server';
    const key = server
      ? 'server'
      : JSON.stringify([
          'computer',
          group.target.hostId || group.target.deviceId || group.target.connectionId,
        ]);
    if (!locations.has(key))
      locations.set(key, { title: server ? '服务器' : group.title, server, groups: [] });
    locations.get(key)!.groups.push(group);
  }
  if (!archived && !removed && !search)
    for (const computer of model.management.computers.filter((c) => !c.removedAt)) {
      const key = JSON.stringify([
        'computer',
        computer.hostId ||
          (computer.target.origin === 'computer'
            ? computer.target.deviceId
            : computer.target.connectionId),
      ]);
      if (!locations.has(key))
        locations.set(key, { title: computer.name, server: false, groups: [] });
    }
  function locationComputers(locationKey: string, groups: typeof filteredGroups) {
    return model.management.computers.filter(
      (computer) =>
        !computer.removedAt &&
        (JSON.stringify([
          'computer',
          computer.hostId ||
            (computer.target.origin === 'computer'
              ? computer.target.deviceId
              : computer.target.connectionId),
        ]) === locationKey ||
          groups.some((g) => {
            const t = computerFor(g.target);
            return t && computerKey(t) === computerKey(computer.target);
          })),
    );
  }
  function projectSetupComputers(
    locationKey: string,
    location: { title: string; groups: typeof filteredGroups },
  ) {
    const computers = new Map<string, ProjectSetupComputer>();
    for (const computer of locationComputers(locationKey, location.groups))
      computers.set(computerKey(computer.target), computer);
    for (const group of location.groups) {
      const target = computerFor(group.target);
      if (target && !computers.has(computerKey(target)))
        computers.set(computerKey(target), { target, name: location.title });
    }
    return [...computers.values()];
  }
  function row(c: UnifiedConversation) {
    return (
      <ConversationRow
        key={c.id}
        conversation={c}
        selected={selected(c)}
        disabled={model.busy}
        choose={() => {
          model.select(c.active);
          setPanel(null);
        }}
        openMenu={setMenu}
        detail={
          <>
            {c.active.runtime.backend === 'dsh' ? 'DPH' : 'Pi'}
            {' · '}
            {c.runState?.busy ? c.runState.label : dateLabel(c.updatedAt)}
          </>
        }
      />
    );
  }
  function showArchive(value: boolean) {
    setArchived(value);
    setRemoved(false);
    setQuery('');
    if (more.current) more.current.open = false;
  }
  async function askProjectRemoval(target: ConversationTarget) {
    try {
      const latest = await model.refreshManagement();
      // Read the latest entry in the dialog instead of confirming a catalogue
      // name whose permissions may have changed while the menu was open.
      const project = latest.projects.find((p) => projectKey(p.target) === projectKey(target));
      if (!project) throw Error('项目目录尚未读取完成，请刷新后重试。');
      setRemoval({ project });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  function sameDirectory(c: UnifiedConversation) {
    const first = c.segments[0] || c.active;
    const target = model.targets.find((t) => matchesRuntime(t, first));
    if (!target) {
      setError('原项目已移除或暂不可用，请先恢复项目或选择其他执行位置。');
      return;
    }
    setNewTarget(target);
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
        <div className="unified-navigation-controls">
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
          <label className="unified-navigation-search">
            <Search size={15} aria-hidden="true" />
            <input
              type="search"
              aria-label="搜索项目与对话"
              placeholder="搜索对话或项目"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
              }}
            />
          </label>
          {(archived || removed) && (
            <div className="unified-archive-heading">
              <button className="icon-btn" aria-label="返回对话" onClick={() => showArchive(false)}>
                <ArrowLeft size={16} />
              </button>
              <strong>{removed ? '已移除' : '已归档'}</strong>
              <small>
                {filteredGroups.reduce((count, group) => count + group.items.length, 0)}
              </small>
            </div>
          )}
        </div>
        <div className="unified-navigation-content">
          {(error || model.error) && (
            <p className="error" role="status">
              {error || model.error}
            </p>
          )}
          {[...locations].map(([locationKey, location]) => (
            <details
              key={locationKey}
              className="unified-location-tree"
              open={
                !!search ||
                (locationExpansion[locationKey] ??
                  (location.server ||
                    location.groups.some(
                      (group) =>
                        group.items.some(selected) ||
                        pendingIn(group.target).some((p) => p.id === model.preparing?.id),
                    )))
              }
              onClick={(event) =>
                toggleNavigationBranch(event, (expanded) => {
                  if (!search) setLocationExpansion((old) => ({ ...old, [locationKey]: expanded }));
                })
              }
            >
              {!location.server ? (
                <ManagementSummary
                  name={location.title}
                  className="unified-location-heading"
                  title="长按或右键管理电脑"
                  actions={[
                    ...(!archived && !removed && projectSetupComputers(locationKey, location).length
                      ? [
                          {
                            label: '添加项目',
                            icon: <Plus size={16} />,
                            run: () =>
                              setProjectSetup(projectSetupComputers(locationKey, location)),
                          },
                        ]
                      : []),
                    ...locationComputers(locationKey, location.groups).map((computer) => ({
                      label:
                        '删除电脑' +
                        (locationComputers(locationKey, location.groups).length > 1
                          ? computer.target.origin === 'computer'
                            ? '（Pi 连接）'
                            : '（DPH 连接）'
                          : ''),
                      icon: <Trash2 size={16} />,
                      danger: true,
                      run: () => {
                        void model
                          .refreshManagement()
                          .then((latest) => {
                            const current = latest.computers.find(
                              (c) => computerKey(c.target) === computerKey(computer.target),
                            );
                            if (current) setRemoval({ computer: current });
                          })
                          .catch((e) => setError(e.message));
                      },
                    })),
                  ]}
                >
                  <ChevronRight size={14} className="unified-location-caret" aria-hidden="true" />
                  <Monitor size={16} />
                  <span>{location.title}</span>
                  {!!connectionStatus(location) && (
                    <small className="unified-location-status">{connectionStatus(location)}</small>
                  )}
                  <small>
                    {location.groups.reduce((count, group) => count + group.items.length, 0) || ''}
                  </small>
                  {!archived &&
                    !removed &&
                    !!projectSetupComputers(locationKey, location).length && (
                      <button
                        className="icon-btn"
                        aria-label={'为' + location.title + '添加项目'}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setProjectSetup(projectSetupComputers(locationKey, location));
                        }}
                      >
                        <Plus size={15} />
                      </button>
                    )}
                </ManagementSummary>
              ) : (
                <summary className="unified-location-heading" title={location.title}>
                  <ChevronRight size={14} className="unified-location-caret" aria-hidden="true" />
                  <Server size={16} />
                  <span>{location.title}</span>
                  {!!connectionStatus(location) && (
                    <small className="unified-location-status">{connectionStatus(location)}</small>
                  )}
                  <small>
                    {location.groups.reduce((count, group) => count + group.items.length, 0) || ''}
                  </small>
                  {!archived && !removed && newProject && (
                    <button
                      className="icon-btn"
                      aria-label="新建服务器项目"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        newProject();
                      }}
                    >
                      <Plus size={15} />
                    </button>
                  )}
                </summary>
              )}
              <div className="unified-location-projects">
                {!location.groups.length && (
                  <p className="field-help">
                    {location.server
                      ? '点击加号创建项目文件夹。'
                      : '点击电脑旁的加号添加工作区文件夹。'}
                  </p>
                )}
                {workspaceFolders(location.groups).map((workspace) => (
                  <details
                    key={workspace.key}
                    className="workspace-folder-tree"
                    open={
                      !!search ||
                      (workspaceExpansion[workspace.key] ??
                        workspace.groups.some(
                          (group) =>
                            group.items.some(selected) ||
                            pendingIn(group.target).some((p) => p.id === model.preparing?.id),
                        ))
                    }
                    onClick={(event) =>
                      toggleNavigationBranch(event, (expanded) => {
                        if (!search)
                          setWorkspaceExpansion((old) => ({ ...old, [workspace.key]: expanded }));
                      })
                    }
                  >
                    <summary className="workspace-folder-heading">
                      <ChevronRight className="workspace-folder-caret" size={13} aria-hidden="true" />
                      <FolderOpen size={14} />
                      <span>{workspace.title}</span>
                      <small>{workspace.groups.length}</small>
                      {!archived && !removed && !search && (
                        <button
                          type="button"
                          className="icon-btn workspace-folder-add"
                          aria-label={'在' + workspace.title + '中新建项目'}
                          title="新建项目文件夹"
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            if (location.server && newProject) newProject();
                            else setProjectSetup(projectSetupComputers(locationKey, location));
                          }}
                        >
                          <Plus size={14} />
                        </button>
                      )}
                    </summary>
                    <div className="workspace-folder-projects">
                    {workspace.groups.map((group) => (
                      <details
                        key={group.key}
                        className="project-tree"
                        open={
                          !!search ||
                          (projectExpansion[group.key] ??
                            (group.items.some(selected) ||
                              pendingIn(group.target).some((p) => p.id === model.preparing?.id)))
                        }
                        onClick={(event) =>
                          toggleNavigationBranch(event, (expanded) => {
                            if (!search)
                              setProjectExpansion((old) => ({ ...old, [group.key]: expanded }));
                          })
                        }
                      >
                        {group.target.projectId ? (
                          <ProjectSummary
                            name={model.projectName(group.target)}
                            detail={group.items.length || ''}
                            saveName={(name) => model.renameProject(group.target, name)}
                            remove={!removed ? () => void askProjectRemoval(group.target) : undefined}
                            restore={
                              removedProjects.some((p) => projectKey(p.target) === group.key)
                                ? () => {
                                    const p = removedProjects.find(
                                      (p) => projectKey(p.target) === group.key,
                                    )!;
                                    void model.restoreProject(p).catch((e) => setError(e.message));
                                  }
                                : undefined
                            }
                            newConversation={
                              !removed && group.available
                                ? () => {
                                    setNewTarget(group.target);
                                    setNewOpen(true);
                                  }
                                : undefined
                            }
                          />
                        ) : (
                          <summary>
                            <ChevronRight className="project-tree-caret" size={14} aria-hidden="true" />
                            <FolderOpen size={15} />
                            <span>未分组</span>
                            <small>{group.items.length}</small>
                          </summary>
                        )}
                        <div className="unified-project-chats">
                      {pendingIn(group.target).map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className="conversation-preparation-row text-link"
                          onClick={() => {
                            model.selectPreparation(p.id);
                            setPanel(null);
                          }}
                        >
                          {p.message?.text.slice(0, 32) || p.draft.slice(0, 32) || '新对话'}
                          <small>
                            {p.target.origin === 'remote' ? 'DPH' : 'Pi'} ·{' '}
                            {p.state === 'creating'
                              ? '准备中'
                              : p.state === 'ready'
                                ? p.message
                                  ? '待发送，打开后继续'
                                  : '草稿就绪'
                                : '草稿已保留'}
                          </small>
                        </button>
                      ))}
                      {!group.available && (
                        <p className="field-help">
                          {removed
                            ? '已从列表移除，文件与历史记录仍保留。'
                            : '主机或项目暂不可用，已有记录仍保留。'}
                        </p>
                      )}
                      {search ? (
                        group.items.map((c) => row(c))
                      ) : (
                        <ProjectConversationList>
                          {group.items.map((c) => row(c))}
                        </ProjectConversationList>
                      )}
                      {!group.items.length && !removed && group.available && (
                        <p className="field-help">长按或右键项目可新建对话。</p>
                      )}
                      {!archived &&
                        !removed &&
                        group.target.origin === 'remote' &&
                        group.available && <RemoteSessionImports target={group.target} />}
                        </div>
                      </details>
                    ))}
                    </div>
                  </details>
                ))}
              </div>
            </details>
          ))}
          {!locations.size && !(removed && matchingRemovedComputers.length) && (
            <p className="field-help unified-navigation-empty">
              {!model.ready
                ? '正在读取项目与对话…'
                : search
                  ? '没有找到匹配的对话或项目。'
                  : removed
                    ? '没有已移除的项目或电脑记录。'
                    : archived
                      ? '还没有归档的对话。'
                      : '你的第一段对话从这里开始。'}
            </p>
          )}
          {removed &&
            matchingRemovedComputers.map((computer) => (
              <div className="unified-removed-computer" key={computerKey(computer.target)}>
                <Monitor size={16} />
                <div>
                  <strong>{computer.name}</strong>
                  <p className="field-help">连接已撤销。再次使用请重新配对或关联。</p>
                </div>
              </div>
            ))}
        </div>
        <div className="pi-navigation-footer unified-navigation-footer">
          <details ref={more} className="unified-navigation-more">
            <summary>
              <MoreHorizontal size={17} />
              <span>更多</span>
              <ChevronDown size={13} />
            </summary>
            <button className="pi-sidebar-control" onClick={() => showArchive(!archived)}>
              <Archive size={15} />
              <span>{archived ? '返回对话' : '已归档'}</span>
              <small>{model.conversations.filter((c) => c.archivedAt).length || ''}</small>
            </button>
            <button
              className="pi-sidebar-control"
              onClick={() => {
                setRemoved(!removed);
                setArchived(false);
                setQuery('');
                if (more.current) more.current.open = false;
              }}
            >
              <Trash2 size={15} />
              <span>{removed ? '返回对话' : '已移除'}</span>
              <small>{removedProjects.length + removedComputers.length || ''}</small>
            </button>
            <div
              onClick={() => {
                if (more.current) more.current.open = false;
              }}
            >
              {defaultDirectory}
            </div>
            <button
              className="pi-sidebar-control"
              onClick={() => {
                if (more.current) more.current.open = false;
                manage();
              }}
            >
              <Monitor size={15} />
              <span>管理电脑连接</span>
            </button>
            <button
              className="pi-sidebar-control"
              onClick={() => {
                if (more.current) more.current.open = false;
                void Promise.all([
                  model.refresh(),
                  model.refreshTargets(),
                  model.refreshManagement(),
                ]).catch((e) => setError(e.message));
              }}
            >
              <RefreshCw size={15} />
              <span>刷新项目与对话</span>
            </button>
          </details>
        </div>
      </aside>
      {projectSetup && (
        <ComputerProjectSetup
          computers={projectSetup}
          directoryError={model.targetsError}
          settings={model.settings}
          owner={model.owner}
          close={() => setProjectSetup(null)}
          refresh={async () => {
            await Promise.all([model.refreshTargets(), model.refreshManagement()]);
            window.dispatchEvent(new Event('astral:computer-changed'));
          }}
          manage={manage}
        />
      )}
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
      {removal && (
        <ManagementRemovalDialog
          key={
            removal.project
              ? projectKey(removal.project.target)
              : computerKey(removal.computer!.target)
          }
          value={removal}
          close={() => setRemoval(null)}
          submit={() =>
            removal.project
              ? model.removeProject(removal.project)
              : model.removeComputer(removal.computer!)
          }
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

function ManagementRemovalDialog({
  value,
  close,
  submit,
}: {
  value: { project?: ManagedProject; computer?: ManagedComputer };
  close: () => void;
  submit: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const project = value.project,
    name = project?.name || value.computer!.name;
  return (
    <ConversationDialog
      title={project ? '删除项目' : '删除电脑'}
      close={() => {
        if (!pending) close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          setPending(true);
          setError('');
          void submit()
            .then(close)
            .catch((e) => setError(e.message))
            .finally(() => setPending(false));
        }}
      >
        <p>
          {project
            ? `将「${name}」从当前账号的项目列表移除。`
            : value.computer!.target.origin === 'remote'
              ? `将撤销「${name}」的 DPH 连接及终端授权。远端任务可能继续运行。`
              : `将撤销「${name}」的 Pi 连接，并停止该连接上的任务和终端。`}
        </p>
        <p className="field-help">
          {project
            ? '实际文件夹、文件和历史对话会保留，可在“更多 → 已移除”查看并恢复项目。'
            : '电脑上的文件和历史对话会保留。再次使用需要重新配对或关联；其他独立连接不会被删除。'}
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="action-row">
          <button type="button" className="secondary" disabled={pending} onClick={close}>
            取消
          </button>
          <button type="submit" className="primary pi-delete-confirm" disabled={pending}>
            {pending ? '处理中…' : '确认删除'}
          </button>
        </div>
      </form>
    </ConversationDialog>
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
