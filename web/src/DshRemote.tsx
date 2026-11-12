import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Menu, PanelRight, Plus, RefreshCw, Settings2, X } from 'lucide-react';
import { api, dateLabel } from './data';
import { readAssistantSelection, saveAssistantSelection } from '../../shared/assistant-resume.mjs';
import type { Settings } from './types';
import { AssistantComposer } from './AssistantComposer';
import { AssistantComposerActions } from './AssistantComposerActions';
import { ThinkingControl } from './ThinkingControl';
import { DshPermissions, DshSkills, useDshControls } from './DshControls';
import { DshExtensions } from './DshExtensions';
import { AssistantUserMessage } from './AssistantUserMessage';
import { CopyButton } from './CopyButton';
import { JumpToLatest } from './JumpToLatest';
import { RunSummary } from './ExecutionInfo';
import { ChatFiles, uploadChatFile, type ChatFile } from './ChatFiles';
import { AppFunctionRequests } from './AppFunctionRequests';
import { ToolLog, type ToolRun } from './ToolLog';
import { ProjectConversationList } from './ProjectConversationList';
import { ProjectSummary } from './ProjectSummary';
import {
  ConversationRow,
  ConversationMenu,
  ConversationEditor,
  type MenuAnchor,
  type Conversation,
} from './ConversationMenu';
import { useMobilePanels } from './MobilePanels';
import { useAssistantPreferences } from './assistant-preferences';
import { useBackLayer } from './back-navigation';
import './dsh-remote.css';
const Markdown = lazy(() => import('./PiMarkdown').then((m) => ({ default: m.PiMarkdown })));
const Terminal = lazy(() => import('./DshTerminal').then((m) => ({ default: m.DshTerminal })));
export type RemoteConnection = {
  id: string;
  name: string;
  origin: string;
  account: string;
  state: string;
  host: {
    deviceId: string;
    name: string;
    fingerprint: string;
    location: 'server' | 'computer';
  } | null;
};
type RemoteStatus = {
  enabled: boolean;
  chatAvailable: boolean;
  reason: string;
  allowedOrigins: string[];
  managedServer?: { name: string } | null;
};
type Catalogue = {
  host: { deviceId: string; name: string; location: 'server' | 'computer' };
  workspaces: { id: string; name: string }[];
  sessions: { id: string; title: string; workspaceIds: string[]; running: boolean }[];
};
type Question = {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
  intent?: { kind: string };
};
type Interaction = {
  id: string;
  kind: 'question' | 'approval';
  answerable: boolean;
  toolName?: string;
  reason?: string;
  questions?: Question[];
  deadline?: number;
};
type DshConversation = Conversation & {
  connectionId: string;
  projectId: string;
  sessionId: string;
  state: string;
  status: string;
  phase: string;
  error: string;
  stopPending: boolean;
  connection: 'connected' | 'reconnecting';
  messages: {
    id: string;
    role: string;
    text: string;
    thinking: string;
    time: number;
    rpcId?: string;
  }[];
  tools: (ToolRun & { time: number })[];
  interactions: Interaction[];
  uiRequests: { status: string }[];
  queue: { id: string; rpcId: string; text: string }[];
  model?: { provider: string; model: string; reasoningEffort?: string };
  permissions?: { currentValue: string } | null;
  hasMore: boolean;
  runState: { label: string; busy: boolean; state: string };
  actions: { id: string; kind: string; state: string; reference?: string }[];
  appTools: {
    available: boolean;
    enabled: boolean;
    tasks: { id: string; state: string; expiresAt: number }[];
  };
  inputs?: Record<string, ChatFile[]>;
  artifacts?: { taskId: string; file: ChatFile }[];
};
const remoteBase = '/agent/remote';
export function RemoteConnectionManager({
  settings,
  changed,
}: {
  settings: Settings;
  changed: () => void;
}) {
  const [status, setStatus] = useState<RemoteStatus | null>(null),
    [connections, setConnections] = useState<RemoteConnection[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [origin, setOrigin] = useState(''),
    [name, setName] = useState(''),
    [account, setAccount] = useState(''),
    [password, setPassword] = useState(''),
    [hosts, setHosts] = useState<
      Record<string, { deviceId: string; name: string; online?: boolean }[]>
    >({}),
    [identity, setIdentity] = useState<{
      connectionId: string;
      deviceId: string;
      name: string;
      fingerprint: string;
    } | null>(null),
    [fingerprint, setFingerprint] = useState(''),
    [location, setLocation] = useState<'server' | 'computer'>('computer');
  const creation = useRef<string | null>(null);
  async function refresh() {
    const s = await api<RemoteStatus>(settings, remoteBase + '/status');
    setStatus(s);
    if (s.enabled)
      setConnections(
        (await api<{ connections: RemoteConnection[] }>(settings, remoteBase + '/connections'))
          .connections,
      );
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [settings]);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await work();
      await refresh();
      changed();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="dsh-connection-settings" aria-label="DSH Remote连接">
      <h2>DSH Remote</h2>
      <p className="field-help">
        关联已有的DSH主机。远程加密连接由星屿服务器建立，服务器会处理聊天内容；主机仍使用自己的模型和权限。
      </p>
      {status && !status.enabled && <p className="field-help">{status.reason}</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {status?.enabled && (
        <>
          {status.managedServer && (
            <div className="surface">
              <h3>{status.managedServer.name}</h3>
              <p className="field-help">
                服务器上的独立DSH工作区，仅当前管理员可关联。支持聊天、附件和星屿软件功能；终端、思考与技能按主机实际提供的能力展示。
              </p>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(settings, remoteBase + '/managed/connect', {
                      id: crypto.randomUUID(),
                    });
                  })
                }
              >
                关联服务器DSH
              </button>
            </div>
          )}
          {connections.map((c) => (
            <div className="surface dsh-saved-connection" key={c.id}>
              <strong>{c.name}</strong>
              <small>
                {c.origin} · {c.account}
              </small>
              <p>
                {c.host
                  ? `${c.host.name} · ${c.host.location === 'server' ? '服务器' : '电脑'}`
                  : c.state === 'ready'
                    ? '等待选择并信任主机'
                    : '授权结果待核对，请移除此记录后重新关联'}
              </p>
              <div className="action-row">
                {!c.host && c.state === 'ready' && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const r = await api<{
                          hosts: { deviceId: string; name: string; online?: boolean }[];
                        }>(settings, remoteBase + `/connections/${c.id}/hosts`);
                        setHosts((old) => ({ ...old, [c.id]: r.hosts }));
                      })
                    }
                  >
                    选择主机
                  </button>
                )}
                <button
                  className="text-link"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await api(settings, remoteBase + `/connections/${c.id}`, undefined, 'DELETE');
                      setIdentity(null);
                    })
                  }
                >
                  断开并移除凭据
                </button>
              </div>
              {hosts[c.id] && !c.host && (
                <div className="question-options">
                  {hosts[c.id].map((h) => (
                    <button
                      disabled={busy}
                      key={h.deviceId}
                      onClick={() =>
                        void run(async () => {
                          const r = await api<{
                            deviceId: string;
                            name: string;
                            fingerprint: string;
                          }>(
                            settings,
                            remoteBase +
                              `/connections/${c.id}/identity?deviceId=${encodeURIComponent(h.deviceId)}`,
                          );
                          setIdentity({ ...r, connectionId: c.id });
                          setFingerprint('');
                        })
                      }
                    >
                      {h.name} · {h.online ? '在线' : '离线'}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {identity && (
            <form
              className="surface dsh-trust-host"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await api(settings, remoteBase + `/connections/${identity.connectionId}/trust`, {
                    deviceId: identity.deviceId,
                    fingerprint: fingerprint.replace(/\s/g, '').toUpperCase(),
                    location,
                  });
                  setIdentity(null);
                  setFingerprint('');
                });
              }}
            >
              <h3>核对 {identity.name} 的身份</h3>
              <p className="field-help">
                请在主机上独立核对身份密钥的SHA-256摘要，填写相同指纹后关联。
              </p>
              <code className="dsh-fingerprint">{identity.fingerprint}</code>
              <label className="field-label">
                主机指纹
                <input
                  className="standard-input"
                  value={fingerprint}
                  maxLength={96}
                  onChange={(e) => setFingerprint(e.target.value)}
                  required
                />
              </label>
              <div className="question-options" role="group" aria-label="主机位置">
                <button
                  type="button"
                  aria-pressed={location === 'computer'}
                  onClick={() => setLocation('computer')}
                >
                  电脑
                </button>
                <button
                  type="button"
                  aria-pressed={location === 'server'}
                  onClick={() => setLocation('server')}
                >
                  服务器
                </button>
              </div>
              <button
                className="primary"
                disabled={
                  busy || fingerprint.replace(/\s/g, '').toUpperCase() !== identity.fingerprint
                }
              >
                核对并关联主机
              </button>
            </form>
          )}
          {!!status.allowedOrigins.length && (
            <form
              className="dsh-add-connection"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  if (creation.current) throw Error('上次关联结果尚未核对，请刷新连接记录。');
                  const id = crypto.randomUUID();
                  creation.current = id;
                  const secret = password;
                  setPassword('');
                  try {
                    await api(settings, remoteBase + '/connections', {
                      id,
                      origin,
                      name,
                      account,
                      password: secret,
                    });
                    creation.current = null;
                    setName('');
                  } catch (e) {
                    await refresh();
                    throw e;
                  }
                });
              }}
            >
              <h3>关联Remote服务</h3>
              <label className="field-label">
                显示名称
                <input
                  className="standard-input"
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <label className="field-label">
                服务地址
                <input
                  className="standard-input"
                  list="dsh-approved-origins"
                  required
                  type="url"
                  value={origin}
                  onChange={(e) => setOrigin(e.target.value)}
                />
              </label>
              <datalist id="dsh-approved-origins">
                {status.allowedOrigins.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
              <label className="field-label">
                Remote账号
                <input
                  className="standard-input"
                  required
                  autoComplete="username"
                  value={account}
                  onChange={(e) => setAccount(e.target.value)}
                />
              </label>
              <label className="field-label">
                密码
                <input
                  className="standard-input"
                  required
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </label>
              <button
                className="primary"
                disabled={busy || !status.allowedOrigins.length || !!creation.current}
              >
                关联服务
              </button>
              {!status.allowedOrigins.length && (
                <p className="field-help">管理员尚未配置允许的Remote服务地址。</p>
              )}
            </form>
          )}
        </>
      )}
    </section>
  );
}

