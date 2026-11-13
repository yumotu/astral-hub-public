import { lazy, Suspense, useEffect, useState } from 'react';
import { api } from './data';
import type { Settings, PiTurn } from './types';
import { AssistantUserMessage } from './AssistantUserMessage';
import { ChatFiles, type ChatFile } from './ChatFiles';
import { ToolLog, type ToolRun } from './ToolLog';
import { PiTimeline } from './PiTimeline';
import { RunMetrics, RunSummary } from './ExecutionInfo';
import { CopyButton } from './CopyButton';
import type { NativeConversationRef } from './UnifiedConversations';
const Reply = lazy(() => import('./PiMarkdown').then((m) => ({ default: m.AssistantReply })));
type HistoryMessage = {
  id: string;
  role: string;
  text: string;
  time?: number;
  thinking?: string;
  rpcId?: string;
};
type HistoryJob = {
  id: string;
  input: string;
  output: string;
  createdAt: string;
  parentId?: string | null;
  tools: ToolRun[];
  attachments?: ChatFile[];
  artifacts?: ChatFile[];
  metrics?: import('./types').PiMetrics;
  status?: string;
  phase?: string;
  error?: string;
};
export function NativeSegmentHistory({
  settings,
  segment,
}: {
  settings: Settings;
  segment: NativeConversationRef;
}) {
  const [data, setData] = useState<{
    turns?: PiTurn[];
    jobs?: HistoryJob[];
    conversation?: {
      messages: HistoryMessage[];
      tools: ToolRun[];
      artifacts?: { file: ChatFile }[];
      inputs?: Record<string, ChatFile[]>;
      hasMore?: boolean;
      status?: string;
      phase?: string;
      error?: string;
      connection?: 'connected' | 'reconnecting';
    };
    next?: string | null;
  } | null>(null);
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [more, setMore] = useState(false);
  const path =
    segment.origin === 'server'
      ? `/pi/conversations/${segment.nativeId}`
      : segment.origin === 'computer'
        ? `/relay/conversations/${segment.nativeId}`
        : `/agent/remote/conversations/${segment.nativeId}`;
  async function load(older = false) {
    setBusy(true);
    setError('');
    try {
      const before = segment.origin === 'server' ? data?.turns?.[0]?.seq : data?.next;
      const d = await api<NonNullable<typeof data>>(
        settings,
        path +
          (older && segment.origin === 'remote'
            ? '/history'
            : older && before
              ? `?before=${before}`
              : ''),
        older && segment.origin === 'remote' ? {} : undefined,
        older && segment.origin === 'remote' ? 'POST' : undefined,
        false,
        { fresh: true },
      );
      setData((old) =>
        older && old && segment.origin !== 'remote'
          ? {
              ...d,
              turns: d.turns ? [...d.turns, ...(old.turns || [])] : undefined,
              jobs: d.jobs ? [...d.jobs, ...(old.jobs || [])] : undefined,
            }
          : d,
      );
      setMore(
        segment.origin === 'server'
          ? (d.turns?.length || 0) >= 50
          : segment.origin === 'computer'
            ? !!d.next
            : !!d.conversation?.hasMore,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    let active = true;
    setData(null);
    setError('');
    setBusy(true);
    void api<NonNullable<typeof data>>(settings, path, undefined, undefined, false, { fresh: true })
      .then((d) => {
        if (active) {
          setData(d);
          setMore(
            segment.origin === 'server'
              ? (d.turns?.length || 0) >= 50
              : segment.origin === 'computer'
                ? !!d.next
                : !!d.conversation?.hasMore,
          );
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [settings, path]);
  return (
    <section className="conversation-segment-history" aria-label="切换前的对话记录">
      <p className="conversation-segment-label">
        {segment.runtime.backend === 'dsh' ? 'DeepSeek Harness' : 'Pi'} ·{' '}
        {segment.runtime.location === 'server' ? '服务器' : '电脑'} · 切换前的记录
      </p>
      {busy && !data && <p role="status">正在读取原引擎记录…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
          <button className="text-link" onClick={() => void load()}>
            重试读取
          </button>
        </p>
      )}
      {more && (
        <button className="text-link" disabled={busy} onClick={() => void load(true)}>
          加载这段更早记录
        </button>
      )}
      {data?.turns?.map((t) => (
        <article className="pi-turn" key={t.id}>
          <AssistantUserMessage
            input={t.input}
            at={t.createdAt}
            files={t.attachments || []}
            settings={settings}
            conversation={segment.nativeId}
          />
          {t.supplements?.map((s) => (
            <AssistantUserMessage
              key={s.id}
              input={s.input}
              at=""
              files={s.attachments || []}
              settings={settings}
              conversation={segment.nativeId}
            />
          ))}
          <div className="message assistant">
            <RunSummary execution={t.execution} />
            {t.timeline?.length ? (
              <PiTimeline
                items={t.timeline}
                showThinking={false}
                active={false}
                settings={settings}
                projectId={t.projectId}
              />
            ) : (
              <Suspense fallback={<pre>{t.output}</pre>}>
                <Reply text={t.output} />
              </Suspense>
            )}
            {!t.timeline?.length && (
              <ToolLog tools={t.tools || []} settings={settings} projectId={t.projectId} />
            )}
            <ChatFiles
              files={t.artifacts || []}
              settings={settings}
              conversation={segment.nativeId}
            />
            <RunMetrics metrics={t.execution?.metrics} />
            <CopyButton text={t.output} assistant />
          </div>
        </article>
      ))}
      {data?.jobs
        ?.filter((j) => !j.parentId)
        .map((j) => (
          <article className="pi-turn" key={j.id}>
            <AssistantUserMessage
              input={j.input}
              at={j.createdAt}
              files={j.attachments || []}
              settings={settings}
              conversation={segment.nativeId}
            />
            {data.jobs
              ?.filter((child) => child.parentId === j.id)
              .map((child) => (
                <AssistantUserMessage
                  key={child.id}
                  input={child.input}
                  at={child.createdAt}
                  files={child.attachments || []}
                  settings={settings}
                  conversation={segment.nativeId}
                />
              ))}
            <div className="message assistant">
              <RunSummary status={j.status} phase={j.phase} />
              <Suspense fallback={<pre>{j.output}</pre>}>
                <Reply text={j.output} />
              </Suspense>
              <ToolLog tools={j.tools || []} />
              {j.error && (
                <p className="error" role="alert">
                  {j.error}
                </p>
              )}
              <ChatFiles
                files={j.artifacts || []}
                settings={settings}
                conversation={segment.nativeId}
              />
              <RunMetrics metrics={j.metrics} />
              <CopyButton text={j.output} assistant />
            </div>
          </article>
        ))}
      {segment.origin === 'remote' &&
        data?.conversation?.messages?.map((m) =>
          m.role === 'user' ? (
            <AssistantUserMessage
              key={m.id}
              input={m.text}
              at={m.time ? new Date(m.time).toISOString() : ''}
              settings={settings}
              conversation={segment.nativeId}
              files={data.conversation?.inputs?.[m.rpcId || ''] || []}
            />
          ) : (
            <div className="message assistant" key={m.id}>
              <Suspense fallback={<pre>{m.text}</pre>}>
                <Reply text={m.text} />
              </Suspense>
              <CopyButton text={m.text} assistant />
            </div>
          ),
        )}
      {segment.origin === 'remote' && data?.conversation && (
        <>
          <ToolLog
            tools={(data.conversation.tools || []).map((t) => ({
              ...t,
              path: '.',
              command: t.name === 'bash' ? t.arguments : undefined,
            }))}
          />
          <ChatFiles
            files={(data.conversation.artifacts || []).map((a) => a.file)}
            settings={settings}
            conversation={segment.nativeId}
          />
          <RunSummary
            backend="dsh"
            status={data.conversation.status}
            phase={data.conversation.phase}
            connection={data.conversation.connection}
          />
          {data.conversation.error && (
            <p className="error" role="alert">
              {data.conversation.error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
