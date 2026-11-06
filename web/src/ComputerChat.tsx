import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AssistantComposerActions } from './AssistantComposerActions';
import { AssistantComposer } from './AssistantComposer';
import { AssistantUserMessage } from './AssistantUserMessage';
import { AssistantSettings } from './AssistantSettings';
import { AssistantMode } from './AssistantMode';
import { attachmentSizeMessage } from '../../deploy/pi/attachment-limits.mjs';
import { ChevronDown } from 'lucide-react';
import { api } from './data';
import { peekAPI, invalidateAPI } from './resource-cache';
import { serverIdentity } from './session';
import { CopyButton } from './CopyButton';
import { ChatFiles, uploadChatFile, type ChatFile } from './ChatFiles';
import { ToolLog, type ToolRun } from './ToolLog';
import { useMessageOutbox } from './message-outbox';
import { MessageOutbox } from './MessageOutbox';
import { AppFunctionRequests } from './AppFunctionRequests';
import { PluginRequests, type PluginRequest } from './PluginRequests';
import { LongGoalCard, type LongGoalState } from './LongGoalCard';
import { RunSummary } from './ExecutionInfo';
import { useAssistantPreferences } from './assistant-preferences';
import { computerChatStorageKey } from '../../shared/assistant-target.mjs';
import { insertPastedText } from './composer-paste';
import type { ComputerProject } from './computer-api';
import type { Settings } from './types';
const Markdown = lazy(() => import('./PiMarkdown').then((m) => ({ default: m.PiMarkdown })));
type Conversation = {
  id: string;
  title: string;
  updatedAt: string;
  version?: string;
  active?: number;
};
type Job = {
  id: string;
  conversationId: string;
  projectId: string;
  parentId: string | null;
  input: string;
  output: string;
  thinking: string;
  status: string;
  phase: string;
  uiRequests?: PluginRequest[];
  longGoal?: LongGoalState | null;
  tools: ToolRun[];
  artifacts?: ChatFile[];
  error?: string;
  access: 'read' | 'edit';
  execute: boolean;
  thinkingLevel?: 'off' | 'low' | 'high' | 'max';
  attachments?: ChatFile[];
  createdAt: string;
};
const pending = (j: Job) =>
  ['queued', 'running', 'delivering', 'accepted', 'applied'].includes(j.status);
const phase = (j: Job) =>
  j.status === 'running'
    ? j.phase || '正在执行'
    : (
        {
          queued: '等待目标电脑',
          done: '已完成',
          error: '执行失败',
          cancelled: '已停止',
          interrupted: '已中断',
        } as Record<string, string>
      )[j.status] || j.status;
