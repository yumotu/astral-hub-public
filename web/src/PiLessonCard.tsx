import { useEffect, useState } from 'react';
import { api } from './data';
import type { Settings } from './types';
import type { ToolRun } from './ToolLog';

export function deliveredLessons(tools: ToolRun[]) {
  const ids = new Set<string>();
  for (const tool of tools) {
    if (tool.name !== 'app_functions' || tool.status === 'running') continue;
    let id = tool.lessonId;
    if (!id && tool.output) {
      try {
        const result = JSON.parse(tool.output);
        id = result.learning?.lessonId || result.result?.lesson?.id;
      } catch {}
    }
    if (
      typeof id === 'string' &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
    )
      ids.add(id);
  }
  return [...ids];
}

type Snapshot = { title: string; status: string };
export function PiLessonCard({
  id,
  settings,
  openLesson,
}: {
  id: string;
  settings: Settings;
  openLesson: (id: string) => void;
}) {
  const [lesson, setLesson] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    let live = true,
      busy = false,
      stopped = false,
      attempts = 0,
      nextAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    setLesson(null);
    setError('');
    setPaused(false);
    async function load() {
      clearTimeout(timer);
      if (!live || stopped || busy || document.hidden) return;
      if (Date.now() < nextAt) {
        timer = setTimeout(() => void load(), nextAt - Date.now());
        return;
      }
      busy = true;
      attempts++;
      try {
        const result = await api<{ lesson: Snapshot }>(
          settings,
          '/learning/lessons/' + id,
          undefined,
          undefined,
          false,
          { signal: controller.signal, fresh: true, timeout: 30000 },
        );
        if (!live) return;
        setLesson({ title: result.lesson.title, status: result.lesson.status });
        if (result.lesson.status !== 'generating') stopped = true;
        else if (attempts >= 20) {
          stopped = true;
          setPaused(true);
        } else {
          nextAt = Date.now() + Math.min(30000, 3000 * 2 ** Math.min(attempts - 1, 4));
          timer = setTimeout(() => void load(), nextAt - Date.now());
        }
      } catch (e) {
        if (!live) return;
        stopped = true;
        setLesson(null);
        const failure = e as Error & { status?: number };
        setError(
          failure.status === 403 || failure.status === 404
            ? '课程不可用'
            : '课程读取失败，未自动重试',
        );
      } finally {
        busy = false;
      }
    }
    const visibility = () => {
      clearTimeout(timer);
      if (!document.hidden) void load();
    };
    void load();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [id, settings.url, settings.sessionToken, settings.token]);
  return (
    <section
      className="surface"
      aria-label="本会话课程"
      style={{ overflowWrap: 'anywhere', marginBlock: 12 }}
    >
      <strong>{lesson?.title || '学习课程'}</strong>
      <p role="status">
        {error ||
          (lesson
            ? lesson.status === 'ready'
              ? '可查看'
              : lesson.status === 'generating'
                ? '生成中，未完成'
                : '生成失败，未自动重试'
            : '正在核对课程状态…')}
        {paused ? ' · 已停止自动查询，可进入学习页核对' : ''}
      </p>
      {lesson && (
        <button className="text-link" onClick={() => openLesson(id)}>
          在学习页打开此课程
        </button>
      )}
    </section>
  );
}
