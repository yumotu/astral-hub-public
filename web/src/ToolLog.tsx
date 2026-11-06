import { useState } from 'react';
import { Check, FileText, RotateCcw, Terminal } from 'lucide-react';
import { api } from './data';
import { useFileWorkbench } from './FileWorkbench';
import type { Settings, TodoItem } from './types';
export type ToolRun = {
  id: string;
  name: string;
  projectId?: string;
  path: string;
  status: 'running' | 'done' | 'error';
  summary?: string;
  backupId?: string;
  sha256?: string;
  bytes?: number;
  added?: number;
  removed?: number;
  command?: string;
  output?: string;
  exitCode?: number;
  arguments?: string;
  todos?: TodoItem[];
  todoAction?: string;
};
export const toolLabels: Record<string, string> = {
  bash: 'Bash 命令',
  host_command: '宿主命令授权',
  notify: '通知设备',
  read: '读取技能',
  skill_list: '查找技能',
  skill_create: '创建技能',
  skill_install: '导入项目技能',
  skill_manage: '管理技能',
  project_list: '浏览目录',
  project_read: '读取文件',
  project_search: '搜索项目',
  project_write: '写入文件',
  project_edit: '修改文件',
  project_workspaces: '项目文件夹',
  computer_info: '电脑环境',
  computer_exec: '电脑命令',
  project_stat: '文件信息',
  project_tree: '项目目录树',
  project_read_many: '批量读取',
  project_mkdir: '新建目录',
  project_diff: '查看修改',
  project_restore: '恢复修改',
  package_manage: '管理 Pi 插件',
  chat_files: '对话附件',
  chat_read: '读取附件',
  chat_export: '发送文件',
  web_search: '联网搜索',
  fetch_content: '读取网页',
  get_search_content: '查询网页内容',
  web_fetch: '读取网页',
  todo: '任务清单',
  todo_write: '更新任务清单',
  TodoWrite: '更新任务清单',
  update_plan: '更新计划',
};
export function ToolLog({
  tools,
  settings,
  projectId,
}: {
  tools: ToolRun[];
  settings?: Settings;
  projectId?: string | null;
}) {
  const workbench = useFileWorkbench();
  const [restored, setRestored] = useState<string[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState('');
  if (!tools?.length) return null;
  return (
    <>
      <details className="tool-log">
        <summary>执行记录 · {tools.length}</summary>
        {tools.map((t) => (
          <div className="tool-row" key={t.id}>
            {t.name === 'bash' ? <Terminal size={14} /> : <FileText size={14} />}
            <span>
              <b>
                {toolLabels[t.name] || (t.name.startsWith('custom_') ? '电脑插件' : t.name)}
                {t.name !== 'bash' && t.path !== '.' ? ` · ${t.path}` : ''}
              </b>
              <small>
                {t.status === 'error' ? '失败' : t.status === 'running' ? '执行中' : '已完成'}
                {t.summary ? ' · ' + t.summary : ''}
                {t.exitCode !== undefined ? ` · 退出码 ${t.exitCode}` : ''}
              </small>
              {workbench &&
                (t.projectId || projectId) &&
                ['project_read', 'project_edit', 'project_write'].includes(t.name) &&
                t.path && (
                  <button
                    className="text-link"
                    onClick={() =>
                      workbench.openFile({
                        projectId: (t.projectId || projectId)!,
                        path: t.path,
                        ...(t.backupId ? { backupId: t.backupId } : {}),
                      })
                    }
                  >
                    在侧栏打开文件
                  </button>
                )}
              {t.name === 'bash' && (
                <details className="bash-output" open={t.status === 'running' || undefined}>
                  <summary>命令与输出</summary>
                  <pre className="bash-command">
                    <code>$ {t.command}</code>
                  </pre>
                  {t.output && (
                    <pre className="bash-terminal" aria-label="命令输出">
                      {t.output}
                    </pre>
                  )}
                </details>
              )}
              {t.name !== 'bash' && (t.arguments || t.output) && (
                <details className="tool-output">
                  <summary>查看详情</summary>
                  {t.arguments && <pre>{t.arguments}</pre>}
                  {t.output && <pre>{t.output}</pre>}
                </details>
              )}
            </span>
            {t.backupId && projectId && settings && (
              <button
                className="text-link"
                disabled={!!busy || restored.includes(t.backupId)}
                onClick={() => {
                  setBusy(t.backupId!);
                  setError('');
                  void api(settings, `/pi/projects/${t.projectId || projectId}/restore`, {
                    backupId: t.backupId,
                  })
                    .then(() => setRestored((x) => [...x, t.backupId!]))
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(''));
                }}
              >
                {restored.includes(t.backupId) ? <Check size={14} /> : <RotateCcw size={14} />}{' '}
                {restored.includes(t.backupId) ? '已恢复' : '恢复此修改'}
              </button>
            )}
          </div>
        ))}
        {error && <p className="error">{error}</p>}
      </details>
    </>
  );
}
