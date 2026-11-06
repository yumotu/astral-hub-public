import {
  Brain,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  FileSearch,
  Globe,
  ListChecks,
  LoaderCircle,
  Terminal,
} from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import type { PiTimelineItem, Settings } from './types';
import { activityTarget, groupActivities, isTodoTool } from '../../shared/pi-activity.mjs';
import { toolLabels } from './ToolLog';
import { useFileWorkbench } from './FileWorkbench';
const MarkdownView = lazy(() => import('./PiMarkdown').then((m) => ({ default: m.PiMarkdown })));
type Activity = Exclude<PiTimelineItem, { kind: 'text' }>;
type Group =
  { kind: 'text'; text: string; key: number } | { kind: 'process'; items: Activity[]; key: number };
function StepIcon({ item, active }: { item: Activity; active: boolean }) {
  if (item.kind === 'thinking') return <Brain size={13} />;
  if (item.status === 'running')
    return active ? <LoaderCircle size={13} className="spin" /> : <CircleAlert size={13} />;
  if (item.status === 'error') return <CircleAlert size={13} />;
  if (isTodoTool(item.name)) return <ListChecks size={13} />;
  if (/web|fetch|search_content/.test(item.name)) return <Globe size={13} />;
  if (item.name === 'bash') return <Terminal size={13} />;
  return <FileSearch size={13} />;
}
function ProcessGroup({ items, active }: { items: Activity[]; active: boolean }) {
  const workbench = useFileWorkbench();
  const [choice, setChoice] = useState<boolean | null>(null);
  const running = active;
  const unconfirmed =
    !active && items.some((item) => item.kind === 'tool' && item.status === 'running');
  const failed =
    unconfirmed || items.some((item) => item.kind === 'tool' && item.status === 'error');
  const tools = items.filter((item) => item.kind === 'tool');
  const current = [...items]
    .reverse()
    .find((item) => item.kind === 'tool' && item.status === 'running');
  const names = tools.map((item) => item.name);
  const label = running
    ? current?.kind === 'tool'
      ? `正在${toolLabels[current.name] || current.name}`
      : '正在思考与处理'
    : unconfirmed
      ? '执行记录待核对'
      : names.some((name) => /web|fetch|search_content/.test(name))
        ? '搜索与阅读资料'
        : names.some(isTodoTool)
          ? tools.length === 1
            ? '更新任务清单'
            : '规划与执行任务'
          : tools.length
            ? '执行与检查'
            : '思考过程';
  const expanded = choice ?? running;
  return (
    <details
      className={`execution-process ${running ? 'is-running' : ''} ${failed ? 'has-error' : ''}`}
      open={expanded}
    >
      <summary
        onClick={(event) => {
          event.preventDefault();
          setChoice(!expanded);
        }}
      >
        {running ? (
          <LoaderCircle size={14} className="spin" />
        ) : failed ? (
          <CircleAlert size={14} />
        ) : (
          <CheckCircle2 size={14} />
        )}
        <span>{label}</span>
        <small>{items.length} 步</small>
        <ChevronDown size={13} className="process-chevron" />
      </summary>
      <div className="process-steps">
        {items.map((item, index) => {
          const target: { label: string; url?: string } =
            item.kind === 'tool'
              ? activityTarget(item)
              : { label: item.text.replace(/\s+/g, ' ').slice(0, 160) };
          return (
            <details
              className={`process-step ${item.kind === 'tool' && item.status === 'error' ? 'has-error' : ''}`}
              key={item.kind === 'tool' ? item.id : index}
            >
              <summary>
                <StepIcon item={item} active={running} />
                <span className="process-step-label">
                  {item.kind === 'thinking' ? '思考' : toolLabels[item.name] || item.name}
                </span>
                {target.url ? (
                  <a
                    className="process-step-target"
                    href={target.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                    onClick={(event) => event.stopPropagation()}
                  >
                    {target.label}
                  </a>
                ) : (
                  <span className="process-step-target" title={target.label}>
                    {target.label}
                  </span>
                )}
                {item.kind === 'tool' && (
                  <span className="sr-only">
                    {item.status === 'running'
                      ? running
                        ? '执行中'
                        : '执行结果未确认'
                      : item.status === 'error'
                        ? '失败'
                        : '完成'}
                  </span>
                )}
                <ChevronDown size={11} className="step-chevron" />
              </summary>
              <div className="process-step-body">
                {item.kind === 'thinking' ? (
                  <pre>{item.text}</pre>
                ) : (
                  <>
                    <span className="process-result-state">
                      {item.status === 'running'
                        ? running
                          ? '执行中'
                          : '执行结果未确认'
                        : item.status === 'error'
                          ? '执行失败'
                          : '执行完成'}
                      {item.exitCode !== undefined ? ` · 退出码 ${item.exitCode}` : ''}
                    </span>
                    {workbench &&
                      item.projectId &&
                      item.path &&
                      ['project_read', 'project_write', 'project_edit'].includes(item.name) && (
                        <button
                          className="text-link"
                          onClick={() =>
                            workbench.openFile({
                              projectId: item.projectId!,
                              path: item.path,
                              ...(item.backupId ? { backupId: item.backupId } : {}),
                            })
                          }
                        >
                          在侧栏打开文件
                        </button>
                      )}
                    {item.arguments && (
                      <>
                        <small>调用参数</small>
                        <pre>{item.arguments}</pre>
                      </>
                    )}
                    {item.output && (
                      <>
                        <small>返回结果</small>
                        <pre>{item.output}</pre>
                      </>
                    )}
                    {!item.output && !item.arguments && (
                      <span className="field-help">
                        {item.status === 'running'
                          ? running
                            ? '等待工具返回…'
                            : '未收到工具结果。'
                          : item.summary || '本条记录未包含详细输出。'}
                      </span>
                    )}
                  </>
                )}
              </div>
            </details>
          );
        })}
      </div>
    </details>
  );
}
export function PiTimeline({
  items,
  showThinking,
  active = false,
}: {
  items: PiTimelineItem[];
  showThinking: boolean;
  active?: boolean;
  settings?: Settings;
  projectId?: string | null;
}) {
  const groups = groupActivities(items, showThinking) as Group[];
  return (
    <div className="pi-timeline">
      {groups.map((group, index) =>
        group.kind === 'text' ? (
          <Suspense key={group.key} fallback={<pre>{group.text}</pre>}>
            <MarkdownView text={group.text} />
          </Suspense>
        ) : (
          <ProcessGroup
            key={group.key}
            items={group.items}
            active={active && index === groups.length - 1}
          />
        ),
      )}
    </div>
  );
}