export function DshRemoteWorkspace({
  settings,
  owner,
  actions,
  openNavigation,
  manage,
}: {
  settings: Settings;
  owner: string;
  actions: ReactNode;
  openNavigation: () => void;
  manage: () => void;
}) {
  const [connections, setConnections] = useState<RemoteConnection[]>([]),
    [catalogues, setCatalogues] = useState<Record<string, Catalogue>>({}),
    [conversations, setConversations] = useState<DshConversation[]>([]),
    [selected, setSelected] = useState(
      () =>
        (readAssistantSelection(
          localStorage,
          sessionStorage,
          `astral.dsh.last:${settings.url}:${owner}`,
          'conversation',
        ) as string) || '',
    ),
    [conversation, setConversation] = useState<DshConversation | null>(null),
    [error, setError] = useState(''),
    [syncError, setSyncError] = useState(''),
    [busy, setBusy] = useState(false),
    [menu, setMenu] = useState<MenuAnchor | null>(null),
    [editing, setEditing] = useState<Conversation | null>(null),
    [archived, setArchived] = useState(false);
  const { displayPanel, setPanel } = useMobilePanels();
  const navigationOpen = displayPanel === 'conversations';
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    saveAssistantSelection(
      localStorage,
      `astral.dsh.last:${settings.url}:${owner}`,
      'conversation',
      selected || null,
    );
    try {
      sessionStorage.removeItem(`astral.dsh.last:${settings.url}:${owner}`);
    } catch {}
  }, [settings.url, owner, selected]);
  const scope = settings.url + ':' + owner;
  const [names, setNames] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem('astral.dsh.projectNames:' + scope) || '{}');
    } catch {
      return {};
    }
  });
  async function refresh() {
    const [c, list] = await Promise.all([
      api<{ connections: RemoteConnection[] }>(settings, remoteBase + '/connections'),
      api<{ conversations: DshConversation[] }>(settings, remoteBase + '/conversations'),
    ]);
    setConnections(c.connections);
    setConversations(list.conversations);
    if (selectedRef.current && !list.conversations.some((v) => v.id === selectedRef.current)) {
      setSelected(list.conversations.find((v) => !v.archivedAt)?.id || '');
    }
    const result: Record<string, Catalogue> = {};
    await Promise.all(
      c.connections
        .filter((v) => v.host)
        .map(async (v) => {
          try {
            result[v.id] = await api<Catalogue>(
              settings,
              remoteBase + `/connections/${v.id}/catalogue`,
            );
          } catch {
            /* Existing imported history remains visible offline. */
          }
        }),
    );
    setCatalogues(result);
  }
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [settings]);
  async function task(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open(connectionId: string, workspaceId: string, sessionId?: string) {
    const existing = conversations.find(
      (c) => c.connectionId === connectionId && c.sessionId === sessionId,
    );
    if (existing) {
      setSelected(existing.id);
      setPanel(null);
      return;
    }
    await task(async () => {
      const r = await api<{ conversation: DshConversation }>(
        settings,
        remoteBase + '/conversations',
        { id: crypto.randomUUID(), connectionId, workspaceId, ...(sessionId ? { sessionId } : {}) },
      );
      setSelected(r.conversation.id);
      setConversation(r.conversation);
      setPanel(null);
      setConversations((old) => [r.conversation, ...old.filter((c) => c.id !== r.conversation.id)]);
    });
  }
  useEffect(() => {
    if (!selected) {
      setConversation(null);
      return;
    }
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    setConversation(null);
    setSyncError('');
    const sync = async () => {
      try {
        const r = await api<{ conversation: DshConversation }>(
          settings,
          remoteBase + `/conversations/${selected}`,
          undefined,
          undefined,
          false,
          { fresh: true, timeout: 10000, signal: abort.signal },
        );
        if (live) {
          setSyncError('');
          setConversation(r.conversation);
          setConversations((old) => [r.conversation, ...old.filter((c) => c.id !== selected)]);
        }
      } catch (e) {
        if (live) setSyncError((e as Error).message);
      } finally {
        if (live) timer = setTimeout(sync, document.hidden ? 12000 : 650);
      }
    };
    void sync();
    return () => {
      live = false;
      abort.abort();
      clearTimeout(timer);
    };
  }, [selected, settings]);
  const current = connections.find((v) => v.id === conversation?.connectionId),
    catalogue = current ? catalogues[current.id] : undefined,
    projectName =
      conversation &&
      (names[conversation.connectionId + ':' + conversation.projectId] ||
        catalogue?.workspaces.find((p) => p.id === conversation.projectId)?.name ||
        'DSH项目');
  async function patch(id: string, body: object) {
    const r = await api<{ conversation: DshConversation }>(
      settings,
      remoteBase + `/conversations/${id}`,
      body,
      'PATCH',
    );
    setConversations((old) => old.map((c) => (c.id === id ? r.conversation : c)));
    if (selectedRef.current === id) setConversation(r.conversation);
  }
  return (
    <>
      <header className="assistant-workspace-heading chat-heading">
        <button className="mobile-menu icon-btn" aria-label="打开导航" onClick={openNavigation}>
          <Menu size={19} />
        </button>
        <div className="pi-heading-info">
          <h1>{conversation?.title || 'DSH智能助手'}</h1>
          <small className="pi-model-status">
            DSH · {current?.host?.name || '选择已有主机'}
            {projectName ? ` · ${projectName}` : ''}
          </small>
          {syncError && <small role="status">连接暂时中断，正在重新同步…</small>}
        </div>
        {actions}
        <button
          className="mobile-project-navigation icon-btn"
          aria-label="项目与对话"
          onClick={() => setPanel(navigationOpen ? null : 'conversations')}
        >
          <PanelRight size={17} />
        </button>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="chat-layout pi-layout assistant-layout dsh-workspace">
        <button
          className={`project-navigation-scrim ${navigationOpen ? 'is-open' : ''}`}
          tabIndex={navigationOpen ? 0 : -1}
          aria-hidden={!navigationOpen}
          aria-label="关闭项目与对话"
          onClick={() => setPanel(null)}
        />
        <aside
          aria-label="项目与对话"
          className={`surface contact-list project-conversation-list ${navigationOpen ? 'is-open' : ''}`}
        >
          <div className="project-navigation-heading">
            <strong>项目与对话</strong>
            <button className="icon-btn" aria-label="收起项目与对话" onClick={() => setPanel(null)}>
              <X size={18} />
            </button>
          </div>
          <div className="action-row">
            <button className="secondary" onClick={manage}>
              管理连接
            </button>
            <button
              className="icon-btn"
              aria-label="刷新DSH项目"
              disabled={busy}
              onClick={() => void task(refresh)}
            >
              <RefreshCw size={16} />
            </button>
          </div>
          {connections
            .filter((c) => c.host)
            .map((c) => {
              const cat = catalogues[c.id];
              const projects =
                cat?.workspaces ||
                [
                  ...new Set(
                    conversations.filter((v) => v.connectionId === c.id).map((v) => v.projectId),
                  ),
                ].map((id) => ({ id, name: 'DSH项目' }));
              return (
                <section className="assistant-computer-projects" key={c.id}>
                  <h2>
                    {c.host!.location === 'server' ? '服务器' : '电脑'} · {c.host!.name}
                  </h2>
                  {!cat && <p className="field-help">主机暂未连接，已关联的对话仍可查看。</p>}
                  {projects.map((project) => {
                    const key = c.id + ':' + project.id,
                      title = names[key] || project.name;
                    const list = conversations
                      .filter(
                        (v) =>
                          v.connectionId === c.id &&
                          v.projectId === project.id &&
                          !!v.archivedAt === archived,
                      )
                      .sort(
                        (a, b) =>
                          Number(!!b.pinnedAt) - Number(!!a.pinnedAt) ||
                          b.updatedAt.localeCompare(a.updatedAt),
                      );
                    return (
                      <details className="project-tree" key={project.id} open>
                        <ProjectSummary
                          name={title}
                          detail={list.length || ''}
                          newConversation={() => void open(c.id, project.id)}
                          saveName={async (name) => {
                            const next = { ...names };
                            if (name) next[key] = name;
                            else delete next[key];
                            localStorage.setItem(
                              'astral.dsh.projectNames:' + scope,
                              JSON.stringify(next),
                            );
                            setNames(next);
                          }}
                        />
                        <div className="project-conversations">
                          <ProjectConversationList>
                            {list.map((v) => (
                              <ConversationRow
                                key={v.id}
                                conversation={v}
                                selected={selected === v.id}
                                disabled={busy}
                                detail={
                                  v.runState?.busy ? v.runState.label : dateLabel(v.updatedAt)
                                }
                                choose={() => {
                                  setSelected(v.id);
                                  setPanel(null);
                                }}
                                openMenu={setMenu}
                              />
                            ))}
                          </ProjectConversationList>
                          {!archived &&
                          cat?.sessions.filter(
                            (s) =>
                              s.workspaceIds.includes(project.id) &&
                              !conversations.some(
                                (v) => v.connectionId === c.id && v.sessionId === s.id,
                              ),
                          ).length ? (
                            <details>
                              <summary>主机上的其他对话</summary>
                              {cat.sessions
                                .filter(
                                  (s) =>
                                    s.workspaceIds.includes(project.id) &&
                                    !conversations.some(
                                      (v) => v.connectionId === c.id && v.sessionId === s.id,
                                    ),
                                )
                                .map((s) => (
                                  <button
                                    key={s.id}
                                    className="contact-choice"
                                    disabled={busy}
                                    onClick={() => void open(c.id, project.id, s.id)}
                                  >
                                    {s.title}
                                  </button>
                                ))}
                            </details>
                          ) : null}
                        </div>
                      </details>
                    );
                  })}
                </section>
              );
            })}
          <button className="text-link" onClick={() => setArchived((v) => !v)}>
            {archived ? '返回最近对话' : '已归档对话'}
          </button>
        </aside>
        {conversation ? (
          <DshChat
            key={selected}
            settings={settings}
            owner={owner}
            conversation={conversation}
            update={(c) => {
              if (selectedRef.current === c.id) setConversation(c);
            }}
          />
        ) : (
          <div className="surface chat-panel">
            <div className="small-empty pi-welcome">
              <h2>选择一个DSH项目开始对话</h2>
              <p>在侧栏继续主机已有会话，或新建会话。</p>
              <button className="secondary" onClick={manage}>
                关联主机
              </button>
            </div>
          </div>
        )}
      </div>
      {menu && (
        <ConversationMenu
          anchor={menu}
          close={() => setMenu(null)}
          allowed={['pin', 'rename', 'new', 'archive']}
          action={(action, c) => {
            const v = conversations.find((v) => v.id === c.id)!;
            if (action === 'rename') setEditing(c);
            else if (action === 'new') void open(v.connectionId, v.projectId);
            else
              void task(() =>
                patch(
                  c.id,
                  action === 'pin' ? { pinned: !c.pinnedAt } : { archived: !c.archivedAt },
                ),
              );
          }}
        />
      )}
      {editing && (
        <ConversationEditor
          conversation={editing}
          kind="rename"
          running={false}
          close={() => setEditing(null)}
          submit={async (title) => {
            await patch(editing.id, { title });
          }}
        />
      )}
    </>
  );
}