export function ComputerChat({
  settings,
  owner,
  deviceId,
  project,
  conversationId,
  settingsContainer,
  terminal,
  files,
  plugins,
  newConversation,
  capabilities,
  titleChanged,
}: {
  settings: Settings;
  owner: string;
  deviceId: string;
  project: ComputerProject;
  conversationId: string;
  capabilities: string[];
  titleChanged: (id: string, title: string) => void;
  settingsContainer: HTMLElement | null;
  terminal: () => void;
  files: () => void;
  plugins: () => void;
  newConversation: () => void;
}) {
  const base =
      '/relay/conversations?deviceId=' +
      deviceId +
      '&projectId=' +
      project.id +
      '&archived=include',
    key = computerChatStorageKey(serverIdentity(settings), owner, deviceId, project.id);
  const id = conversationId;
  const [staged, setStaged] = useState<ChatFile[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(key + ':attachments:' + id) || '[]');
    } catch {
      return [];
    }
  });
  const [uploading, setUploading] = useState(false),
    [uploadError, setUploadError] = useState(''),
    [uploadLabel, setUploadLabel] = useState(''),
    [commandsOpen, setCommandsOpen] = useState(false);
  const uploader = useRef<AbortController | null>(null),
    uploadBusy = useRef(false),
    fileInput = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState(() => sessionStorage.getItem(key + ':draft:' + id) || ''),
    [jobs, setJobs] = useState<Job[]>([]),
    [older, setOlder] = useState<string | null>(null),
    [access, setAccess] = useState<'read' | 'edit'>('read'),
    [execute, setExecute] = useState(false),
    [error, setError] = useState(''),
    [showLatest, setShowLatest] = useState(false);
  const current = useRef(id);
  const titleCallback = useRef(titleChanged);
  titleCallback.current = titleChanged;
  const { messageMode: mode, setMessageMode: setMode } = useAssistantPreferences();
  const [thinkingLevel, setThinkingLevel] = useState<'off' | 'low' | 'high' | 'max'>(() => {
    try {
      const value = localStorage.getItem('astral.pi.thinkingLevel');
      return ['off', 'low', 'high', 'max'].includes(value || '')
        ? (value as 'off' | 'low' | 'high' | 'max')
        : 'off';
    } catch {
      return 'off';
    }
  });
  current.current = id;
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const reload = useRef<() => void>(() => {}),
    historyExtended = useRef(false),
    prepend = useRef<{ top: number; height: number } | null>(null),
    content = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null),
    area = useRef<HTMLTextAreaElement>(null),
    follow = useRef(true),
    alive = useRef(true);
  const { manager: outbox, rows } = useMessageOutbox(settings, owner, {
    deviceId,
    projectId: project.id,
  });
  const active = jobs.find((j) => !j.parentId && j.status === 'running'),
    queued = jobs.filter((j) => !j.parentId && j.status === 'queued'),
    working = !!active || queued.length > 0;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      uploader.current?.abort();
    };
  }, []);
  useEffect(() => {
    sessionStorage.setItem(key, id);
    sessionStorage.setItem(key + ':draft:' + id, input);
    sessionStorage.setItem(key + ':attachments:' + id, JSON.stringify(staged));
  }, [key, id, input, staged]);
  useEffect(() => {
    historyExtended.current = false;
    let live = true,
      busy = false,
      lastPoll = 0,
      otherActive = false,
      checked = false;
    const cached = peekAPI<{ jobs: Job[]; next: string | null; conversation: Conversation }>(
      settings,
      '/relay/conversations/' + id,
    );
    let lastVersion = cached?.conversation?.version;
    checked = !!lastVersion;
    setJobs(cached?.jobs || []);
    setOlder(cached?.next || null);
    setError('');
    async function load(force = false) {
      if (busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const urgent = otherActive || jobsRef.current.some(pending);
        if (!force && !urgent && Date.now() - lastPoll < 10000) return;
        lastPoll = Date.now();
        const list = await api<{ conversations: Conversation[] }>(
          settings,
          base,
          undefined,
          undefined,
          false,
          { fresh: true },
        );
        if (!live) return;
        otherActive = list.conversations.some((c) => !!c.active);
        const selected = list.conversations.find((c) => c.id === id);
        if ((selected && (!selected.version || selected.version !== lastVersion)) || !checked) {
          checked = true;
          try {
            const r = await api<{ jobs: Job[]; next: string | null; conversation: Conversation }>(
              settings,
              '/relay/conversations/' + id,
              undefined,
              undefined,
              false,
              { fresh: true },
            );
            if (live) {
              titleCallback.current(id, r.conversation.title);
              if (
                r.jobs.some(
                  (j) =>
                    j.status === 'done' &&
                    jobsRef.current.find((old) => old.id === j.id)?.status !== 'done' &&
                    j.tools.some((t) =>
                      ['project_write', 'project_edit', 'computer_exec'].includes(t.name),
                    ),
                )
              )
                invalidateAPI(settings, '/relay/files/' + deviceId + '/' + project.id + '/');
              lastVersion = r.conversation.version;
              setJobs((old) =>
                [...new Map([...old, ...r.jobs].map((j) => [j.id, j])).values()].sort((a, b) =>
                  a.createdAt.localeCompare(b.createdAt),
                ),
              );
              if (!historyExtended.current) setOlder(r.next);
              setError('');
            }
          } catch (e) {
            if ((e as Error & { status?: number }).status !== 404) throw e;
          }
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      } finally {
        busy = false;
      }
    }
    reload.current = () => void load(true);
    const focus = () => void load(true);
    void load(true);
    const timer = setInterval(() => void load(), 1000);
    window.addEventListener('focus', focus);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('focus', focus);
    };
  }, [id, settings, deviceId, project.id]);
  useEffect(() => {
    const received = rows
      .filter((r) => r.status === 'accepted')
      .map((r) => r.receipt?.task as unknown as Job)
      .filter((j) => j?.id);
    const own = received.filter((j) => j.conversationId === id);
    if (own.length) {
      setJobs((old) =>
        [
          ...new Map(
            [...old, ...own.filter((j) => !old.some((o) => o.id === j.id))].map((j) => [j.id, j]),
          ).values(),
        ].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      );
      reload.current();
    }
    outbox.confirm([...new Set([...jobs.map((j) => j.id), ...received.map((j) => j.id)])]);
  }, [rows, jobs, id, outbox]);
  useEffect(() => {
    if (active) {
      setAccess(active.access);
      setExecute(active.execute);
    }
  }, [active?.id]);
  useEffect(() => {
    if (!project.allowExecute) setExecute(false);
    if (project.readOnly) setAccess('read');
  }, [project.allowExecute, project.readOnly]);
  useLayoutEffect(() => {
    if (!scroll.current) return;
    if (prepend.current) {
      scroll.current.scrollTop =
        prepend.current.top + scroll.current.scrollHeight - prepend.current.height;
      prepend.current = null;
    } else if (follow.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [jobs, rows]);
  useEffect(() => {
    if (!content.current) return;
    const observer = new ResizeObserver(() => {
      if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    });
    observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  async function loadOlder() {
    const selected = id;
    try {
      const r = await api<{ jobs: Job[]; next: string | null }>(
        settings,
        '/relay/conversations/' + id + '?before=' + older,
        undefined,
        undefined,
        false,
        { fresh: false },
      );
      if (!alive.current || current.current !== selected) return;
      historyExtended.current = true;
      if (scroll.current) {
        follow.current = false;
        prepend.current = { top: scroll.current.scrollTop, height: scroll.current.scrollHeight };
      }
      setJobs((old) => [...new Map([...r.jobs, ...old].map((j) => [j.id, j])).values()]);
      setOlder(r.next);
    } catch (e) {
      if (alive.current && current.current === selected) setError((e as Error).message);
    }
  }
  async function uploadFiles(incoming: File[]) {
    if (!incoming.length) return;
    if (uploadBusy.current) {
      setUploadError('请等待当前上传完成，或取消当前上传。');
      return;
    }
    if (staged.length + incoming.length > 8) {
      setUploadError('每条消息最多附加8个文件。');
      return;
    }
    const controller = new AbortController();
    uploader.current = controller;
    uploadBusy.current = true;
    setUploading(true);
    setUploadError('');
    let name = '';
    try {
      for (const [index, file] of incoming.entries()) {
        name = file.name;
        setUploadLabel(`${index + 1}/${incoming.length} · ${file.name}`);
        const uploaded = await uploadChatFile(settings, id, file, { signal: controller.signal });
        if (alive.current) setStaged((old) => [...old, uploaded]);
      }
    } catch (e) {
      if (alive.current)
        setUploadError(
          controller.signal.aborted
            ? '已取消当前上传，已完成的附件仍保留。'
            : name + '：' + (e as Error).message,
        );
    } finally {
      uploadBusy.current = false;
      uploader.current = null;
      if (alive.current) setUploading(false);
    }
  }
  function send() {
    if ((!input.trim() && !staged.length) || uploadBusy.current) return;
    try {
      outbox.add(
        {
          id: crypto.randomUUID(),
          deviceId,
          projectId: project.id,
          conversationId: id,
          input: input.trim(),
          access,
          execute,
          thinkingLevel: capabilities.includes('thinking_levels') ? thinkingLevel : 'off',
          attachments: staged.map((f) => f.id),
          mode: active ? 'steer' : 'queue',
          parentId: active?.id || null,
          deliveryPreference: mode,
        },
        staged,
      );
      setInput('');
      setStaged([]);
      sessionStorage.removeItem(key + ':draft:' + id);
      follow.current = true;
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function stop() {
    const target = active || queued[0];
    if (!target) return;
    try {
      await api(settings, '/relay/jobs/' + target.id + '/cancel', {});
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    }
  }
  return (
    <section className="computer-chat" aria-label="电脑项目对话">
      <div
        className="pi-messages computer-messages"
        data-conversation-swipe
        ref={scroll}
        role="log"
        aria-label="电脑对话消息"
        onScroll={() => {
          const e = scroll.current!;
          follow.current = e.scrollHeight - e.clientHeight - e.scrollTop < 48;
          setShowLatest(!follow.current);
        }}
      >
        <div ref={content} className="pi-message-content">
          {older && (
            <button className="text-link" onClick={() => void loadOlder()}>
              加载更早记录
            </button>
          )}
          {!jobs.length && (
            <p className="field-help">
              当前对话绑定这台电脑的“{project.name}
              ”。可读取项目、解释代码，或按本机授权修改和执行任务。
            </p>
          )}
          {jobs
            .filter((j) => !j.parentId)
            .map((j) => (
              <article className="pi-turn" data-message-id={j.id} key={j.id}>
                <AssistantUserMessage
                  input={j.input}
                  at={j.createdAt}
                  files={j.attachments || []}
                  settings={settings}
                  conversation={id}
                />
                <div className="message assistant">
                  <RunSummary status={j.status} phase={phase(j)} />
                  <LongGoalCard goal={j.longGoal} status={j.status} />
                  {jobs
                    .filter((c) => c.parentId === j.id)
                    .map((c) => (
                      <div className="computer-supplement" key={c.id}>
                        <small>
                          {(
                            {
                              delivering: '补充送达中',
                              accepted: '已接受补充',
                              applied: '已加入当前任务',
                              done: '任务补充',
                              interrupted: '补充应用待确认',
                              error: '补充未送达',
                            } as Record<string, string>
                          )[c.status] || c.status}
                        </small>
                        <p>{c.input}</p>
                        {c.error && <p className="error">{c.error}</p>}
                      </div>
                    ))}
                  {j.thinking && (
                    <details>
                      <summary>思考过程</summary>
                      <p>{j.thinking}</p>
                    </details>
                  )}
                  <AppFunctionRequests
                    settings={settings}
                    taskId={j.id}
                    active={j.status === 'running'}
                  />
                  <ToolLog tools={j.tools} />
                  <PluginRequests
                    settings={settings}
                    task={j}
                    target="computer"
                    onAnswered={() => reload.current()}
                  />
                  {j.output && (
                    <Suspense fallback={<pre>{j.output}</pre>}>
                      <Markdown text={j.output} />
                    </Suspense>
                  )}
                  {!!j.artifacts?.length && (
                    <ChatFiles files={j.artifacts} settings={settings} conversation={id} />
                  )}
                  {j.error && (
                    <p role="alert" className="error">
                      {j.error}
                    </p>
                  )}
                  {j.output && (
                    <div className="message-actions">
                      <CopyButton text={j.output} label="复制电脑Agent回复" />
                    </div>
                  )}
                </div>
              </article>
            ))}
        </div>
      </div>
      {showLatest && (
        <button
          className="text-link"
          onClick={() => {
            follow.current = true;
            scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' });
            setShowLatest(false);
          }}
        >
          <ChevronDown size={14} />
          回到最新
        </button>
      )}
      <MessageOutbox
        rows={rows.filter((r) => r.payload.conversationId === id)}
        retry={outbox.retry}
        reconcile={outbox.reconcile}
        restore={(r) => {
          setStaged((old) =>
            [...new Map([...r.files, ...old].map((f) => [f.id, f])).values()].slice(0, 8),
          );
          setInput((old) => r.payload.input + (old ? '\n\n' + old : ''));
          outbox.remove(r.payload.id);
          area.current?.focus();
        }}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <AssistantComposer
        area={area}
        history={scroll}
        value={input}
        send={send}
        upload={uploadFiles}
        attributes={{ 'aria-label': '发送给电脑Agent' }}
        onValue={(value) => {
          setInput(value);
          setCommandsOpen(value === '/');
        }}
        onKeyDown={(e) => {
          if (commandsOpen && e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setCommandsOpen(false);
          }
        }}
      >
        {commandsOpen && (
          <div className="pi-command-menu" aria-label="电脑项目命令">
            <div className="pi-command-heading">
              <b>项目命令</b>
              <small>Esc关闭</small>
            </div>
            {[
              { name: 'files', label: '查看项目文件', run: files },
              { name: 'terminal', label: '打开目标电脑终端', run: terminal },
              { name: 'plugins', label: '查看电脑工具和插件', run: plugins },
              { name: 'new', label: '新建同项目对话', run: newConversation },
            ].map((c) => (
              <button
                type="button"
                key={c.name}
                onClick={() => {
                  setInput('');
                  setCommandsOpen(false);
                  c.run();
                }}
              >
                <code>/{c.name}</code>
                <span>{c.label}</span>
              </button>
            ))}
          </div>
        )}
        {uploadError && (
          <div className="composer-attachment-error" role="alert">
            <span>{uploadError}</span>
            <button
              type="button"
              className="icon-btn"
              aria-label="关闭附件错误"
              onClick={() => setUploadError('')}
            >
              ×
            </button>
          </div>
        )}
        <ChatFiles
          files={staged}
          settings={settings}
          conversation={id}
          remove={(fileId) =>
            void api(settings, `/pi/conversations/${id}/files/${fileId}`, undefined, 'DELETE')
              .then(() => setStaged((old) => old.filter((f) => f.id !== fileId)))
              .catch((e) => setUploadError(e.message))
          }
        />
        {uploading && (
          <p className="field-help composer-upload-status" role="status">
            <span>正在上传 {uploadLabel}…</span>
            <button type="button" className="text-link" onClick={() => uploader.current?.abort()}>
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
          scope={key + ':' + id}
          thinkingLevel={capabilities.includes('thinking_levels') ? thinkingLevel : 'off'}
          changeThinking={(level) => {
            setThinkingLevel(level);
            localStorage.setItem('astral.pi.thinkingLevel', level);
          }}
          thinkingDisabled={working || !capabilities.includes('thinking_levels')}
          insertVoice={(text) =>
            setInput(
              (old) =>
                insertPastedText(
                  old,
                  text,
                  area.current?.selectionStart ?? old.length,
                  area.current?.selectionEnd ?? old.length,
                ).value,
            )
          }
          terminal={terminal}
          attach={() => fileInput.current?.click()}
          attachmentDisabled={
            uploading || staged.length >= 8 || !capabilities.includes('chat_inputs')
          }
          attachmentTitle={
            capabilities.includes('chat_inputs')
              ? `上传图片、PDF或文件。${attachmentSizeMessage}`
              : '请先更新目标电脑的客户端或执行器，再上传附件。'
          }
          commands={() => {
            setCommandsOpen(!commandsOpen);
            area.current?.focus();
          }}
          working={working}
          hasContent={!!input.trim() || !!staged.length}
          stop={() => void stop()}
          sendDisabled={uploading || (!input.trim() && !staged.length)}
          sendAria="发送给电脑Agent"
          sendLabel={active ? (mode === 'steer' && !staged.length ? '立即补充' : '排队') : '发送'}
        />
      </AssistantComposer>
      {settingsContainer &&
        createPortal(
          <AssistantSettings>
            <AssistantMode
              value={access}
              projectName={project.name}
              readOnly={project.readOnly}
              locked={working ? '当前任务和队列结束后可切换模式' : undefined}
              onChange={setAccess}
            />
            <label>
              <input
                type="checkbox"
                checked={execute}
                disabled={working || !project.allowExecute}
                onChange={(e) => setExecute(e.target.checked)}
              />
              允许终端与Agent执行命令
            </label>
            <p className="field-help">
              {project.allowExecute
                ? '命令以目标电脑当前系统用户权限和网络运行；项目目录不是Shell沙箱。'
                : '此项目未在目标电脑授权执行命令，可在目标电脑的本机设置中授权。'}
              服务器Bash联网开关不控制这台电脑。
            </p>
            <label>
              连续发送
              <select
                aria-label="连续发送方式"
                value={mode}
                onChange={(e) => setMode(e.target.value as 'steer' | 'queue')}
              >
                <option value="steer">立即补充</option>
                <option value="queue">下一任务</option>
              </select>
            </label>
            <p className="field-help">
              带新附件的补充会作为下一任务执行，附件不会在文字补充中遗漏。
            </p>
          </AssistantSettings>,
          settingsContainer,
        )}
    </section>
  );
}
