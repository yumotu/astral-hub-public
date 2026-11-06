import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type { Settings } from './types';
import type { ToolRun } from './ToolLog';
import { applyPiTimeline } from '../../shared/pi-timeline.mjs';
import { applyRunMetrics, normalizeTodos } from '../../shared/pi-activity.mjs';
import {
  peekAPI,
  setAPICache,
  warmResourceCache,
  invalidateAPI,
  resourceScope,
} from './resource-cache';
export type PiTask = {
  id: string;
  conversationId: string;
  input: string;
  projectId: string | null;
  access: 'read' | 'edit';
  attachments: string[];
  attachmentFiles?: import('./ChatFiles').ChatFile[];
  mode: 'queue' | 'steer';
  parentId: string | null;
  status: string;
  revision: number;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  lastActivityAt?: string;
  metrics?: import('./types').PiMetrics;
  execution?: import('./types').PiExecution;
  output: string;
  thinking: string;
  tools: ToolRun[];
  timeline?: import('./types').PiTimelineItem[];
  phase: string;
  compacting: boolean;
  error?: string;
  diagnostic?: import('./types').PiRuntimeDiagnostic;
  runtimeWarnings?: import('./types').PiRuntimeDiagnostic[];
  context?: unknown;
  uiRequests?: import('./PluginRequests').PluginRequest[];
  schedule?: { jobId: string; jobName: string; scheduledAt: string; timeZone: string };
};
export const taskPending = (t: PiTask) =>
  ['queued', 'running', 'delivering', 'accepted', 'applied', 'stopping'].includes(t.status);
export const taskLabel = (t: PiTask) =>
  ({
    queued: '排队中',
    running: '执行中',
    delivering: '正在送达',
    accepted: '已送达 Pi',
    applied: '已加入当前任务',
    stopping: '正在停止',
    done: '已完成',
    cancelled: '已撤回 / 停止',
    error: '未完成',
    interrupted: '待核对',
  })[t.status] || t.status;