function DshChat({
  settings,
  owner,
  conversation: c,
  update,
}: {
  settings: Settings;
  owner: string;
  conversation: DshConversation;
  update: (c: DshConversation) => void;
}) {
  const draftKey = `astral.dsh.draft:${settings.url}:${owner}:${c.id}`;
  type Pending = { id: string; text: string; mode: string; state: string; files?: ChatFile[] };
  const [attachments, setAttachments] = useState<ChatFile[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(draftKey + ':files') || '[]');
    } catch {
      return [];
    }
  });
  const [uploading, setUploading] = useState(false);
  const attachmentInput = useRef<HTMLInputElement>(null),
    uploadLock = useRef(false),
    uploadAbort = useRef(new AbortController());
  const attachmentsRef = useRef(attachments);
  function saveAttachments(files: ChatFile[]) {
    attachmentsRef.current = files;
    sessionStorage.setItem(draftKey + ':files', JSON.stringify(files));
    setAttachments(files);
  }
  const pendingKey = draftKey + ':pending';
  const [pending, setPending] = useState<Pending[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(pendingKey) || '[]');
    } catch {
      return [];
    }
  });
  const pendingRef = useRef(pending);
  const savePending = (next: Pending[]) => {
    sessionStorage.setItem(pendingKey, JSON.stringify(next));
    pendingRef.current = next;
    setPending(next);
  };
  const [input, setInput] = useState(() => sessionStorage.getItem(draftKey) || ''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [showLatest, setShowLatest] = useState(false),
    [lastAction, setLastAction] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    lock = useRef(false),
    alive = useRef(true);
  const { messageMode, showThinking } = useAssistantPreferences();
  const control = useDshControls(settings, c.id, c.connection === 'connected');
  const [terminalOpen, setTerminalOpen] = useState(false),
    [skillsOpen, setSkillsOpen] = useState(false),
    [extensionsOpen, setExtensionsOpen] = useState(false);
  const nativeModel = control.controls?.model;
  const nativeReasoning = control.controls?.models?.groups
    .find((g) => g.id === nativeModel?.provider)
    ?.models.find((m) => m.id === nativeModel?.model)?.reasoning;
  const effort = nativeModel?.reasoningEffort || nativeReasoning?.defaultEffort || '';
  useEffect(() => {
    void control.reload();
  }, [c.model?.provider, c.model?.model, c.model?.reasoningEffort, c.permissions?.currentValue]);
  useEffect(() => {
    alive.current = true;
    uploadAbort.current = new AbortController();
    return () => {
      alive.current = false;
      uploadAbort.current.abort();
    };
  }, []);
  useEffect(() => {
    sessionStorage.setItem(draftKey, input);
  }, [draftKey, input]);
  useEffect(() => {
    const seen = new Set([...c.messages.map((v) => v.rpcId), ...c.queue.map((v) => v.rpcId)]);
    const next = pendingRef.current
      .filter((v) => !seen.has(v.id))
      .map((v) => {
        const found = c.actions.find((a) => a.id === v.id);
        return found && found.state !== v.state ? { ...v, state: found.state } : v;
      });
    if (JSON.stringify(next) !== JSON.stringify(pendingRef.current)) savePending(next);
  }, [c.messages, c.queue, c.actions]);
  useLayoutEffect(() => {
    if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [c.messages, c.interactions]);
  async function upload(files: File[]) {
    if (!files.length) return;
    if (uploadLock.current || !c.appTools.available || c.connection !== 'connected') {
      setError('请连接支持星屿软件功能的DSH主机后添加附件。');
      return;
    }
    uploadLock.current = true;
    setUploading(true);
    setError('');
    try {
      if (attachmentsRef.current.length + files.length > 8) throw Error('每条消息最多8个附件。');
      // Choosing/pasting a file is explicit intent to use the file bridge.
      // Open the native chooser synchronously; enable the reversible bridge
      // after a file is selected, without losing browser user activation.
      if (!c.appTools.enabled) await perform('tools', { enabled: true });
      if (!alive.current || uploadAbort.current.signal.aborted) return;
      for (const file of files) {
        const result = await uploadChatFile(settings, c.id, file, {
          source: 'dsh',
          signal: uploadAbort.current.signal,
        });
        if (!alive.current) return;
        saveAttachments([...attachmentsRef.current, result]);
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      uploadLock.current = false;
      if (alive.current) setUploading(false);
    }
  }
  async function perform(kind: string, body: object) {
    const r = await api<{ conversation: DshConversation; operation: { state: string } }>(
      settings,
      remoteBase + `/conversations/${c.id}/${kind}`,
      body,
    );
    if (alive.current) update(r.conversation);
    return r;
  }
  async function send() {
    if (
      lock.current ||
      uploadLock.current ||
      (!input.trim() && !attachments.length) ||
      c.connection !== 'connected'
    )
      return;
    lock.current = true;
    setBusy(true);
    setError('');
    const text = input.trim() || '请查看这些附件。',
      files = attachmentsRef.current,
      id = crypto.randomUUID();
    try {
      if (pendingRef.current.length >= 50) throw Error('待核对消息较多，请先查看主机进度。');
      savePending([
        ...pendingRef.current,
        { id, text, mode: messageMode, state: 'sending', files },
      ]);
    } catch (e) {
      lock.current = false;
      setBusy(false);
      setError((e as Error).message);
      return;
    }
    setLastAction(id);
    setInput('');
    saveAttachments([]);
    follow.current = true;
    try {
      const result = await perform('prompt', {
        id,
        text,
        mode: messageMode,
        attachments: files.map((f) => f.id),
      });
      if (alive.current)
        savePending(
          pendingRef.current.map((v) =>
            v.id === id ? { ...v, state: result.operation.state } : v,
          ),
        );
    } catch (e) {
      if (alive.current)
        savePending(
          pendingRef.current.map((v) =>
            v.id === id
              ? {
                  ...v,
                  state: [400, 401, 403, 404].includes(
                    (e as Error & { status?: number }).status || 0,
                  )
                    ? 'rejected'
                    : 'unknown',
                }
              : v,
          ),
        );
      if (alive.current) setError((e as Error).message + '；请核对主机记录，系统不会自动重发。');
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function stop() {
    if (lock.current || c.stopPending) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      await perform('stop', { id: crypto.randomUUID() });
    } catch {
      if (alive.current) setError('停止结果待主机确认，请恢复连接后查看。');
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const latest = lastAction && c.actions.find((v) => v.id === lastAction);
  const displayedRequestIds = new Set([
    ...c.messages.map((v) => v.rpcId),
    ...c.queue.map((v) => v.rpcId),
  ]);
  const unresolvedPending = pending.filter((v) => !displayedRequestIds.has(v.id));
  return (
    <div className="surface chat-panel">
      <details
        className="dsh-chat-settings"
        onToggle={(e) => {
          if (e.currentTarget.open) void control.reload();
        }}
      >
        <summary>
          <Settings2 size={16} />
          设置
        </summary>
        <DshPermissions
          controls={control.controls}
          disabled={control.loading || c.connection !== 'connected'}
          select={(v) => void control.select('permission', v)}
        />
        <div className="dsh-workbench-actions">
          <button
            type="button"
            className="secondary"
            disabled={control.loading || c.connection !== 'connected'}
            onClick={() => void control.reload()}
          >
            <RefreshCw size={14} />
            刷新主机设置
          </button>
          <button type="button" className="secondary" onClick={() => setSkillsOpen(true)}>
            技能
          </button>
          <button
            type="button"
            className="secondary"
            disabled={c.connection !== 'connected'}
            onClick={() => setExtensionsOpen(true)}
          >
            扩展管理
          </button>
          <button
            type="button"
            className="secondary"
            disabled={!control.controls?.terminal || c.connection !== 'connected'}
            onClick={() => setTerminalOpen(true)}
          >
            终端
          </button>
        </div>
        {control.error && (
          <p className="error" role="alert">
            {control.error}
          </p>
        )}
        <label>
          <input
            type="checkbox"
            checked={c.appTools.enabled}
            disabled={busy || !c.appTools.available || c.connection !== 'connected'}
            onChange={(e) => {
              setBusy(true);
              setError('');
              void perform('tools', { enabled: e.target.checked })
                .catch((e) => setError(e.message))
                .finally(() => {
                  if (alive.current) setBusy(false);
                });
            }}
          />
          在此对话使用星屿软件功能
        </label>
        <p className="field-help">
          {c.appTools.available
            ? '启用后，新消息可使用附件、文件交付，以及当前账号的邮件、联系人、学习和记忆。指定主机需安装星屿工具插件；发送邮件或消息时在这里确认。关闭后撤销正在使用的工具授权。'
            : '服务器尚未配置软件工具入口。'}
        </p>
      </details>
      <div className="pi-message-area" data-conversation-swipe>
        <div
          className="message-scroll pi-messages"
          role="region"
          aria-label="对话消息"
          tabIndex={0}
          ref={scroll}
          onScroll={() => {
            const node = scroll.current!;
            follow.current = node.scrollHeight - node.clientHeight - node.scrollTop < 48;
            setShowLatest(!follow.current);
          }}
        >
          <div className="pi-message-content">
            {c.hasMore && (
              <button
                className="load-history text-link"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  follow.current = false;
                  void perform('history', {})
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                加载更早对话 · 不影响模型上下文
              </button>
            )}
            {c.messages.map((m) =>
              m.role === 'user' ? (
                <AssistantUserMessage
                  key={m.id}
                  input={m.text}
                  at={new Date(m.time).toISOString()}
                  settings={settings}
                  conversation={c.id}
                  files={c.inputs?.[m.rpcId || ''] || []}
                />
              ) : (
                <div className="message assistant" key={m.id}>
                  {m.thinking && showThinking && (
                    <details className="pi-thinking">
                      <summary>思考过程</summary>
                      <Suspense fallback={<pre>{m.thinking}</pre>}>
                        <Markdown text={m.thinking} />
                      </Suspense>
                    </details>
                  )}
                  <Suspense fallback={<pre>{m.text}</pre>}>
                    <Markdown text={m.text} />
                  </Suspense>
                  {!m.id.startsWith('live:') && <CopyButton text={m.text} />}
                </div>
              ),
            )}
            <ToolLog
              tools={c.tools.map((t) => ({
                ...t,
                path: '.',
                command: t.name === 'bash' ? t.arguments : undefined,
              }))}
            />
            {!!c.artifacts?.length && (
              <section aria-label="DSH交付文件">
                <ChatFiles
                  files={c.artifacts.map((a) => a.file)}
                  settings={settings}
                  conversation={c.id}
                />
              </section>
            )}
            <RunSummary
              backend="dsh"
              status={c.status}
              phase={c.phase}
              stopPending={c.stopPending}
              uiRequests={c.uiRequests}
              connection={c.connection}
            />
            {c.error && <p className="error">{c.error}</p>}
            {c.interactions.map((item) => (
              <DshInteraction
                key={item.id}
                item={item}
                blocked={c.actions.some(
                  (v) =>
                    v.kind === 'respond' &&
                    v.reference === item.id &&
                    ['sending', 'unknown', 'accepted', 'observed'].includes(v.state),
                )}
                reply={(response) =>
                  perform('respond', {
                    id: crypto.randomUUID(),
                    interactionId: item.id,
                    response,
                  }).then(() => {})
                }
              />
            ))}
            {c.appTools.tasks.map((task) => (
              <AppFunctionRequests
                key={task.id}
                settings={settings}
                taskId={task.id}
                active={task.state !== 'binding'}
              />
            ))}
          </div>
        </div>
        {showLatest && (
          <JumpToLatest
            onClick={() => {
              follow.current = true;
              scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
              setShowLatest(false);
            }}
          />
        )}
      </div>
      {c.queue.length > 0 && (
        <details className="dsh-pending-messages">
          <summary>待处理补充 · {c.queue.length}</summary>
          {c.queue.map((v) => (
            <p key={v.id}>{v.text}</p>
          ))}
        </details>
      )}
      {latest && ['unknown', 'sending'].includes(latest.state) && (
        <p className="field-help">上一条消息结果待核对，系统不会自动重发。</p>
      )}
      {unresolvedPending.length > 0 && (
        <details className="dsh-pending-messages">
          <summary>尚未出现在主机记录中 · {unresolvedPending.length}</summary>
          {unresolvedPending.map((v) => (
            <div key={v.id}>
              <p>{v.text}</p>
              <small>
                {v.state === 'rejected'
                  ? '此次消息未提交'
                  : v.state === 'accepted'
                    ? '主机已接收，等待记录更新'
                    : '送达结果待核对，不会自动重发'}
              </small>
              {v.state === 'rejected' && (
                <button
                  className="text-link"
                  onClick={() => {
                    setInput((old) => v.text + (old ? '\n\n' + old : ''));
                    saveAttachments(
                      [
                        ...new Map(
                          [...attachmentsRef.current, ...(v.files || [])].map((f) => [f.id, f]),
                        ).values(),
                      ].slice(0, 8),
                    );
                    savePending(pendingRef.current.filter((p) => p.id !== v.id));
                  }}
                >
                  恢复到草稿
                </button>
              )}
            </div>
          ))}
        </details>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <input
        ref={attachmentInput}
        type="file"
        multiple
        hidden
        aria-label="选择DSH附件"
        onChange={(e) => {
          const files = [...(e.target.files || [])];
          e.target.value = '';
          void upload(files);
        }}
      />
      {uploading && (
        <p role="status" className="field-help">
          正在上传附件…
        </p>
      )}
      <AssistantComposer
        area={area}
        history={scroll}
        value={input}
        onValue={setInput}
        send={send}
        upload={upload}
        attributes={{
          'aria-label': '发送给DSH的消息',
          placeholder: '发送消息… 执行中也可继续补充',
        }}
        header={
          <ChatFiles
            files={attachments}
            settings={settings}
            conversation={c.id}
            remove={(id) => {
              if (uploadLock.current || lock.current) return;
              void api(
                settings,
                remoteBase + `/conversations/${c.id}/files/${id}`,
                undefined,
                'DELETE',
              )
                .then(() => {
                  if (alive.current)
                    saveAttachments(attachmentsRef.current.filter((f) => f.id !== id));
                })
                .catch((e) => setError(e.message));
            }}
          />
        }
      >
        <AssistantComposerActions
          scope={c.id}
          thinkingLevel="off"
          thinkingControl={
            <ThinkingControl
              value={effort}
              options={(nativeReasoning?.efforts || []).map((e) => ({
                value: e.id,
                label:
                  (
                    { off: '关闭', low: '轻量', high: '深入', max: '充分' } as Record<
                      string,
                      string
                    >
                  )[e.id] || e.name,
                description: e.description,
              }))}
              disabled={
                control.loading || !nativeReasoning?.efforts.length || c.connection !== 'connected'
              }
              disabledReason={
                control.loading
                  ? '正在核对主机设置…'
                  : !nativeReasoning?.efforts.length
                    ? control.error || '主机未提供可用思考档位；请在设置中刷新主机状态。'
                    : c.connection !== 'connected'
                      ? '请恢复主机连接。'
                      : undefined
              }
              onUnavailable={() =>
                setError(control.error || '主机未提供可用思考档位；请在设置中刷新主机状态。')
              }
              onChange={(v) => void control.select('thinking', v)}
            />
          }
          changeThinking={() => {}}
          insertVoice={(v) => setInput((old) => old + v)}
          terminal={() => setTerminalOpen(true)}
          terminalDisabled={!control.controls?.terminal || c.connection !== 'connected'}
          terminalDisabledReason="主机未提供终端，请在DSH主机的Remote设置中开启远程终端并刷新。"
          attach={() => attachmentInput.current?.click()}
          attachmentDisabled={
            busy || uploading || !c.appTools.available || c.connection !== 'connected'
          }
          attachmentDisabledReason={
            !c.appTools.available ? '此服务器尚未提供DSH附件入口。' : undefined
          }
          attachmentTitle="单文件50 MiB；传输原件至DSH主机最多20 MiB，较大文档可分页读取"
          commands={() => setSkillsOpen(true)}
          commandsAria="打开DSH技能"
          working={c.runState.busy}
          hasContent={!!input.trim() || !!attachments.length}
          stop={() => void stop()}
          sendDisabled={
            busy ||
            uploading ||
            (!input.trim() && !attachments.length) ||
            c.connection !== 'connected'
          }
          sendDisabledReason={c.connection !== 'connected' ? '请等待主机重新连接。' : undefined}
          sendLabel={c.runState.busy ? (messageMode === 'steer' ? '补充' : '排队') : '发送'}
          sendAria="发送给DSH"
        />
      </AssistantComposer>
      {skillsOpen && (
        <DshSkills
          skills={control.controls?.skills ?? null}
          refresh={() => void control.reload()}
          loading={control.loading}
          close={() => setSkillsOpen(false)}
          choose={(name) => {
            setInput((old) => '/' + name + (old ? ' ' + old : ' '));
            setSkillsOpen(false);
            area.current?.focus();
          }}
        />
      )}
      {extensionsOpen && (
        <DshExtensions
          settings={settings}
          owner={owner}
          id={c.id}
          close={() => setExtensionsOpen(false)}
          updated={() => void control.reload()}
        />
      )}
      {terminalOpen && (
        <div
          className="assistant-modal-backdrop dsh-workbench-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setTerminalOpen(false);
          }}
        >
          <section
            className="assistant-modal dsh-terminal-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="DSH工作区终端"
          >
            <Suspense fallback={<p>正在打开终端…</p>}>
              <Terminal
                settings={settings}
                conversation={c.id}
                close={() => setTerminalOpen(false)}
              />
            </Suspense>
          </section>
        </div>
      )}
    </div>
  );
}

function DshInteraction({
  item,
  reply,
  blocked,
}: {
  item: Interaction;
  reply: (response: object) => Promise<void>;
  blocked: boolean;
}) {
  const [answers, setAnswers] = useState<Record<string, { selected: string[]; custom: string }>>(
      {},
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [sent, setSent] = useState(false);
  const locked = busy || sent || blocked || !item.answerable;
  async function send(response: object) {
    if (locked) return;
    setBusy(true);
    setError('');
    try {
      await reply(response);
      setSent(true);
    } catch (e) {
      setError((e as Error).message + '；请刷新核对问题状态，答复不会自动重发。');
      setSent(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="plugin-request"
      onSubmit={(e) => {
        e.preventDefault();
        if (item.kind === 'question')
          void send({
            answers: item.questions!.map((q) => ({
              id: q.id,
              selected: answers[q.id]?.selected || [],
              ...(answers[q.id]?.custom ? { custom: answers[q.id].custom } : {}),
            })),
          });
      }}
    >
      <strong>
        {item.kind === 'approval' ? `允许本次执行 ${item.toolName}？` : 'DSH需要你的回复'}
      </strong>
      {item.reason && <p>{item.reason}</p>}
      {item.questions?.map((q) => (
        <fieldset key={q.id} disabled={locked}>
          <legend>{q.question}</legend>
          {q.detail && <p>{q.detail}</p>}
          <div className="question-options">
            {q.options?.map((option) => (
              <button
                type="button"
                key={option.label}
                aria-pressed={answers[q.id]?.selected.includes(option.label) || false}
                onClick={() =>
                  setAnswers((old) => {
                    const current = old[q.id]?.selected || [],
                      selected = q.multiSelect
                        ? current.includes(option.label)
                          ? current.filter((v) => v !== option.label)
                          : [...current, option.label]
                        : [option.label];
                    return {
                      ...old,
                      [q.id]: { selected, custom: q.multiSelect ? old[q.id]?.custom || '' : '' },
                    };
                  })
                }
              >
                <b>{option.label}</b>
                {option.description && <small>{option.description}</small>}
              </button>
            ))}
          </div>
          {q.intent?.kind !== 'approval' && (
            <label className="question-other-answer">
              其他答案
              <input
                className="standard-input"
                maxLength={4000}
                value={answers[q.id]?.custom || ''}
                onChange={(e) =>
                  setAnswers((old) => ({
                    ...old,
                    [q.id]: {
                      selected: q.multiSelect ? old[q.id]?.selected || [] : [],
                      custom: e.target.value,
                    },
                  }))
                }
              />
            </label>
          )}
        </fieldset>
      ))}
      {!item.answerable && <p className="field-help">正在核对主机问题状态，原答复窗口已不可用。</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="plugin-request-actions">
        {item.kind === 'approval' ? (
          <>
            <button
              type="button"
              className="secondary"
              disabled={locked}
              onClick={() => void send({ allowed: false })}
            >
              拒绝
            </button>
            <button
              type="button"
              className="primary"
              disabled={locked}
              onClick={() => void send({ allowed: true })}
            >
              允许本次
            </button>
          </>
        ) : (
          <button
            className="primary"
            disabled={
              locked ||
              item.questions!.some(
                (q) => !answers[q.id]?.selected.length && !answers[q.id]?.custom.trim(),
              )
            }
          >
            {sent ? '已提交，等待主机确认' : '回答并继续'}
          </button>
        )}
      </div>
    </form>
  );
}
