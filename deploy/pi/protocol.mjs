import { redact } from './project-files.mjs';
const isTodo = (name) =>
  ['todo', 'todos', 'todowrite', 'todo_write', 'update_plan'].includes(String(name).toLowerCase());
export function todoResultFields(name, result) {
  if (!isTodo(name)) return {};
  const details = result?.details;
  if (details?.error || !Array.isArray(details?.todos ?? details?.plan)) return {};
  const todos = (details.todos ?? details.plan).slice(0, 100).flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const text = item.text ?? item.content ?? item.step;
    const states = {
      pending: 'pending',
      in_progress: 'running',
      running: 'running',
      completed: 'done',
      done: 'done',
      cancelled: 'cancelled',
    };
    const status =
      (Object.hasOwn(states, item.status) ? states[item.status] : null) ||
      (typeof item.done === 'boolean' ? (item.done ? 'done' : 'pending') : null);
    return typeof text === 'string' && status
      ? [
          {
            id: String(item.id ?? index + 1).slice(0, 160),
            text: redact(text).slice(0, 2000),
            status,
          },
        ]
      : [];
  });
  if ((details.todos ?? details.plan).length && !todos.length) return {};
  return {
    todos,
    ...(typeof details.action === 'string' ? { todoAction: details.action.slice(0, 30) } : {}),
  };
}
export function usageEvent(usage, responseMs) {
  const values = Object.fromEntries(
    ['input', 'output', 'cacheRead', 'cacheWrite']
      .filter(
        (key) =>
          typeof usage?.[key] === 'number' &&
          Number.isFinite(usage[key]) &&
          usage[key] >= 0 &&
          usage[key] <= 1e12,
      )
      .map((key) => [key, usage[key]]),
  );
  if (!Object.keys(values).length) return null;
  return {
    type: 'usage',
    usage: values,
    ...(Number.isFinite(responseMs) && responseMs >= 0
      ? { responseMs: Math.round(responseMs) }
      : {}),
  };
}
export const toolOutput = (result) => {
  const text = redact(
    (result?.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n'),
  );
  return text.length > 12000 ? '[输出已截断，以下为末尾内容]\n' + text.slice(-11980) : text;
};
export const toolPath = (e) =>
  typeof e.args?.path === 'string'
    ? e.args.path.slice(0, 500)
    : ['skill_create', 'skill_manage'].includes(e.toolName)
      ? `${e.args?.name || ''}/SKILL.md`
      : '.';
export const projectToolNames = [
  'bash',
  'sandbox_network_status',
  'read',
  'skill_list',
  'skill_create',
  'skill_install',
  'skill_manage',
  'project_list',
  'project_read',
  'project_search',
  'project_write',
  'project_edit',
  'project_workspaces',
  'chat_files',
  'chat_read',
  'chat_export',
  'web_search',
  'fetch_content',
  'get_search_content',
];
export function createCollector({ projectMode = false, maxBytes = 4 * 1024 * 1024 } = {}) {
  let pending = '',
    output = '',
    failure = false,
    stopReason,
    errorMessage;
  const tools = [],
    byId = new Map();
  const exports = [];
  function event(e) {
    if (e.type === 'message_end' && e.message?.role === 'assistant') {
      stopReason = e.message.stopReason;
      failure = ['error', 'aborted', 'length'].includes(stopReason);
      errorMessage =
        typeof e.message.errorMessage === 'string'
          ? redact(e.message.errorMessage).slice(0, 8000)
          : undefined;
      const text = (e.message.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      if (text) output = text.slice(0, 48000);
    }
    if (!projectMode) return;
    if (
      e.type === 'tool_execution_start' &&
      typeof e.toolName === 'string' &&
      /^[A-Za-z0-9_.:-]{1,128}$/.test(e.toolName) &&
      tools.length < 100
    ) {
      const tool = {
        id: String(e.toolCallId).slice(0, 200),
        name: e.toolName,
        path: toolPath(e),
        ...(isTodo(e.toolName)
          ? { arguments: redact(JSON.stringify(e.args || {})).slice(0, 12000) }
          : {}),
        ...(['bash', 'host_command'].includes(e.toolName)
          ? { command: String(e.args?.command || '').slice(0, 8000) }
          : {}),
        status: 'running',
      };
      tools.push(tool);
      byId.set(e.toolCallId, tool);
    }
    if (e.type === 'tool_execution_end') {
      const tool = byId.get(e.toolCallId);
      if (!tool) return;
      tool.status = e.isError ? 'error' : 'done';
      if (isTodo(tool.name)) tool.output = toolOutput(e.result);
      Object.assign(tool, todoResultFields(tool.name, e.result));
      const details = e.result?.details || {};
      if (['bash', 'host_command'].includes(tool.name)) {
        tool.output = toolOutput(e.result);
        if (tool.name === 'host_command' && Number.isInteger(details.exitCode))
          tool.exitCode = details.exitCode;
        if (Number.isInteger(e.result?.structuredContent?.exit_code))
          tool.exitCode = e.result.structuredContent.exit_code;
        tool.summary = e.isError ? '命令未成功完成' : '命令执行完成';
        return;
      }
      if (!e.isError && details.export && exports.length < 8) exports.push(details.export);
      if (typeof details.projectId === 'string') tool.projectId = details.projectId;
      if (typeof details.backupId === 'string') tool.backupId = details.backupId;
      if (typeof details.sha256 === 'string') tool.sha256 = details.sha256;
      if (typeof details.bytes === 'number') tool.bytes = details.bytes;
      if (Number.isInteger(details.added)) tool.added = details.added;
      if (Number.isInteger(details.removed)) tool.removed = details.removed;
      if (e.isError)
        tool.summary = (e.result?.content || [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n')
          .slice(0, 500);
      else
        tool.summary =
          e.toolName === 'package_manage'
            ? String(details.summary || '已管理 Pi 插件').slice(0, 200)
            : ['read', 'skill_list'].includes(e.toolName)
              ? '已读取技能资料'
              : e.toolName === 'skill_manage'
                ? String(details.summary || '已管理技能').slice(0, 200)
                : e.toolName === 'skill_install'
                  ? `${details.installedCount ?? 0} 个技能已导入`
                  : e.toolName === 'skill_create'
                    ? '技能已保存并启用'
                    : e.toolName === 'project_read'
                      ? `读取 ${details.totalLines ?? '?'} 行文件`
                      : e.toolName === 'project_search'
                        ? '已搜索项目'
                        : e.toolName === 'project_list'
                          ? '已列出目录'
                          : ['web_search', 'fetch_content', 'get_search_content'].includes(
                                e.toolName,
                              )
                            ? '已获取网络资料'
                            : ['chat_files', 'chat_read', 'project_workspaces'].includes(e.toolName)
                              ? '已读取资料'
                              : e.toolName === 'chat_export'
                                ? '已生成下载附件'
                                : typeof details.bytes === 'number'
                                  ? `已修改 ${details.bytes} 字节`
                                  : '工具执行完成';
    }
  }
  return {
    push(text) {
      pending += text;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        if (Buffer.byteLength(line) > maxBytes) throw new Error('Pi 单条输出过多');
        if (line) {
          try {
            event(JSON.parse(line));
          } catch {
            throw new Error('Pi 输出格式错误');
          }
        }
      }
      if (Buffer.byteLength(pending) > maxBytes) throw new Error('Pi 单条输出过多');
    },
    result() {
      if (pending.trim()) {
        try {
          event(JSON.parse(pending));
        } catch {
          throw new Error('Pi 输出格式错误');
        }
        pending = '';
      }
      return {
        output,
        tools,
        exports,
        failed: failure,
        ...(stopReason ? { stopReason } : {}),
        ...(errorMessage ? { errorMessage } : {}),
      };
    },
  };
}
