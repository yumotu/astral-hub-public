import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Bot,
  Plus,
  Send,
  LoaderCircle,
  Trash2,
  RefreshCw,
  Code2,
  Square,
  Brain,
  WandSparkles,
  FolderOpen,
  ChevronsDown,
  Monitor,
  Mail,
  Paperclip,
  ShieldCheck,
  PanelRight,
  Menu,
  ChevronDown,
  X,
  TerminalSquare,
  Archive,
  ArrowLeft,
  MoreHorizontal,
  GitBranch,
  Pencil,
} from 'lucide-react';
import { CopyButton } from './CopyButton';
import { useMobilePanels } from './MobilePanels';
import { AssistantComposer } from './AssistantComposer';
import { AssistantUserMessage } from './AssistantUserMessage';
import './message-actions.css';
import { api, dateLabel } from './data';
import { peekAPI } from './resource-cache';
import type { Settings, AuthSession, PiTurn, PiContext, PiSessionContext, TodoItem } from './types';
import { FileWorkbenchProvider, FileWorkbenchPanel } from './FileWorkbench';
import { ApprovalControl } from './ApprovalControl';
import { SandboxNetworkControl } from './SandboxNetworkControl';
import { TaskActivity } from './TaskActivity';
import type { ServerProject } from './ProjectBrowser';
import { ProjectSummary } from './ProjectSummary';
import { ToolLog } from './ToolLog';
import { PiTimeline } from './PiTimeline';
import { FileChanges } from './FileChanges';
import { RunSummary, RunMetrics, SessionTelemetry } from './ExecutionInfo';
import { LongGoalCard } from './LongGoalCard';
import type { ToolRun } from './ToolLog';
import { RemoteAgentsPage } from './RemoteAgentsPage';
import { AssistantComputerProjects } from './AssistantComputerProjects';
import { ComputerAssistantView } from './ComputerAssistantView';
import { useAssistantComputers, type ComputerTarget } from './assistant-computers';
import { assistantTargetStorageKey, readAssistantTarget } from '../../shared/assistant-target.mjs';
import { serverIdentity } from './session';
import { commandMenu, completeCommand, type PiCommand, type PiSkill } from './pi-commands';
import { usePiTasks, taskPending, taskLabel, type PiTask } from './pi-tasks';
import { useMessageOutbox } from './message-outbox';
import { MessageOutbox } from './MessageOutbox';
import { PluginRequests } from './PluginRequests';
import { AppFunctionRequests } from './AppFunctionRequests';
import { TodoDropdown } from './TodoCard';
import { conversationTodo } from '../../shared/pi-activity.mjs';
import {
  conversationEntries,
  currentSessionContext,
  mergeSessionContext,
  messageDelivery,
} from '../../shared/pi-conversation.mjs';
import { conversationList, visibleConversations } from '../../shared/pi-conversation-list.mjs';
import {
  ConversationRow,
  ConversationMenu,
  ConversationEditor,
  DefaultDirectory,
  type Conversation,
  type MenuAnchor,
  type ConversationAction,
} from './ConversationMenu';
import { useTheme } from './Theme';
import { useAssistantPreferences } from './assistant-preferences';
import { ThinkingControl } from './ThinkingControl';
import { VoiceInput } from './VoiceInput';
import { AssistantMode } from './AssistantMode';
const TerminalPanel = lazy(() =>
  import('./TerminalPanel').then((module) => ({ default: module.TerminalPanel })),
);
import { MailAssistant } from './MailAssistant';
import { NewProject, ProjectPermissions } from './ProjectManager';
import { ChatFiles, uploadChatFile, type ChatFile } from './ChatFiles';
import { AssistantComposerActions } from './AssistantComposerActions';
import { AssistantSettings } from './AssistantSettings';
import { ProjectConversationList } from './ProjectConversationList';
import { attachmentSizeMessage } from '../../deploy/pi/attachment-limits.mjs';
import { insertPastedText } from './composer-paste';
import { useBackLayer } from './back-navigation';
const MarkdownView = lazy(() => import('./PiMarkdown').then((m) => ({ default: m.PiMarkdown })));
function PiMarkdown({ text }: { text: string }) {
  return (
    <Suspense fallback={<pre>{text}</pre>}>
      <MarkdownView text={text} />
    </Suspense>
  );
}
type Context = PiContext;
type Status = {
  available: boolean;
  version?: string;
  model?: string;
  nativeSessions?: boolean;
  streaming?: boolean;
  vision?: boolean;
  webSearch?: boolean;
  attachments?: boolean;
  pluginActivation?: {
    ready: boolean;
    checking: boolean;
    fallback: boolean;
    checkedAt?: string;
    diagnostic?: import('./types').PiRuntimeDiagnostic;
  };
};
export function PiPage(props: {
  settings: Settings;
  session: AuthSession | null;
  login: () => void;
  shellActions: ReactNode;
  openNavigation: () => void;
}) {
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [driver] = useState<'pi' | 'dsh'>('pi');
  const [mailAssistantOpen, setMailAssistantOpen] = useState(false);
  const options = useRef<HTMLDetailsElement>(null);
  useBackLayer(connectionsOpen, () => setConnectionsOpen(false), 90);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (options.current && !options.current.contains(event.target as Node))
        options.current.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  const workspaceActions = (
    <div className="workspace-header-actions">
      <details
        className="assistant-options"
        ref={options}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (options.current) options.current.open = false;
          }
        }}
      >
        <summary aria-label="助手选项" title="助手选项">
          <Bot size={16} />
          <span>Pi</span>
          <ChevronDown size={12} />
        </summary>
        <div className="assistant-options-menu">
          <span className="assistant-options-label">执行引擎</span>
          <span className="assistant-engine-current">
            <Bot size={15} />
            Pi<span>正在使用</span>
          </span>
          <span className="assistant-engine-pending">
            DeepSeek 原生后端<span>接入中</span>
          </span>
          {props.session && (
            <button
              onClick={() => {
                if (options.current) options.current.open = false;
                setMailAssistantOpen(true);
              }}
            >
              <Mail size={16} />
              邮件助手
            </button>
          )}
          {props.session && (
            <button
              onClick={() => {
                if (options.current) options.current.open = false;
                setConnectionsOpen(true);
              }}
            >
              <Monitor size={16} />
              管理电脑连接
            </button>
          )}
        </div>
      </details>
      {props.shellActions}
    </div>
  );
  return (
    <>
      {!props.session && (
        <header className="assistant-workspace-heading">
          <button
            className="mobile-menu icon-btn"
            aria-label="打开导航"
            onClick={props.openNavigation}
          >
            <Menu size={19} />
          </button>
          <h1>智能助手</h1>
          {workspaceActions}
        </header>
      )}
      <>
        <ServerPiPage
          key={`${props.settings.url}:${props.session?.user.id || 'guest'}`}
          driver={driver}
          workspaceActions={workspaceActions}
          openComputerConnections={() => setConnectionsOpen(true)}
          connectionsOpen={connectionsOpen}
          {...props}
        />
      </>
      {connectionsOpen && props.session && (
        <div
          className="assistant-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConnectionsOpen(false);
          }}
        >
          <section
            className="assistant-modal computer-connections-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="管理电脑连接"
          >
            <header className="workbench-heading">
              <Monitor size={18} />
              <strong>管理电脑连接</strong>
              <button
                className="icon-btn"
                aria-label="关闭电脑连接"
                onClick={() => setConnectionsOpen(false)}
              >
                <X size={18} />
              </button>
            </header>
            <RemoteAgentsPage settings={props.settings} owner={props.session.user.id} />
          </section>
        </div>
      )}
      {mailAssistantOpen && (
        <MailAssistant
          settings={props.settings}
          session={props.session}
          onClose={() => setMailAssistantOpen(false)}
        />
      )}
    </>
  );
}
function ServerPiPage({
  settings,
  session,
  login,
  driver,
  workspaceActions,
  openNavigation,
  openComputerConnections,
  connectionsOpen,
}: {
  workspaceActions: ReactNode;
  openNavigation: () => void;
  openComputerConnections: () => void;
  connectionsOpen: boolean;
  settings: Settings;
  session: AuthSession | null;
  login: () => void;
  driver: 'pi' | 'dsh';
}) {
  const viewKey = `astral.pi.last:${settings.url}:${session?.user.id || 'guest'}`;
  const computerKey = assistantTargetStorageKey(
    serverIdentity(settings),
    session?.user.id || 'guest',
  );
  const [computerTarget, setComputerTarget] = useState<ComputerTarget | null>(() =>
    readAssistantTarget(sessionStorage, computerKey),
  );
  const computers = useAssistantComputers(settings, !!session, session?.user.id);
  const computerGroup = computers.groups.find((g) => g.device.id === computerTarget?.deviceId);
  const computerProject = computerGroup?.projects.find((p) => p.id === computerTarget?.projectId);
  const [computerTitle, setComputerTitle] = useState<{ id: string; title: string } | null>(null);
  const titleChanged = (id: string, title: string) =>
    setComputerTitle((old) => (old?.id === id && old.title === title ? old : { id, title }));
  const remoteTitle =
    computerTarget && computerTitle?.id === computerTarget.conversationId
      ? computerTitle.title
      : computerTarget
        ? peekAPI<{ conversations: { id: string; title: string }[] }>(
            settings,
            '/relay/conversations?deviceId=' +
              computerTarget.deviceId +
              '&projectId=' +
              computerTarget.projectId +
              '&archived=include',
          )?.conversations.find((c) => c.id === computerTarget.conversationId)?.title || '新对话'
        : '';
  useEffect(() => {
    if (computerTarget) sessionStorage.setItem(computerKey, JSON.stringify(computerTarget));
    else sessionStorage.removeItem(computerKey);
  }, [computerTarget, computerKey]);
  useEffect(() => {
    if (!connectionsOpen) computers.refresh();
  }, [connectionsOpen, computers.refresh]);
  function selectComputer(target: ComputerTarget) {
    if (!computerTarget) {
      drafts.current.set(conversation, { input, staged, pending: pending.current, access });
      if (input.trim() || staged.length)
        setDraftConversations((old) => [
          ...old.filter((c) => c.id !== conversation),
          {
            id: conversation,
            title: input.trim().slice(0, 40) || '附件草稿',
            projectId: projectId || null,
            access,
            updatedAt: new Date().toISOString(),
          },
        ]);
    }
    setComputerTarget(target);
    setMobilePanel(null);
    setConversationMenu(null);
    setError('');
  }
  function newCurrentConversation() {
    if (computerTarget) selectComputer({ ...computerTarget, conversationId: crypto.randomUUID() });
    else void fresh();
  }
  const [conversation, setConversation] = useState(() => {
    try {
      return localStorage.getItem(viewKey) || crypto.randomUUID();
    } catch {
      return crypto.randomUUID();
    }
  });
  const [loadingHistory, setLoadingHistory] = useState(
    () => !peekAPI(settings, `/pi/conversations/${conversation}`),
  );
  const [draftConversations, setDraftConversations] = useState<Conversation[]>([]);
  const [status, setStatus] = useState<Status | null>(
      () => peekAPI<Status>(settings, '/pi/status') || null,
    ),
    [savedConversations, setConversations] = useState<Conversation[]>(
      () =>
        peekAPI<{ conversations: Conversation[] }>(settings, '/pi/conversations?archived=include')
          ?.conversations || [],
    ),
    [turns, setTurns] = useState<PiTurn[]>(
      () =>
        peekAPI<{ turns: PiTurn[] }>(settings, `/pi/conversations/${conversation}`)?.turns || [],
    ),
    [input, setInput] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [projects, setProjects] = useState<ServerProject[]>(
      () => peekAPI<{ projects: ServerProject[] }>(settings, '/pi/projects')?.projects || [],
    ),
    [projectId, setProjectId] = useState(() => {
      try {
        return localStorage.getItem(viewKey + ':project') || '';
      } catch {
        return '';
      }
    }),
    [access, setAccess] = useState<'read' | 'edit'>('read'),
    [browse, setBrowse] = useState(false),
    [failedTools, setFailedTools] = useState<ToolRun[]>([]);
  const [visible, setVisible] = useState(12),
    [more, setMore] = useState(true),
    [thinkingLevel, setThinkingLevel] = useState<'off' | 'low' | 'high' | 'max'>(() => {
      try {
        const value = localStorage.getItem('astral.pi.thinkingLevel');
        return ['off', 'low', 'high', 'max'].includes(value || '')
          ? (value as 'off' | 'low' | 'high' | 'max')
          : 'off';
      } catch {
        return 'off';
      }
    }),
    [sessionContext, setSessionContext] = useState<PiSessionContext | null>(null);
  const [manualCompacting, setCompacting] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const {
    displayPanel: mobilePanel,
    setPanel: setMobilePanel,
    setConversationsAvailable,
  } = useMobilePanels();
  const navigationOpen = mobilePanel === 'conversations';
  const setNavigationOpen = (open: boolean) => setMobilePanel(open ? 'conversations' : null);
  useEffect(() => {
    setConversationsAvailable(!!session);
    return () => setConversationsAvailable(false);
  }, [!!session, setConversationsAvailable]);
  const [conversationMenu, setConversationMenu] = useState<MenuAnchor | null>(null);
  const [conversationEditor, setConversationEditor] = useState<{
    conversation: Conversation;
    kind: 'rename' | 'delete';
  } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [directorySettings, setDirectorySettings] = useState(false);
  const [defaultProjectId, setDefaultProjectId] = useState<string | null>(null);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [emptyConversation, setEmptyConversation] = useState(false);
  const draftProjects = useRef(new Map<string, string>());
  const [projectPurpose, setProjectPurpose] = useState<'project' | 'default'>('project');
  const [deletedConversations, setDeletedConversations] = useState<string[]>([]);
  useEffect(() => {
    if (!navigationOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavigationOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [navigationOpen]);
  const [newProject, setNewProject] = useState(false),
    [permissions, setPermissions] = useState(false);
  const [staged, setStaged] = useState<ChatFile[]>([]),
    [uploadError, setUploadError] = useState(''),
    [uploadLabel, setUploadLabel] = useState(''),
    [uploading, setUploading] = useState(false),
    [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0),
    uploadBusy = useRef(false),
    uploadController = useRef<AbortController | null>(null),
    fileInput = useRef<HTMLInputElement>(null);
  const {
    tasks,
    connection,
    failure: connectionFailure,
    reconnect,
  } = usePiTasks(settings, !!session);
  const currentTasks = tasks.filter((t) => t.conversationId === conversation);
  const context = currentSessionContext(
    turns,
    currentTasks,
    conversation,
    sessionContext,
  ) as Context | null;
  const todo = conversationTodo(turns, currentTasks, conversation) as {
    items: TodoItem[];
  } | null;
  const entries = conversationEntries(turns, currentTasks, conversation) as {
    turn: PiTurn;
    task: PiTask | null;
    submittedAt: string;
    supplements: PiTask[];
  }[];
  const entryStateKey = entries
    .map((entry) => `${entry.turn.id}:${entry.task?.status || 'done'}`)
    .join('|');
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const latestTask = [...currentTasks]
    .filter((t) => !t.parentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1);
  useEffect(() => {
    if (latestTask && (taskPending(latestTask) || latestTask.status === 'done'))
      setAccess(
        taskPending(latestTask)
          ? latestTask.access
          : drafts.current.get(conversation)?.access || latestTask.access,
      );
  }, [conversation, latestTask?.id, latestTask?.status]);
  const activeTask = currentTasks.find(
    (t) => ['running', 'stopping'].includes(t.status) && !t.parentId,
  );
  const generating = !!activeTask;
  const compacting = manualCompacting || !!activeTask?.compacting;
  const draft = activeTask?.output || '',
    draftThinking = activeTask?.thinking || '';
  const backgroundTasks = tasks.filter(
    (t) => t.conversationId !== conversation && taskPending(t) && !t.parentId,
  );
  const queued = currentTasks.filter((t) => t.status === 'queued');
  const { manager: outbox, rows: outboxRows } = useMessageOutbox(
    settings,
    session?.user.id || 'guest',
  );
  const submitting = outboxRows.some(
    (r) =>
      r.payload.conversationId === conversation &&
      ['queued', 'sending', 'unknown'].includes(r.status),
  );
  const currentConversation = useRef(conversation);
  currentConversation.current = conversation;
  const drafts = useRef(
    new Map<
      string,
      { input: string; staged: ChatFile[]; pending: string | null; access?: 'read' | 'edit' }
    >(),
  );
  const branchAttempts = useRef(new Map<string, string>());
  const branchInFlight = useRef(false);
  const [forking, setForking] = useState('');
  const allConversations = (
    conversationList({
      history: savedConversations,
      tasks,
      metadata: savedConversations,
      drafts: draftConversations,
    }) as Conversation[]
  ).filter((c) => !deletedConversations.includes(c.id));
  const conversations = visibleConversations(allConversations);
  const archivedConversations = visibleConversations(allConversations, true);
  const conversationState = (id: string) => {
    const list = tasks.filter((t) => t.conversationId === id && taskPending(t) && !t.parentId);
    return list.find((t) => t.status !== 'queued') || list[0];
  };
  async function stopCurrent() {
    if (activeTask) await api(settings, `/pi/tasks/${activeTask.id}`, undefined, 'DELETE');
    else if (manualCompacting)
      await api(settings, `/pi/conversations/${conversation}/cancel`, {
        projectId: projectId || null,
        access,
      });
  }
  const {
    showThinking,
    messageMode: sendMode,
    setMessageMode: setSendMode,
  } = useAssistantPreferences();
  const { appearance } = useTheme();
  useEffect(() => {
    try {
      localStorage.setItem('astral.pi.thinkingLevel', thinkingLevel);
    } catch {}
  }, [thinkingLevel]);
  const [commands, setCommands] = useState<PiCommand[]>([]);
  const [availableSkills, setAvailableSkills] = useState<PiSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false),
    [skillsError, setSkillsError] = useState('');
  const [skillsWarning, setSkillsWarning] = useState('');
  const [commandIndex, setCommandIndex] = useState(0),
    [commandDismissed, setCommandDismissed] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
  const menu = commandMenu(input, commands, availableSkills, session?.user.role === 'owner');
  const menuOpen = !commandDismissed && menu.kind !== null;
  const matchingCommands = menuOpen ? menu.items : [];
  const selectedCommand = Math.min(commandIndex, Math.max(0, matchingCommands.length - 1));
  useEffect(() => {
    if (!session || !menuOpen) return;
    let live = true;
    setSkillsLoading(true);
    setSkillsError('');
    setSkillsWarning('');
    api<{ skills: PiSkill[]; warning?: string; diagnostics?: unknown[] }>(settings, '/pi/skills')
      .then((r) => {
        if (live) {
          setAvailableSkills(r.skills);
          setSkillsWarning(
            r.warning ||
              (r.diagnostics?.length
                ? '部分技能存在加载提示或同名冲突，当前显示 Pi 实际解析后的可用项。'
                : ''),
          );
        }
      })
      .catch((e) => {
        if (live) setSkillsError(e.message);
      })
      .finally(() => {
        if (live) setSkillsLoading(false);
      });
    return () => {
      live = false;
    };
  }, [session, settings, menuOpen, latestTask?.status]);
  useEffect(() => {
    setCommandIndex(0);
    setCommandDismissed(false);
  }, [input]);
  useEffect(() => {
    document.getElementById(`pi-command-${commandIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [commandIndex]);
  function chooseCommand(command: PiCommand) {
    setInput(completeCommand(command));
    pending.current = null;
    composer.current?.focus();
  }
  async function refreshProjects() {
    const r = await api<{ projects: ServerProject[] }>(settings, '/pi/projects');
    setProjects(r.projects);
  }
  async function uploadFiles(incoming: File[]) {
    if (!incoming.length) return;
    if (uploadBusy.current) {
      setUploadError('请等待当前上传完成，或取消当前上传。');
      return;
    }
    if (staged.length + incoming.length > 8) {
      setUploadError('每条消息最多附加8个文件，图片最多4张。');
      return;
    }
    uploadBusy.current = true;
    setUploading(true);
    setUploadError('');
    setError('');
    pending.current = null;
    const controller = new AbortController();
    uploadController.current = controller;
    let currentFile = '';
    try {
      for (const [index, file] of incoming.entries()) {
        currentFile = file.name;
        setUploadLabel(`${index + 1}/${incoming.length} · ${file.name}`);
        const uploaded = await uploadChatFile(settings, conversation, file, {
          signal: controller.signal,
        });
        if (alive.current && currentConversation.current === conversation)
          setStaged((old) => [...old, uploaded]);
      }
    } catch (e) {
      if (alive.current && currentConversation.current === conversation)
        setUploadError(
          controller.signal.aborted
            ? '已取消当前上传，已完成的附件仍保留。'
            : `${currentFile ? currentFile + '：' : ''}${(e as Error).message}`,
        );
    } finally {
      if (uploadController.current === controller) uploadController.current = null;
      uploadBusy.current = false;
      if (alive.current) setUploading(false);
    }
  }
  async function inspect() {
    const r = await api<{
      commands: PiCommand[];
      context: Context;
      sessionContext: PiSessionContext | null;
    }>(settings, `/pi/conversations/${conversation}/inspect`, {
      projectId: projectId || null,
      access,
    });
    setCommands((old) => [
      ...new Map([...old, ...(r.commands || [])].map((c) => [c.name, c])).values(),
    ]);
    if (currentConversation.current === conversation)
      setSessionContext((old) => mergeSessionContext(old, r.sessionContext, conversation));
  }
  async function compact() {
    setCompacting(true);
    try {
      await api(settings, `/pi/conversations/${conversation}/compact`, {
        projectId: projectId || null,
        access,
      });
      await inspect();
    } finally {
      if (alive.current) setCompacting(false);
    }
  }
  useEffect(() => {
    if (computerTarget || (!generating && !compacting)) return;
    const stop = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void stopCurrent().catch((err) => setError(err.message));
      }
    };
    window.addEventListener('keydown', stop);
    return () => window.removeEventListener('keydown', stop);
  }, [generating, compacting, conversation, projectId, access, settings, computerTarget]);
  const followBottom = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const messageContent = useRef<HTMLDivElement>(null);
  const prependPosition = useRef<{ height: number; top: number } | null>(null);
  const pending = useRef<string | null>(null),
    scroll = useRef<HTMLDivElement>(null),
    alive = useRef(true);
  useEffect(() => {
    pending.current = null;
  }, [sendMode]);
  const project = projects.find((p) => p.id === projectId);
  const currentMetadata = allConversations.find((c) => c.id === conversation);
  const conversationTitle = currentMetadata?.title || '新对话';
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      uploadController.current?.abort();
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(viewKey, conversation);
      localStorage.setItem(viewKey + ':project', projectId);
    } catch {}
  }, [conversation, projectId, viewKey]);
  async function refresh() {
    const [s, c] = await Promise.all([
      api<Status>(settings, '/pi/status', undefined, undefined, false, { fresh: true }),
      api<{ conversations: Conversation[] }>(
        settings,
        '/pi/conversations?archived=include',
        undefined,
        undefined,
        false,
        { fresh: true },
      ),
    ]);
    setStatus(s);
    setConversations(c.conversations);
    const p = await api<{ preferences: { defaultProjectId: string | null } }>(
      settings,
      '/pi/preferences',
      undefined,
      undefined,
      false,
      { fresh: true },
    );
    setDefaultProjectId(p.preferences.defaultProjectId);
    setPreferencesReady(true);
  }
  useEffect(() => {
    if (!session) return;
    let live = true;
    Promise.all([
      api<Status>(settings, '/pi/status'),
      api<{ conversations: Conversation[] }>(settings, '/pi/conversations?archived=include'),
    ])
      .then(([s, c]) => {
        if (live) {
          setStatus(s);
          setConversations(c.conversations);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    api<{ preferences: { defaultProjectId: string | null } }>(settings, '/pi/preferences')
      .then((r) => {
        if (live) {
          setDefaultProjectId(r.preferences.defaultProjectId);
          setPreferencesReady(true);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    api<{ projects: ServerProject[] }>(settings, '/pi/projects')
      .then((r) => {
        if (live) setProjects(r.projects);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [session, settings]);
  useEffect(() => {
    if (!session) return;
    let live = true;
    const sync = () => {
      if (!document.hidden) {
        void api<{ conversations: Conversation[] }>(settings, '/pi/conversations?archived=include')
          .then((r) => {
            if (live) setConversations(r.conversations);
          })
          .catch(() => {});
        void api<{ preferences: { defaultProjectId: string | null } }>(settings, '/pi/preferences')
          .then((r) => {
            if (live) {
              setDefaultProjectId(r.preferences.defaultProjectId);
              setPreferencesReady(true);
            }
          })
          .catch(() => {});
      }
    };
    const interval = setInterval(sync, 12000);
    window.addEventListener('focus', sync);
    return () => {
      live = false;
      clearInterval(interval);
      window.removeEventListener('focus', sync);
    };
  }, [session, settings]);
  useEffect(() => {
    if (
      preferencesReady &&
      emptyConversation &&
      !input.trim() &&
      !staged.length &&
      !draftProjects.current.has(conversation)
    )
      setProjectId(defaultProjectId || '');
  }, [preferencesReady, emptyConversation, defaultProjectId, conversation]);
  useEffect(() => {
    if (!session) return;
    let live = true;
    const cached = peekAPI<{ turns: PiTurn[]; sessionContext?: PiSessionContext | null }>(
      settings,
      `/pi/conversations/${conversation}`,
    );
    setTurns(cached?.turns || []);
    setLoadingHistory(!cached);
    setVisible(12);
    setMore(true);
    setSessionContext(cached?.sessionContext || null);
    setCompacting(false);
    setFailedTools([]);
    setEmptyConversation(false);
    api<{
      turns: PiTurn[];
      conversation?: Conversation | null;
      sessionContext?: PiSessionContext | null;
    }>(settings, `/pi/conversations/${conversation}`)
      .then((r) => {
        if (live) {
          setTurns((old) =>
            [...new Map([...old, ...r.turns].map((t) => [t.id, t])).values()].sort(
              (a, b) => (a.seq || 0) - (b.seq || 0),
            ),
          );
          setMore(r.turns.length === 50);
          if (r.conversation) {
            setConversations((old) => [
              ...old.filter((c) => c.id !== r.conversation!.id),
              r.conversation!,
            ]);
            setProjectId(r.conversation.projectId || '');
            if (!r.turns.length) setAccess(r.conversation.access || 'read');
          }
          setEmptyConversation(
            !r.turns.length &&
              !r.conversation &&
              !tasksRef.current.some((t) => t.conversationId === conversation),
          );
          setSessionContext((old) => mergeSessionContext(old, r.sessionContext, conversation));
          if (r.turns.length) {
            setProjectId(r.turns[0].projectId || '');
            const running = tasksRef.current.find(
              (t) => t.conversationId === conversation && taskPending(t) && !t.parentId,
            );
            setAccess(
              running?.access ||
                drafts.current.get(conversation)?.access ||
                r.turns.at(-1)?.access ||
                'read',
            );
          }
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      })
      .finally(() => {
        if (live) setLoadingHistory(false);
      });
    return () => {
      live = false;
    };
  }, [conversation, session, settings]);
  const settledKey = currentTasks
    .filter((t) => !taskPending(t))
    .map((t) => `${t.id}:${t.status}`)
    .join('|');
  const previousSettled = useRef({ conversation, key: settledKey });
  useEffect(() => {
    if (!session) return;
    let live = true;
    const fresh =
      previousSettled.current.conversation === conversation &&
      previousSettled.current.key !== settledKey;
    previousSettled.current = { conversation, key: settledKey };
    void api<{ turns: PiTurn[]; sessionContext?: PiSessionContext | null }>(
      settings,
      `/pi/conversations/${conversation}`,
      undefined,
      undefined,
      false,
      { fresh },
    )
      .then((r) => {
        if (!live) return;
        setTurns((old) =>
          [...new Map([...old, ...r.turns].map((t) => [t.id, t])).values()].sort(
            (a, b) => (a.seq || 0) - (b.seq || 0),
          ),
        );
        setSessionContext((old) => mergeSessionContext(old, r.sessionContext, conversation));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [conversation, settledKey, session, settings]);
  const jumpToLatest = () => {
    followBottom.current = true;
    setShowLatest(false);
    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'instant' });
  };
  useLayoutEffect(() => {
    const container = scroll.current;
    if (!container) return;
    const before = prependPosition.current;
    if (before) {
      prependPosition.current = null;
      container.scrollTop = before.top + container.scrollHeight - before.height;
    } else if (followBottom.current) container.scrollTop = container.scrollHeight;
    else setShowLatest(container.scrollHeight - container.clientHeight - container.scrollTop > 48);
  }, [
    conversation,
    entryStateKey,
    turns.length,
    visible,
    draft,
    draftThinking,
    activeTask?.timeline?.length,
    busy,
    compacting,
  ]);
  useEffect(() => {
    const content = messageContent.current,
      container = scroll.current;
    if (!content || !container) return;
    const observer = new ResizeObserver(() => {
      if (followBottom.current) container.scrollTop = container.scrollHeight;
      else
        setShowLatest(container.scrollHeight - container.clientHeight - container.scrollTop > 48);
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [conversation, !!session]);
  async function task(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function switchConversation(
    id: string,
    nextProject = '',
    nextAccess: 'read' | 'edit' = 'read',
    discardCurrent = false,
  ) {
    setComputerTarget(null);
    if (discardCurrent) drafts.current.delete(conversation);
    else drafts.current.set(conversation, { input, staged, pending: pending.current, access });
    if (!discardCurrent && (input.trim() || staged.length))
      setDraftConversations((old) => [
        ...old.filter((c) => c.id !== conversation),
        {
          id: conversation,
          title: input.trim().slice(0, 40) || '附件草稿',
          projectId: projectId || null,
          access,
          updatedAt: new Date().toISOString(),
        },
      ]);
    else setDraftConversations((old) => old.filter((c) => c.id !== conversation));
    const saved = drafts.current.get(id);
    setInput(saved?.input || '');
    setStaged(saved?.staged || []);
    setUploadError('');
    pending.current = saved?.pending || null;
    setProjectId(nextProject);
    setAccess(saved?.access || nextAccess);
    if (id !== conversation) {
      followBottom.current = true;
      prependPosition.current = null;
      setShowLatest(false);
      const cached = peekAPI<{ turns: PiTurn[] }>(settings, `/pi/conversations/${id}`);
      setTurns(cached?.turns || []);
      setLoadingHistory(!cached);
    }
    setConversation(id);
    setEmptyConversation(false);
    setNavigationOpen(false);
    setError('');
  }
  async function fresh(nextProject?: string, discardCurrent = false) {
    await task(async () => {
      let directory = defaultProjectId || '';
      if (nextProject !== undefined) directory = nextProject;
      else if (!preferencesReady) {
        const r = await api<{ preferences: { defaultProjectId: string | null } }>(
          settings,
          '/pi/preferences',
        );
        directory = r.preferences.defaultProjectId || '';
        setDefaultProjectId(r.preferences.defaultProjectId);
        setPreferencesReady(true);
      }
      const id = crypto.randomUUID();
      // A draft is local until an accepted message (or an explicit history action) saves it.
      draftProjects.current.set(id, directory);
      setShowArchived(false);
      switchConversation(id, directory, 'read', discardCurrent);
    });
  }
  async function updateConversation(
    c: Conversation,
    patch: { title?: string; pinned?: boolean; archived?: boolean },
  ) {
    if (!savedConversations.some((saved) => saved.id === c.id))
      await api(settings, '/pi/conversations', {
        id: c.id,
        projectId: c.projectId || null,
        access: c.access || 'read',
      });
    const r = await api<{ conversation: Conversation }>(
      settings,
      `/pi/conversations/${c.id}`,
      patch,
      'PATCH',
    );
    setConversations((old) => [...old.filter((item) => item.id !== c.id), r.conversation]);
  }
  async function saveDefaultDirectory(id: string | null) {
    const r = await api<{ preferences: { defaultProjectId: string | null } }>(
      settings,
      '/pi/preferences',
      { defaultProjectId: id },
      'PATCH',
    );
    setDefaultProjectId(r.preferences.defaultProjectId);
    setPreferencesReady(true);
  }
  function conversationAction(action: ConversationAction, c: Conversation) {
    if (action === 'rename' || action === 'delete') {
      setConversationEditor({ kind: action, conversation: c });
      return;
    }
    if (action === 'new') {
      void fresh(c.projectId || '');
      return;
    }
    if (action === 'directory') {
      switchConversation(c.id, c.projectId || '', c.access || 'read');
      setBrowse(true);
      return;
    }
    void task(async () => {
      await updateConversation(
        c,
        action === 'pin' ? { pinned: !c.pinnedAt } : { archived: !c.archivedAt },
      );
    });
  }
  function conversationRow(c: Conversation) {
    const state = conversationState(c.id);
    return (
      <ConversationRow
        key={c.id}
        conversation={c}
        selected={!computerTarget && c.id === conversation}
        disabled={uploading || manualCompacting}
        openMenu={setConversationMenu}
        choose={() => switchConversation(c.id, c.projectId || '', c.access || 'read')}
        detail={
          state ? (
            <span className="conversation-task-state">
              <LoaderCircle size={11} className={state.status === 'queued' ? '' : 'spin'} />
              {taskLabel(state)}
            </span>
          ) : (
            dateLabel(c.updatedAt)
          )
        }
      />
    );
  }
  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent).detail?.conversationId;
      if (!/^[a-f0-9-]{36}$/.test(id || '')) return;
      const saved = savedConversations.find((c) => c.id === id);
      switchConversation(id, saved?.projectId || '', saved?.access || 'read');
    };
    window.addEventListener('astral-open-pi', open);
    return () => window.removeEventListener('astral-open-pi', open);
  }, [savedConversations, conversation, input, staged, access]);
  async function send() {
    if ((!input.trim() && !staged.length) || uploading || loadingHistory) return;
    const command = input.trim();
    if (menu.kind === 'skills') {
      setCommandDismissed(false);
      composer.current?.focus();
      return;
    }
    if (command === '/new') {
      void fresh(undefined, true);
      return;
    }
    if (command === '/compact' || command === '/status') {
      if (generating || queued.length) {
        setError('请等待当前任务和队列结束后使用此命令。');
        return;
      }
      setInput('');
      await task(command === '/compact' ? compact : inspect);
      return;
    }
    setError('');
    const text = input.trim() || '请分析这些附件。';
    const id = crypto.randomUUID();
    const body = {
      id,
      conversationId: conversation,
      input: text,
      projectId: projectId || null,
      access,
      thinkingLevel,
      attachments: staged.map((f) => f.id),
      ...messageDelivery(activeTask, sendMode, staged.length ? '' : text),
      deliveryPreference: sendMode,
    };
    try {
      outbox.add(body, staged);
      setInput('');
      setStaged([]);
      pending.current = null;
      drafts.current.set(conversation, { input: '', staged: [], pending: null, access });
      followBottom.current = true;
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const acknowledged = useRef(new Set<string>());
  useEffect(() => {
    const ids = new Set(tasks.map((t) => t.id));
    for (const row of outboxRows)
      if (
        (row.status === 'accepted' || ids.has(row.payload.id)) &&
        !acknowledged.current.has(row.payload.id)
      ) {
        acknowledged.current.add(row.payload.id);
        draftProjects.current.delete(row.payload.conversationId);
        if (row.payload.conversationId === currentConversation.current) setEmptyConversation(false);
        void refresh().catch(() => {});
      }
    outbox.confirm([...ids]);
  }, [outboxRows, tasks, outbox]);
  async function forkMessage(turn: PiTurn, position: 'before' | 'after') {
    if (branchInFlight.current || uploading || manualCompacting) return;
    branchInFlight.current = true;
    const source = conversation,
      attemptKey = `${source}:${turn.id}:${position}`;
    const id = branchAttempts.current.get(attemptKey) || crypto.randomUUID();
    branchAttempts.current.set(attemptKey, id);
    setForking(attemptKey);
    setError('');
    try {
      const r = await api<{
        conversation: Conversation;
        draft: { input: string; attachments: ChatFile[] };
      }>(settings, `/pi/conversations/${source}/fork`, { id, turnId: turn.id, position });
      setConversations((old) => [...old.filter((c) => c.id !== id), r.conversation]);
      drafts.current.set(id, {
        input: r.draft.input,
        staged: r.draft.attachments,
        pending: null,
        access: r.conversation.access || 'read',
      });
      branchAttempts.current.delete(attemptKey);
      if (alive.current && currentConversation.current === source) {
        switchConversation(id, r.conversation.projectId || '', r.conversation.access || 'read');
        setTimeout(() => composer.current?.focus(), 0);
      }
    } catch (e) {
      if (alive.current && currentConversation.current === source) setError((e as Error).message);
    } finally {
      branchInFlight.current = false;
      if (alive.current) setForking('');
    }
  }
  async function older() {
    followBottom.current = false;
    if (scroll.current)
      prependPosition.current = {
        height: scroll.current.scrollHeight,
        top: scroll.current.scrollTop,
      };
    if (visible < entries.length) {
      setVisible((n) => n + 12);
      return;
    }
    if (!turns[0]?.seq) {
      prependPosition.current = null;
      return;
    }
    await task(async () => {
      let r;
      try {
        r = await api<{ turns: PiTurn[] }>(
          settings,
          `/pi/conversations/${conversation}?before=${turns[0].seq}`,
        );
      } catch (e) {
        prependPosition.current = null;
        throw e;
      }
      if (!alive.current || currentConversation.current !== conversation) return;
      setTurns((current) => [...r.turns, ...current]);
      setVisible((n) => n + r.turns.length);
      setMore(r.turns.length === 50);
    });
  }
  if (!session)
    return (
      <section className="surface assistant-landing">
        <div className="assistant-orb">
          <Bot size={36} />
        </div>
        <span className="eyebrow">PI, IN YOUR SPACE</span>
        <h2>今天，想一起完成什么？</h2>
        <p>
          从一个问题开始，连接你的文件、项目和电脑。
          <br />
          对话按账号保存，在其他设备上也能接着聊。
        </p>
        <button className="primary" onClick={login}>
          登录并开始
          <Send size={16} />
        </button>
        <div className="assistant-preview-prompts">
          <span>
            <Code2 size={18} />
            梳理代码与项目
          </span>
          <span>
            <WandSparkles size={18} />
            按技能完成任务
          </span>
          <span>
            <FolderOpen size={18} />
            理解和修改文件
          </span>
        </div>
      </section>
    );
  return (
    <FileWorkbenchProvider
      settings={settings}
      tasks={tasks}
      conversation={conversation}
      projects={projects}
      projectId={projectId}
      suspended={!!computerTarget}
    >
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {conversationMenu && (
        <ConversationMenu
          anchor={conversationMenu}
          close={() => setConversationMenu(null)}
          action={conversationAction}
        />
      )}
      {conversationEditor && (
        <ConversationEditor
          conversation={conversationEditor.conversation}
          kind={conversationEditor.kind}
          running={!!conversationState(conversationEditor.conversation.id)}
          close={() => setConversationEditor(null)}
          submit={async (title) => {
            const c = conversationEditor.conversation;
            if (conversationEditor.kind === 'rename') await updateConversation(c, { title });
            else {
              await api(settings, `/pi/conversations/${c.id}`, undefined, 'DELETE');
              setDeletedConversations((old) => [...old, c.id]);
              setConversations((old) => old.filter((item) => item.id !== c.id));
              setDraftConversations((old) => old.filter((item) => item.id !== c.id));
              drafts.current.delete(c.id);
              if (c.id === conversation) await fresh(undefined, true);
              reconnect();
            }
          }}
        />
      )}
      {directorySettings && (
        <DefaultDirectory
          projects={projects}
          selected={defaultProjectId}
          close={() => setDirectorySettings(false)}
          save={saveDefaultDirectory}
          chooseFolder={() => {
            setDirectorySettings(false);
            setProjectPurpose('default');
            setNewProject(true);
          }}
        />
      )}
      {newProject && (
        <NewProject
          settings={settings}
          sources={projects.filter(
            (p) =>
              p.source &&
              (session?.user.role === 'owner' || (p.userRoot && p.ownerId === session?.user.id)),
          )}
          close={() => setNewProject(false)}
          created={(p) => {
            setProjects((old) => [...old, p]);
            setNewProject(false);
            if (projectPurpose === 'default') void task(() => saveDefaultDirectory(p.id));
            else void fresh(p.id);
          }}
        />
      )}
      {permissions && project && (
        <ProjectPermissions
          settings={settings}
          project={project}
          projects={projects}
          close={() => setPermissions(false)}
          saved={() => {
            setPermissions(false);
            void refreshProjects().catch((e) => setError(e.message));
          }}
        />
      )}
      <header className="assistant-workspace-heading chat-heading">
        <button className="mobile-menu icon-btn" aria-label="打开导航" onClick={openNavigation}>
          <Menu size={19} />
        </button>
        <div className="pi-heading-info">
          <h1 title={computerTarget ? remoteTitle : conversationTitle}>
            {computerTarget ? remoteTitle : conversationTitle}
          </h1>
          {computerTarget ? (
            <small className="pi-model-status">
              <Monitor size={12} />
              <span
                className={'assistant-status-dot ' + (computerGroup?.device.online ? 'ready' : '')}
              />
              {computerGroup?.device.name || '远程电脑'} · {computerProject?.name || '读取项目中'}
            </small>
          ) : (
            <small
              className="pi-model-status"
              title={
                !status
                  ? '正在读取助手状态…'
                  : status.pluginActivation?.diagnostic?.message ||
                    (status.nativeSessions
                      ? '持续会话 · 原生上下文'
                      : '请升级 Pi 服务以启用持续会话')
              }
            >
              <span className={`assistant-status-dot ${status?.available ? 'ready' : ''}`} />
              {status?.model || 'DeepSeek'}
              <span className="assistant-connection-label">
                {' '}
                ·{' '}
                {status?.pluginActivation?.checking
                  ? '检查插件中'
                  : status?.pluginActivation?.fallback
                    ? '内置工具模式'
                    : status?.available
                      ? '已连接'
                      : status
                        ? '待连接'
                        : '读取状态中'}
              </span>
            </small>
          )}
        </div>
        <div className="action-row">
          <button
            className="icon-btn mobile-new-conversation"
            aria-label="新建对话"
            disabled={uploading || manualCompacting}
            onClick={newCurrentConversation}
          >
            <Plus size={19} />
          </button>
          <button
            className="icon-btn"
            aria-label="刷新助手"
            disabled={busy}
            onClick={() => {
              computers.refresh();
              if (!computerTarget) void task(refresh);
            }}
          >
            <RefreshCw size={17} />
          </button>
          {!computerTarget && (
            <button
              className="icon-btn"
              aria-label="对话操作"
              aria-haspopup="menu"
              disabled={uploading || manualCompacting}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setConversationMenu({
                  conversation: currentMetadata || {
                    id: conversation,
                    title: conversationTitle,
                    projectId: projectId || null,
                    access,
                    updatedAt: new Date().toISOString(),
                  },
                  x: rect.right,
                  y: rect.bottom,
                  origin: event.currentTarget,
                });
              }}
            >
              <MoreHorizontal size={18} />
            </button>
          )}
        </div>
        {workspaceActions}
        <button
          className="icon-btn mobile-project-navigation"
          aria-label={navigationOpen ? '收起项目与对话' : '打开项目与对话'}
          aria-controls="pi-project-navigation"
          aria-expanded={navigationOpen}
          onClick={() => setNavigationOpen(!navigationOpen)}
        >
          <PanelRight size={19} />
        </button>
      </header>
      <div
        className={`chat-layout pi-layout assistant-layout ${appearance === 'dark' ? 'pi-terminal' : ''} ${computerTarget ? 'has-computer' : ''}`}
      >
        <button
          className={`project-navigation-scrim ${navigationOpen ? 'is-open' : ''}`}
          tabIndex={navigationOpen ? 0 : -1}
          aria-hidden={!navigationOpen}
          aria-label="关闭项目与对话"
          onClick={() => setNavigationOpen(false)}
        />
        <aside
          id="pi-project-navigation"
          aria-label="项目与对话"
          className={`surface contact-list project-conversation-list ${navigationOpen ? 'is-open' : ''}`}
        >
          <div className="project-navigation-heading">
            <strong>项目与对话</strong>
            <button
              className="icon-btn"
              aria-label="收起项目与对话"
              onClick={() => setNavigationOpen(false)}
            >
              <X size={19} />
            </button>
          </div>
          <button
            className="secondary new-conversation"
            disabled={uploading || manualCompacting}
            onClick={newCurrentConversation}
          >
            <Plus size={17} />
            新对话
          </button>
          {showArchived && (
            <div className="pi-archive-heading">
              <button
                className="icon-btn"
                aria-label="返回对话列表"
                onClick={() => setShowArchived(false)}
              >
                <ArrowLeft size={16} />
              </button>
              <h2>已归档</h2>
              <small>{archivedConversations.length}</small>
            </div>
          )}
          {!showArchived && (
            <>
              <div className="project-tree-heading">
                <h2>服务器项目</h2>
                <button
                  className="icon-btn"
                  aria-label="新建项目"
                  disabled={uploading || !projects.length}
                  onClick={() => {
                    setNavigationOpen(false);
                    setProjectPurpose('project');
                    setNewProject(true);
                  }}
                >
                  <Plus size={16} />
                </button>
              </div>
              {projects
                .filter((p) => !p.source || conversations.some((c) => c.projectId === p.id))
                .map((p) => (
                  <details
                    className="project-tree"
                    key={p.id}
                    open={(!computerTarget && projectId === p.id) || undefined}
                  >
                    <ProjectSummary
                      name={p.name}
                      detail={conversations.filter((c) => c.projectId === p.id).length}
                      newConversation={() => void fresh(p.id)}
                      saveName={async (name) => {
                        await api(
                          settings,
                          '/pi/projects/' + p.id + '/display-name',
                          { name },
                          'PUT',
                        );
                        await refreshProjects();
                      }}
                    />
                    <ProjectConversationList>
                      {conversations.filter((c) => c.projectId === p.id).map(conversationRow)}
                    </ProjectConversationList>
                  </details>
                ))}
              {!projects.some((p) => !p.source) && (
                <p className="field-help">新建项目并选择文件夹，对话会归在项目下。</p>
              )}
            </>
          )}
          <AssistantComputerProjects
            titleChanged={titleChanged}
            settings={settings}
            owner={session.user.id}
            groups={computers.groups}
            selected={computerTarget}
            choose={selectComputer}
            connect={openComputerConnections}
            refresh={computers.refresh}
            error={computers.error}
            showArchived={showArchived}
          />
          {!showArchived && <h2>对话</h2>}
          {(showArchived ? archivedConversations : conversations.filter((c) => !c.projectId)).map(
            conversationRow,
          )}
          {!(showArchived ? archivedConversations : conversations).length && (
            <p className="field-help">
              {showArchived
                ? '还没有归档的对话。归档会保留历史与上下文。'
                : '你的第一段对话从这里开始。'}
            </p>
          )}
          <div className="pi-navigation-footer">
            <button
              className={`pi-sidebar-control ${showArchived ? 'is-active' : ''}`}
              onClick={() => setShowArchived(!showArchived)}
            >
              <Archive size={15} />
              <span>{showArchived ? '返回对话' : '已归档'}</span>
              <small>{archivedConversations.length || ''}</small>
            </button>
            {session && (
              <button
                className="pi-sidebar-control pi-default-directory"
                disabled={!preferencesReady}
                onClick={() => setDirectorySettings(true)}
                title={projects.find((p) => p.id === defaultProjectId)?.serverPath}
              >
                <FolderOpen size={15} />
                <span>
                  <small>默认工作目录</small>
                  <b>{projects.find((p) => p.id === defaultProjectId)?.name || '独立会话'}</b>
                </span>
                <ChevronDown size={13} />
              </button>
            )}
          </div>
        </aside>
        <section
          className={`surface chat-panel server-chat-panel ${dragging ? 'file-drop-active' : ''}`}
          aria-hidden={!!computerTarget}
          inert={!!computerTarget}
          onDragEnter={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              dragDepth.current++;
              setDragging(true);
            }
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (!dragDepth.current) setDragging(false);
          }}
          onDrop={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              e.stopPropagation();
              dragDepth.current = 0;
              setDragging(false);
              void uploadFiles(Array.from(e.dataTransfer.files));
            }
          }}
        >
          {dragging && (
            <div className="file-drop-overlay">
              <Paperclip size={30} />
              <strong>松开即可上传到当前对话</strong>
              <span>图片、PDF、代码与其他文件 · {attachmentSizeMessage}</span>
            </div>
          )}

          {(backgroundTasks.length > 0 || connection !== 'connected') && (
            <div className="background-task-bar" role="status">
              {connection !== 'connected' ? (
                <button className="text-link" onClick={reconnect} title={connectionFailure}>
                  {connection === 'connecting' ? '正在恢复任务…' : '连接中断，正在补回进度…'}
                </button>
              ) : (
                <button
                  className="text-link"
                  onClick={() => {
                    const t = backgroundTasks[0];
                    switchConversation(t.conversationId, t.projectId || '', t.access);
                  }}
                >
                  <LoaderCircle size={13} className="spin" />
                  {backgroundTasks.length} 个后台任务 · 查看
                </button>
              )}
              <small>切换聊天不影响执行</small>
            </div>
          )}
          {currentMetadata?.archivedAt && (
            <div className="pi-archived-banner">
              <Archive size={14} />
              <span>此对话已归档，历史与任务会保留。</span>
              <button
                className="text-link"
                onClick={() =>
                  void task(() => updateConversation(currentMetadata, { archived: false }))
                }
              >
                恢复对话
              </button>
            </div>
          )}
          <div className="assistant-toolbar">
            {project && (
              <>
                <span className="current-project-name" title={project.serverPath}>
                  <FolderOpen size={14} />
                  {project.name}
                </span>
                <button
                  onClick={() => {
                    setBrowse(!browse);
                  }}
                >
                  <FolderOpen size={15} />
                  文件
                </button>
              </>
            )}
            <AssistantSettings>
              <AssistantMode
                key={`mode:${conversation}`}
                value={access}
                projectName={project?.name}
                readOnly={project?.readOnly}
                locked={
                  currentTasks.some(taskPending)
                    ? '当前任务和队列结束后可切换模式'
                    : loadingHistory || busy || uploading || submitting
                      ? '请等待当前操作完成'
                      : undefined
                }
                onChange={(value) => {
                  pending.current = null;
                  setAccess(value);
                }}
              />
              {session.user.role === 'owner' && (
                <ApprovalControl
                  key={`approval:${conversation}`}
                  settings={settings}
                  conversation={conversation}
                />
              )}
              <SandboxNetworkControl
                key={conversation}
                settings={settings}
                conversation={conversation}
                admin={session.user.role === 'owner'}
              />
              {project && session.user.role === 'owner' && (
                <button
                  disabled={uploading || manualCompacting}
                  onClick={() => setPermissions(true)}
                >
                  <ShieldCheck size={15} />
                  授权
                </button>
              )}
              <label>
                连续发送
                <select
                  aria-label="连续发送方式"
                  value={sendMode}
                  onChange={(e) => setSendMode(e.target.value as 'queue' | 'steer')}
                >
                  <option value="steer">立即补充</option>
                  <option value="queue">下一任务</option>
                </select>
              </label>
            </AssistantSettings>
          </div>
          <div className="pi-message-area" data-conversation-swipe>
            <div
              className="message-scroll pi-messages"
              role="region"
              aria-label="对话消息"
              tabIndex={0}
              ref={scroll}
              onScroll={() => {
                const node = scroll.current;
                if (!node) return;
                const near = node.scrollHeight - node.clientHeight - node.scrollTop <= 48;
                followBottom.current = near;
                setShowLatest(!near);
              }}
              onWheel={(event) => {
                if (event.deltaY < 0) followBottom.current = false;
              }}
            >
              <div ref={messageContent} className="pi-message-content">
                {(visible < entries.length || (more && !!turns.length)) && (
                  <button
                    className="load-history text-link"
                    disabled={busy}
                    onClick={() => void older()}
                  >
                    加载更早对话 · 不影响模型上下文
                  </button>
                )}
                {!entries.length && !loadingHistory && !busy && !generating && !queued.length && (
                  <div className="small-empty pi-welcome">
                    <div className="assistant-orb">
                      <Bot size={34} />
                    </div>
                    <h2>今天想一起完成什么？</h2>
                    <p>提出问题，或选择一个项目开始工作。</p>
                    <div className="pi-suggestions">
                      {[
                        '帮我把一个想法整理成行动清单',
                        ...(projectId
                          ? ['浏览这个项目，解释它的结构']
                          : ['帮我设计一个插件的数据结构']),
                        '帮我检查一段代码',
                      ].map((q) => (
                        <button className="secondary" key={q} onClick={() => setInput(q)}>
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {entries.slice(-visible).map((entry) => {
                  const { turn: t, task: taskState } = entry;
                  const running = !!taskState && ['running', 'stopping'].includes(taskState.status);
                  const unfinished = !!taskState && !running && taskState.status !== 'done';
                  return (
                    <div
                      key={t.id}
                      data-message-id={t.id}
                      className={`pi-turn${running ? ' streaming-turn' : ''}${unfinished ? ' task-incomplete' : ''}`}
                    >
                      <AssistantUserMessage
                        input={t.input}
                        at={entry.submittedAt}
                        label={taskState?.parentId ? '任务补充' : '我'}
                        files={t.attachments || []}
                        settings={settings}
                        conversation={conversation}
                      >
                        {!taskState?.parentId && (
                          <button
                            type="button"
                            className="message-action"
                            disabled={!!forking || uploading || manualCompacting}
                            onClick={() => void forkMessage(t, 'before')}
                            title="保留原对话，从这条消息之前分支并编辑"
                          >
                            <Pencil size={14} />
                            <span>编辑并分支</span>
                          </button>
                        )}
                      </AssistantUserMessage>
                      <div className="message assistant">
                        <RunSummary
                          execution={t.execution}
                          status={running ? 'running' : taskState?.status || 'done'}
                          phase={taskState?.compacting ? '压缩中…' : taskState?.phase}
                        />
                        <LongGoalCard goal={taskState?.longGoal} status={taskState?.status} />
                        {taskState?.status === 'interrupted' && (
                          <PluginRequests task={taskState} settings={settings} />
                        )}
                        {!t.timeline?.length && showThinking && t.thinking && (
                          <details className="thinking-panel" open={running || undefined}>
                            <summary>
                              <Brain size={14} />
                              模型思考
                            </summary>
                            <pre>{t.thinking}</pre>
                          </details>
                        )}
                        {t.supplements?.map((s) => (
                          <div className="task-supplement" key={s.id}>
                            <small>任务补充</small>
                            <p>{s.input}</p>
                            <ChatFiles
                              files={s.attachments || []}
                              settings={settings}
                              conversation={conversation}
                            />
                          </div>
                        ))}
                        {t.timeline?.length ? (
                          <PiTimeline
                            items={t.timeline}
                            showThinking={showThinking}
                            active={running}
                            settings={settings}
                            projectId={t.projectId}
                          />
                        ) : t.output ? (
                          <div>
                            <PiMarkdown text={t.output} />
                            {running && <span className="stream-cursor" />}
                          </div>
                        ) : null}
                        {running && (taskState?.compacting || !t.output) && (
                          <p className="pi-thinking" role="status">
                            <LoaderCircle size={16} className="spin" />
                            {taskState?.compacting ? '压缩中…' : taskState?.phase || '正在处理'}
                          </p>
                        )}
                        {running && taskState && <TaskActivity task={taskState} />}
                        {entry.supplements.map((s) => (
                          <div className="task-supplement" key={s.id}>
                            <small>{taskLabel(s)}</small>
                            <p>{s.input}</p>
                            <ChatFiles
                              files={s.attachmentFiles || []}
                              settings={settings}
                              conversation={conversation}
                            />
                            {s.error && <p className="field-help">{s.error}</p>}
                          </div>
                        ))}
                        {unfinished && (
                          <div className="pi-runtime-error" role="alert">
                            <p className="field-help">
                              {taskState.error ||
                                (taskState.status === 'cancelled'
                                  ? '任务已停止。'
                                  : '执行未完成，请查看执行记录。')}
                            </p>
                            {taskState.diagnostic && (
                              <details className="pi-error-details">
                                <summary>
                                  {taskState.status === 'cancelled' ? '停止详情' : '错误详情'} ·{' '}
                                  {taskState.diagnostic.code}
                                </summary>
                                <pre>{taskState.diagnostic.details}</pre>
                              </details>
                            )}
                          </div>
                        )}
                        {(t.execution?.runtimeWarnings || taskState?.runtimeWarnings || []).map(
                          (d, i) => (
                            <details
                              className="pi-error-details pi-runtime-warning"
                              key={`${d.code}-${i}`}
                            >
                              <summary>{d.message}</summary>
                              <pre>{d.details}</pre>
                            </details>
                          ),
                        )}
                        <ChatFiles
                          files={t.artifacts || []}
                          settings={settings}
                          conversation={conversation}
                        />
                        <FileChanges
                          tools={t.tools || []}
                          settings={settings}
                          projectId={t.projectId}
                        />
                        {!t.timeline?.length && (
                          <ToolLog
                            tools={t.tools || []}
                            projectId={t.projectId}
                            settings={settings}
                          />
                        )}
                        <RunMetrics metrics={t.execution?.metrics} />
                        <div className="message-actions">
                          <CopyButton text={t.output} label="复制 Agent 回复" />
                          {!running && !unfinished && (
                            <button
                              type="button"
                              className="message-action"
                              disabled={!!forking || uploading || manualCompacting}
                              onClick={() => void forkMessage(t, 'after')}
                              title="保留此处之前的原生上下文，在新对话继续"
                            >
                              <GitBranch size={14} />
                              <span>从这里分支</span>
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {manualCompacting && !activeTask && (
                  <div className="pi-turn">
                    <div className="message assistant">
                      <RunSummary status="running" phase="压缩中…" />
                      <p className="pi-thinking" role="status">
                        <LoaderCircle size={16} className="spin" />
                        压缩中…
                      </p>
                    </div>
                  </div>
                )}
                <ToolLog tools={failedTools} projectId={projectId} settings={settings} />
                <AppFunctionRequests
                  settings={settings}
                  taskId={activeTask?.id}
                  active={!!activeTask && ['running', 'stopping'].includes(activeTask.status)}
                />
                <PluginRequests task={activeTask} settings={settings} />
              </div>
            </div>
            {showLatest && (
              <button type="button" className="pi-jump-latest" onClick={jumpToLatest}>
                <ChevronsDown size={14} />
                回到最新
              </button>
            )}
          </div>
          {terminalOpen && session?.user.role === 'owner' && (
            <Suspense fallback={<p className="field-help">正在载入终端…</p>}>
              <TerminalPanel
                settings={settings}
                owner={session.user.id}
                onClose={() => setTerminalOpen(false)}
              />
            </Suspense>
          )}
          <MessageOutbox
            rows={outboxRows.filter((r) => r.payload.conversationId === conversation)}
            retry={(id) => outbox.retry(id)}
            reconcile={(id) => outbox.reconcile(id)}
            restore={(row) => {
              const files = [...new Map([...row.files, ...staged].map((f) => [f.id, f])).values()];
              if (files.length > 8) {
                setError(
                  '当前草稿与此消息合计超过8个附件。请先发送或移除当前草稿附件，再恢复此消息。',
                );
                return;
              }
              setInput((old) => row.payload.input + (old ? '\n\n' + old : ''));
              setStaged(files);
              outbox.remove(row.payload.id);
              composer.current?.focus();
            }}
          />
          <AssistantComposer
            area={composer}
            history={scroll}
            active={!computerTarget}
            value={input}
            send={send}
            upload={uploadFiles}
            onValue={(value) => {
              setInput(value);
              if (value === '/' && !generating) void inspect().catch(() => {});
              pending.current = null;
            }}
            attributes={{
              'data-quote-input': true,
              'aria-label': '发送给 Pi 的问题',
              'aria-controls': menuOpen ? 'pi-command-options' : undefined,
              'aria-activedescendant': matchingCommands.length
                ? `pi-command-${selectedCommand}`
                : undefined,
              'aria-autocomplete': 'list',
              disabled: manualCompacting,
            }}
            onKeyDown={(e) => {
              if (menuOpen && e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setCommandDismissed(true);
                return;
              }
              if (matchingCommands.length) {
                if (['ArrowUp', 'ArrowDown'].includes(e.key)) {
                  e.preventDefault();
                  setCommandIndex(
                    (i) =>
                      (i + (e.key === 'ArrowDown' ? 1 : -1) + matchingCommands.length) %
                      matchingCommands.length,
                  );
                  return;
                }
                if (['Enter', 'Tab'].includes(e.key) && !e.shiftKey) {
                  e.preventDefault();
                  chooseCommand(matchingCommands[selectedCommand]);
                  return;
                }
              }
            }}
            header={
              <>
                {todo && <TodoDropdown key={`todo:${conversation}`} items={todo.items} />}
                {menuOpen && (
                  <div className="pi-command-menu" id="pi-command-menu">
                    <div className="pi-command-heading" aria-hidden="true">
                      <b>{menu.kind === 'skills' ? '技能' : '命令'}</b>
                      <small>↑↓ 选择 · Tab / ↵ 插入 · Esc 关闭</small>
                    </div>
                    {skillsError && (
                      <p className="pi-command-feedback" role="alert">
                        技能加载失败：{skillsError}。重新输入 / 可重试。
                      </p>
                    )}
                    {skillsWarning && (
                      <p className="pi-command-feedback" role="status">
                        {skillsWarning}
                      </p>
                    )}
                    {!matchingCommands.length && (
                      <p className="pi-command-feedback" role="status">
                        {skillsLoading
                          ? '正在加载技能…'
                          : skillsError
                            ? '暂时无法获取技能列表。'
                            : menu.kind === 'skills'
                              ? availableSkills.some((s) => s.enabled)
                                ? '没有匹配的技能，试试名称或用途。'
                                : `尚未启用技能。${session.user.role === 'owner' ? '可在聊天中让助手创建或导入技能。' : ''}`
                              : '没有匹配的命令。'}
                      </p>
                    )}
                    <div
                      role="listbox"
                      id="pi-command-options"
                      aria-label={menu.kind === 'skills' ? '选择技能' : 'Pi 命令'}
                    >
                      {matchingCommands.map((c, index) => (
                        <button
                          type="button"
                          key={c.name}
                          role="option"
                          id={`pi-command-${index}`}
                          aria-selected={index === selectedCommand}
                          title={c.description}
                          className={index === selectedCommand ? 'selected' : ''}
                          onMouseEnter={() => setCommandIndex(index)}
                          onClick={() => chooseCommand(c)}
                        >
                          <code>/{c.name}</code>
                          <span>{c.description || c.source}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            }
          >
            {uploadError && (
              <div className="composer-attachment-error" role="alert">
                <span>{uploadError}</span>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="关闭附件错误"
                  onClick={() => setUploadError('')}
                >
                  <X size={15} />
                </button>
              </div>
            )}
            <ChatFiles
              files={staged}
              settings={settings}
              conversation={conversation}
              remove={(id) => {
                void api(
                  settings,
                  `/pi/conversations/${conversation}/files/${id}`,
                  undefined,
                  'DELETE',
                )
                  .then(() => {
                    setStaged((old) => old.filter((f) => f.id !== id));
                    pending.current = null;
                  })
                  .catch((e) => setError(e.message));
              }}
            />
            {uploading && (
              <p className="field-help composer-upload-status" role="status">
                <span>正在上传 {uploadLabel}…</span>
                <button
                  type="button"
                  className="text-link"
                  onClick={() => uploadController.current?.abort()}
                >
                  取消上传
                </button>
              </p>
            )}
            <input
              type="file"
              multiple
              hidden
              ref={fileInput}
              aria-label="选择聊天附件"
              onChange={(e) => {
                void uploadFiles(Array.from(e.target.files || []));
                e.target.value = '';
              }}
            />
            <AssistantComposerActions
              scope={`${viewKey}:${conversation}`}
              thinkingLevel={thinkingLevel}
              thinkingDisabled={manualCompacting}
              changeThinking={(level) => {
                pending.current = null;
                setThinkingLevel(level);
              }}
              insertVoice={(text) => {
                const area = composer.current;
                setInput((old) => {
                  const value = insertPastedText(
                    old,
                    text,
                    area?.selectionStart ?? old.length,
                    area?.selectionEnd ?? old.length,
                  );
                  requestAnimationFrame(() => {
                    area?.focus();
                    area?.setSelectionRange(value.cursor, value.cursor);
                  });
                  return value.value;
                });
              }}
              terminal={() => setTerminalOpen((value) => !value)}
              terminalDisabled={session.user.role !== 'owner'}
              attach={() => fileInput.current?.click()}
              attachmentDisabled={uploading || staged.length >= 8}
              attachmentTitle={`上传图片、PDF或文件，也可直接粘贴或拖到聊天窗口。${attachmentSizeMessage}`}
              commands={() => {
                setInput('/');
                composer.current?.focus();
                if (!generating) void inspect().catch(() => {});
              }}
              commandsDisabled={busy}
              working={generating || compacting}
              hasContent={!!input.trim() || !!staged.length}
              stop={() => void stopCurrent().catch((e) => setError(e.message))}
              sendDisabled={
                uploading ||
                loadingHistory ||
                manualCompacting ||
                (!input.trim() && !staged.length) ||
                !status?.available
              }
              sendAria="发送给 Pi"
              sendLabel={activeTask ? (sendMode === 'steer' ? '立即补充' : '排队') : '发送'}
            />
          </AssistantComposer>
          <div className="assistant-statusbar">
            <SessionTelemetry
              key={`telemetry:${conversation}`}
              settings={settings}
              conversationId={conversation}
              context={context}
              metrics={
                activeTask?.metrics || latestTask?.metrics || turns.at(-1)?.execution?.metrics
              }
            />
          </div>
        </section>
        {computerTarget && (
          <ComputerAssistantView
            titleChanged={titleChanged}
            key={computerTarget.deviceId + ':' + computerTarget.projectId}
            settings={settings}
            owner={session.user.id}
            target={computerTarget}
            groups={computers.groups}
            ready={computers.ready}
            connect={openComputerConnections}
            newConversation={() =>
              selectComputer({ ...computerTarget, conversationId: crypto.randomUUID() })
            }
          />
        )}
        <FileWorkbenchPanel
          browserProject={browse ? project || null : null}
          onCloseBrowser={() => setBrowse(false)}
          suspended={!!computerTarget}
        />
      </div>
    </FileWorkbenchProvider>
  );
}