export function reduceTaskEvent(task: PiTask, e: Record<string, unknown>): PiTask {
  task = { ...task, lastActivityAt: new Date().toISOString() };
  if (e.type === 'runtime_warning')
    return {
      ...task,
      runtimeWarnings: [
        ...(task.runtimeWarnings || []),
        e.diagnostic as import('./types').PiRuntimeDiagnostic,
      ].slice(-4),
    };
  if (e.type === 'extension_ui_request')
    return {
      ...task,
      phase: '等待你的回复',
      uiRequests: [
        ...(task.uiRequests || []).filter((r) => r.id !== e.id),
        { ...e, status: 'pending' } as unknown as import('./PluginRequests').PluginRequest,
      ].slice(-20),
    };
  if (e.type === 'extension_ui_resolved')
    return {
      ...task,
      uiRequests: task.uiRequests?.map((r) => (r.id === e.id ? { ...r, status: 'resolved' } : r)),
    };
  if (['response_start', 'tool_start', 'usage'].includes(String(e.type)))
    task = { ...task, metrics: applyRunMetrics(task.metrics, e) };
  if (
    ['text_delta', 'thinking_delta', 'tool_start', 'tool_output', 'tool_end'].includes(
      String(e.type),
    )
  )
    task = { ...task, timeline: applyPiTimeline(task.timeline || [], e) };
  if (e.type === 'text_delta')
    return { ...task, output: (task.output + String(e.delta || '')).slice(-48000), phase: '正在回复' };
  if (e.type === 'thinking_delta')
    return {
      ...task,
      thinking: (task.thinking + String(e.delta || '')).slice(-48000),
      phase: '正在思考',
    };
  if (e.type === 'response_start') return { ...task, phase: '正在回复' };
  if (e.type === 'compaction_start' || e.type === 'compaction_end')
    return { ...task, compacting: e.type === 'compaction_start' };
  if (e.type === 'tool_start')
    return {
      ...task,
      phase: '正在执行工具',
      tools: [
        ...task.tools,
        {
          id: String(e.id),
          name: String(e.name),
          path: String(e.path || ''),
          ...(typeof e.command === 'string' ? { command: e.command } : {}),
          status: 'running' as const,
        },
      ].slice(-100),
    };
  if (e.type === 'tool_output')
    return {
      ...task,
      tools: task.tools.map((t) =>
        t.id === e.id ? { ...t, output: String(e.output || '').slice(-12000) } : t,
      ),
    };
  if (e.type === 'tool_end')
    return {
      ...task,
      phase: '等待模型继续',
      tools: task.tools.map((t) =>
        t.id === e.id
          ? {
              ...t,
              status: e.error ? 'error' : 'done',
              ...(typeof e.output === 'string' ? { output: e.output } : {}),
              ...(typeof e.exitCode === 'number' ? { exitCode: e.exitCode } : {}),
              ...(Array.isArray(e.todos) ? { todos: normalizeTodos(e.todos) || [] } : {}),
              ...(typeof e.todoAction === 'string' ? { todoAction: e.todoAction } : {}),
              ...Object.fromEntries(
                ['projectId', 'backupId', 'sha256', 'summary']
                  .filter((k) => typeof e[k] === 'string')
                  .map((k) => [k, e[k]]),
              ),
              ...Object.fromEntries(
                ['added', 'removed'].filter((k) => typeof e[k] === 'number').map((k) => [k, e[k]]),
              ),
            }
          : t,
      ),
    };
  return task;
}
type TaskStream = {
  tasks: PiTask[];
  connection: 'connecting' | 'connected' | 'reconnecting';
  failure: string;
  reconnect: () => void;
};
const TaskStreamContext = createContext<{ scope: string; stream: TaskStream } | null>(null);
// The app owns one account-scoped stream; changing pages must not restart recovery.
export function PiTasksProvider({
  settings,
  enabled,
  children,
}: {
  settings: Settings;
  enabled: boolean;
  children: ReactNode;
}) {
  const stream = useTaskStream(settings, enabled);
  return createElement(
    TaskStreamContext.Provider,
    { value: { scope: resourceScope(settings), stream } },
    children,
  );
}
export function usePiTasks(settings: Settings, enabled: boolean): TaskStream {
  const shared = useContext(TaskStreamContext);
  const matches = shared?.scope === resourceScope(settings);
  const fallback = useTaskStream(settings, enabled && !matches);
  return matches && enabled ? shared.stream : fallback;
}
function useTaskStream(settings: Settings, enabled: boolean): TaskStream {
  type Snapshot = { tasks: PiTask[]; cursor: number; at: number };
  const [tasks, setTasks] = useState<PiTask[]>(
    () => peekAPI<Snapshot>(settings, '/@task-stream')?.tasks || [],
  );
  const [connection, setConnection] = useState<'connecting' | 'connected' | 'reconnecting'>(
    'connecting',
  );
  const [version, setVersion] = useState(0);
  const [failure, setFailure] = useState('');
  useEffect(() => {
    if (!enabled) {
      setTasks([]);
      return;
    }
    const controller = new AbortController();
    const signal = controller.signal;
    let live = true;
    setTasks(peekAPI<Snapshot>(settings, '/@task-stream')?.tasks || []);
    const remember = (tasks: PiTask[], cursor: number) => {
      const recent = tasks.filter((t) => taskPending(t) || tasks.slice(-60).includes(t));
      setAPICache(settings, '/@task-stream', { tasks: recent, cursor, at: Date.now() });
    };
    async function get(path: string) {
      const r = await fetch(`${settings.url.replace(/\/$/, '')}/api/pi/tasks${path}`, {
        headers: { Authorization: `Bearer ${settings.sessionToken || settings.token}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
        redirect: 'error',
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '无法读取后台任务。');
      return data;
    }
    void (async () => {
      let cursor = 0,
        initialized = false;
      setConnection('connecting');
      await warmResourceCache(settings);
      if (!live) return;
      const cached = peekAPI<Snapshot>(settings, '/@task-stream');
      if (cached) {
        setTasks(cached.tasks);
        if (Date.now() - cached.at < 30000) {
          cursor = cached.cursor;
          initialized = true;
        }
      }
      while (live) {
        try {
          if (!initialized) {
            const snapshot = await get('');
            if (!live) break;
            setTasks(snapshot.tasks);
            cursor = snapshot.cursor;
            remember(snapshot.tasks, cursor);
            initialized = true;
          }
          setConnection('connected');
          setFailure('');
          const result = await get(`/updates?after=${cursor}`);
          if (!live) break;
          const events = result.events.filter((e: { seq: number }) => e.seq > cursor);
          if (
            events.some(
              (e: { event: { type: string; task?: PiTask } }) =>
                e.event.type === 'task' && e.event.task && !taskPending(e.event.task),
            )
          ) {
            invalidateAPI(settings, '/pi/conversations');
            invalidateAPI(settings, '/pi/skills');
          }
          setTasks((current) => {
            const map = new Map(current.map((t) => [t.id, t]));
            for (const item of events) {
              if (item.event.type === 'task') map.set(item.taskId, item.event.task);
              else {
                const task = map.get(item.taskId);
                if (task) map.set(item.taskId, reduceTaskEvent(task, item.event));
              }
            }
            const next = [...map.values()];
            remember(next, result.cursor);
            return next;
          });
          cursor = result.cursor;
        } catch (e) {
          if (!live) break;
          setConnection('reconnecting');
          setFailure((e as Error).message);
          await new Promise((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              signal.removeEventListener('abort', finish);
              resolve(null);
            };
            const timer = setTimeout(finish, 1500);
            signal.addEventListener('abort', finish, { once: true });
          });
        }
      }
    })();
    return () => {
      live = false;
      controller.abort();
    };
  }, [settings.url, settings.sessionToken, settings.token, enabled, version]);
  return { tasks, connection, failure, reconnect: () => setVersion((n) => n + 1) };
}
