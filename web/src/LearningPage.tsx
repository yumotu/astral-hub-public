import { useEffect, useId, useRef, useState } from 'react';
import { BookOpen, CheckCircle2, GraduationCap, LoaderCircle, RefreshCw } from 'lucide-react';
import { api, dateLabel } from './data';
import { serverIdentity } from './session';
import { peekAPI, setAPICache } from './resource-cache';
import { PiMarkdown } from './PiMarkdown';
import { useBackLayer } from './back-navigation';
import type { AuthSession, Settings } from './types';
import './learning.css';

type Question = { id: string; kind: 'choice' | 'short'; prompt: string; options?: string[] };
type Answer = { choiceIndex: number } | { text: string };
type Attempt = {
  id: string;
  lessonId: string;
  questionId: string;
  answer: Answer;
  score: number;
  feedback: string;
  passed: boolean;
  method: 'exact' | 'ai';
  correctIndex?: number;
  referenceAnswer?: string;
  rubric?: string[];
  explanation: string;
  createdAt: string;
};
type Lesson = {
  id: string;
  topic: string;
  title: string;
  level: string;
  status: string;
  createdAt: string;
  error?: string;
  progress?: { stage: string; completed: number; total: number };
  explanation?: string;
  questions?: Question[];
  attempts?: Attempt[];
};
type Wrong = {
  lessonId: string;
  questionId: string;
  title: string;
  question: Question;
  lastAttempt: Attempt;
  wrongCount: number;
  reviewCount: number;
  resolved: boolean;
  updatedAt: string;
};

function Exercise({
  question,
  latest,
  onGrade,
  draftKey,
}: {
  question: Question;
  latest?: Attempt;
  onGrade: (answer: Answer, id: string) => Promise<Attempt>;
  draftKey: string;
}) {
  const [draft] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(draftKey) || '{}');
    } catch {
      return {};
    }
  });
  const [choice, setChoice] = useState<number | null>(draft.choice ?? null),
    [text, setText] = useState<string>(draft.text || ''),
    [result, setResult] = useState(latest),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const attempt = useRef<{ signature: string; id: string } | null>(draft.attempt || null),
    group = useId();
  useEffect(() => {
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({ choice, text, attempt: attempt.current }));
    } catch {}
  }, [draftKey, choice, text]);
  const answer: Answer = question.kind === 'choice' ? { choiceIndex: choice ?? -1 } : { text };
  const valid = question.kind === 'choice' ? choice !== null : !!text.trim();
  async function submit() {
    const signature = JSON.stringify(answer);
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, id: crypto.randomUUID() };
    try {
      sessionStorage.setItem(draftKey, JSON.stringify({ choice, text, attempt: attempt.current }));
    } catch {}
    setBusy(true);
    setError('');
    try {
      setResult(await onGrade(answer, attempt.current!.id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className="learning-exercise surface" aria-label={question.prompt}>
      <span className="tag">{question.kind === 'choice' ? '单项选择' : '问答题'}</span>
      <h3>{question.prompt}</h3>
      {question.kind === 'choice' ? (
        <fieldset disabled={busy} className="learning-options">
          <legend className="sr-only">选择一个答案</legend>
          {question.options?.map((option, i) => (
            <label key={i}>
              <input
                type="radio"
                name={group}
                checked={choice === i}
                onChange={() => setChoice(i)}
              />
              <span>
                {String.fromCharCode(65 + i)}. {option}
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <label className="field-label">
          你的回答
          <textarea
            aria-label="你的回答"
            className="standard-input"
            rows={3}
            maxLength={6000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={busy}
            placeholder="用自己的话解释，也可以举例说明。"
          />
        </label>
      )}
      <div className="action-row">
        <button className="primary" disabled={busy || !valid} onClick={() => void submit()}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <CheckCircle2 size={16} />}{' '}
          {busy ? '正在判题' : '提交答案'}
        </button>
        {(result || error) && (
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              setResult(undefined);
              setError('');
              setChoice(null);
              setText('');
              attempt.current = null;
            }}
          >
            重新作答
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="error">
          {error} 如需重新生成判题请求，请先点“重新作答”。
        </p>
      )}
      {result && (
        <section
          className={`learning-feedback ${result.passed ? 'passed' : ''}`}
          aria-label="判题结果"
        >
          <strong>
            {result.score} / 100 · {result.passed ? '已掌握' : '加入错题本'}
          </strong>
          <p>{result.feedback}</p>
          <details>
            <summary>答案与解析</summary>
            {result.correctIndex !== undefined && (
              <p>
                正确选项：{String.fromCharCode(65 + result.correctIndex)}.{' '}
                {question.options?.[result.correctIndex]}
              </p>
            )}
            {result.referenceAnswer && <PiMarkdown text={result.referenceAnswer} />}
            <PiMarkdown text={result.explanation} />
            {result.rubric && (
              <ul>
                {result.rubric.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            )}
          </details>
          {result.method === 'ai' && (
            <small>AI按评分要点批改，80分起视为掌握；请结合解析核对。</small>
          )}
        </section>
      )}
    </article>
  );
}

export function LearningPage({
  settings,
  session,
  login,
}: {
  settings: Settings;
  session: AuthSession | null;
  login: () => void;
}) {
  const viewKey =
    'astral.learning.view:' +
    JSON.stringify([serverIdentity(settings), session?.user.id || 'guest']);
  const [saved] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(viewKey) || '{}');
    } catch {
      return {};
    }
  });
  const [topic, setTopic] = useState<string>(saved.topic || ''),
    [level, setLevel] = useState<string>(saved.level || 'beginner'),
    [choiceCount, setChoiceCount] = useState<string>(String(saved.choiceCount ?? 2)),
    [shortCount, setShortCount] = useState<string>(String(saved.shortCount ?? 1)),
    [tab, setTab] = useState<'learn' | 'wrong'>(saved.tab === 'wrong' ? 'wrong' : 'learn'),
    [selected, setSelected] = useState<string>(saved.selected || '');
  const [lessons, setLessons] = useState<Lesson[]>(
      () => peekAPI<{ lessons: Lesson[] }>(settings, '/learning/lessons')?.lessons || [],
    ),
    [lesson, setLesson] = useState<Lesson | null>(
      () =>
        peekAPI<{ lesson: Lesson }>(settings, '/learning/lessons/' + (saved.selected || ''))
          ?.lesson || null,
    ),
    [wrong, setWrong] = useState<Wrong[]>(
      () => peekAPI<{ items: Wrong[] }>(settings, '/learning/wrong')?.items || [],
    ),
    [resolved, setResolved] = useState(false),
    [busy, setBusy] = useState(''),
    [error, setError] = useState('');
  const [lessonsNext, setLessonsNext] = useState<string | null>(null),
    [wrongNext, setWrongNext] = useState<string | null>(null),
    [moreBusy, setMoreBusy] = useState(false);
  const [maximum, setMaximum] = useState(40),
    [maximumDraft, setMaximumDraft] = useState('40');
  const total = Number(choiceCount) + Number(shortCount);
  const validCounts =
    [choiceCount, shortCount].every(
      (n) => n.trim() !== '' && Number.isSafeInteger(Number(n)) && Number(n) >= 0,
    ) &&
    total >= 1 &&
    total <= maximum;
  const alive = useRef(true),
    refreshVersion = useRef(0),
    currentFilter = useRef(resolved),
    selection = useRef(selected),
    generation = useRef<{ signature: string; id: string } | null>(null);
  selection.current = selected;
  currentFilter.current = resolved;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(
        viewKey,
        JSON.stringify({ topic, level, choiceCount, shortCount, tab, selected }),
      );
    } catch {}
  }, [viewKey, topic, level, choiceCount, shortCount, tab, selected]);
  useEffect(() => {
    let live = true;
    if (session)
      void api<{ maxQuestions: number }>(settings, '/learning/settings')
        .then((r) => {
          if (live) {
            setMaximum(r.maxQuestions);
            setMaximumDraft(String(r.maxQuestions));
          }
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
    return () => {
      live = false;
    };
  }, [settings, session]);
  async function saveMaximum() {
    setBusy('settings');
    setError('');
    try {
      const r = await api<{ maxQuestions: number }>(
        settings,
        '/learning/settings',
        { maxQuestions: Number(maximumDraft) },
        'PUT',
      );
      if (alive.current) {
        setMaximum(r.maxQuestions);
        setMaximumDraft(String(r.maxQuestions));
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy('');
    }
  }
  useBackLayer(
    !!selected || tab === 'wrong',
    () => {
      if (selected) {
        setSelected('');
        setLesson(null);
      } else setTab('learn');
    },
    30,
  );
  async function refresh() {
    const version = ++refreshVersion.current;
    const [l, w] = await Promise.all([
      api<{ lessons: Lesson[]; next?: string | null }>(settings, '/learning/lessons'),
      api<{ items: Wrong[]; next?: string | null }>(
        settings,
        '/learning/wrong' + (resolved ? '?resolved=include' : ''),
      ),
    ]);
    if (alive.current && version === refreshVersion.current) {
      setLessons(l.lessons);
      setWrong(w.items);
      setLessonsNext(l.next || null);
      setWrongNext(w.next || null);
    }
  }
  async function older(kind: 'lessons' | 'wrong') {
    const version = refreshVersion.current,
      filter = resolved;
    const cursor = kind === 'lessons' ? lessonsNext : wrongNext;
    if (!cursor || moreBusy) return;
    setMoreBusy(true);
    setError('');
    try {
      const query = new URLSearchParams({ before: cursor });
      if (kind === 'wrong' && resolved) query.set('resolved', 'include');
      const r = await api<{ lessons?: Lesson[]; items?: Wrong[]; next: string | null }>(
        settings,
        `/learning/${kind}?${query}`,
      );
      if (
        alive.current &&
        version === refreshVersion.current &&
        (kind === 'lessons' || filter === currentFilter.current)
      ) {
        if (kind === 'lessons') {
          setLessons((old) => [
            ...new Map([...old, ...(r.lessons || [])].map((l) => [l.id, l])).values(),
          ]);
          setLessonsNext(r.next);
        } else {
          setWrong((old) => [
            ...new Map(
              [...old, ...(r.items || [])].map((w) => [w.lessonId + w.questionId, w]),
            ).values(),
          ]);
          setWrongNext(r.next);
        }
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setMoreBusy(false);
    }
  }
  useEffect(() => {
    if (session)
      void refresh().catch((e) => {
        if (alive.current) setError(e.message);
      });
  }, [settings, session, resolved]);
  useEffect(() => {
    if (!selected || !session) return;
    let live = true;
    const cached = peekAPI<{ lesson: Lesson }>(settings, '/learning/lessons/' + selected);
    setLesson(cached?.lesson || null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load(fresh = false) {
      try {
        const r = await api<{ lesson: Lesson }>(
          settings,
          '/learning/lessons/' + selected,
          undefined,
          undefined,
          false,
          { fresh },
        );
        if (!live) return;
        setLesson(r.lesson);
        setLessons((old) =>
          old.map((l) =>
            l.id === selected
              ? {
                  ...l,
                  ...r.lesson,
                  questions: undefined,
                  explanation: undefined,
                  attempts: undefined,
                }
              : l,
          ),
        );
        if (r.lesson.status === 'generating') timer = setTimeout(() => void load(true), 3000);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    }
    void load(cached?.lesson.status === 'generating');
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [settings, session, selected]);
  async function generate() {
    if (!validCounts) {
      setError('请填写有效题量，总数须在1至' + maximum + '之间。');
      return;
    }
    const payload = {
      topic: topic.trim(),
      level,
      choiceCount: Number(choiceCount),
      shortCount: Number(shortCount),
      background: true,
    };
    const signature = JSON.stringify(payload);
    if (generation.current?.signature !== signature)
      generation.current = { signature, id: crypto.randomUUID() };
    setBusy('generate');
    setError('');
    try {
      const r = await api<{ lesson: Lesson }>(
        settings,
        '/learning/lessons',
        {
          ...payload,
          id: generation.current!.id,
        },
        undefined,
        false,
        { timeout: 210000 },
      );
      setAPICache(settings, '/learning/lessons/' + r.lesson.id, r);
      if (alive.current) {
        setSelected(r.lesson.id);
        setLesson(r.lesson);
        await refresh();
      }
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setBusy('');
    }
  }
  async function grade(lessonId: string, questionId: string, answer: Answer, id: string) {
    const r = await api<{ attempt: Attempt }>(
      settings,
      '/learning/attempts',
      {
        id,
        lessonId,
        questionId,
        answer,
      },
      undefined,
      false,
      { timeout: 210000 },
    );
    void api<{ lesson: Lesson }>(settings, '/learning/lessons/' + lessonId)
      .then((current) => {
        if (alive.current && selection.current === lessonId) setLesson(current.lesson);
      })
      .catch((e) => {
        if (alive.current) setError(e.message);
      });
    await refresh().catch((e) => {
      if (alive.current) setError(e.message);
    });
    return r.attempt;
  }
  if (!session)
    return (
      <section className="surface">
        <h1>学习</h1>
        <p>登录后保存课程、答题记录和错题本，在各台设备接着学习。</p>
        <button className="primary" onClick={login}>
          登录并开始学习
        </button>
      </section>
    );
  return (
    <div className="learning-page">
      <div className="page-heading compact">
        <div className="section-title">
          <GraduationCap size={24} />
          <h1>学习</h1>
        </div>
        <p>把知识讲明白，练习后再检查哪里需要巩固。</p>
      </div>
      <nav className="learning-tabs" aria-label="学习功能">
        <button
          className={tab === 'learn' ? 'primary' : 'secondary'}
          onClick={() => setTab('learn')}
        >
          <BookOpen size={16} /> 学习与练习
        </button>
        <button
          className={tab === 'wrong' ? 'primary' : 'secondary'}
          onClick={() => {
            setSelected('');
            setLesson(null);
            setTab('wrong');
          }}
        >
          错题本
        </button>
        <button
          className="icon-btn"
          aria-label="刷新学习记录"
          onClick={() => void refresh().catch((e) => setError(e.message))}
        >
          <RefreshCw size={16} />
        </button>
      </nav>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {tab === 'learn' ? (
        <>
          <form
            className="surface learning-form"
            onSubmit={(e) => {
              e.preventDefault();
              void generate();
            }}
          >
            <label className="field-label">
              想学习的知识点
              <textarea
                aria-label="想学习的知识点"
                className="standard-input"
                rows={2}
                maxLength={2000}
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="例如：Python装饰器、哈希表冲突处理、英语虚拟语气"
                required
                minLength={2}
              />
            </label>
            <div className="learning-form-options">
              <label className="field-label">
                程度
                <select
                  className="standard-input"
                  value={level}
                  onChange={(e) => setLevel(e.target.value)}
                >
                  <option value="beginner">从基础开始</option>
                  <option value="intermediate">进阶理解</option>
                  <option value="advanced">深入应用</option>
                </select>
              </label>
              <label className="field-label">
                选择题数量
                <input
                  aria-label="选择题数量"
                  className="standard-input"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={maximum}
                  step={1}
                  required
                  value={choiceCount}
                  onChange={(e) => setChoiceCount(e.target.value)}
                />
              </label>
              <label className="field-label">
                问答题数量
                <input
                  aria-label="问答题数量"
                  className="standard-input"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={maximum}
                  step={1}
                  required
                  value={shortCount}
                  onChange={(e) => setShortCount(e.target.value)}
                />
              </label>
            </div>
            <p className="field-help">
              共{Number.isFinite(total) ? total : 0}题，上限{maximum}
              题。两类题可任意分配。先生成完整讲解，再每批最多8题准备练习；离开页面后继续生成，可在学习记录查看进度。
            </p>
            <div className="action-row">
              <button
                className="primary"
                disabled={!!busy || topic.trim().length < 2 || !validCounts}
              >
                {busy ? <LoaderCircle size={16} className="spin" /> : <GraduationCap size={16} />}{' '}
                {busy ? '正在准备讲解和题目' : '生成讲解与练习'}
              </button>
              {error && (
                <button
                  type="button"
                  className="secondary"
                  disabled={!!busy}
                  onClick={() => {
                    generation.current = null;
                    void generate();
                  }}
                >
                  新建生成请求
                </button>
              )}
            </div>
          </form>
          {session.user.role === 'owner' && (
            <details className="surface learning-form">
              <summary>管理员 · 练习总上限</summary>
              <p className="field-help">
                全站每份练习默认最多40题，可设置1至200题；已有课程不受降低上限影响。
              </p>
              <div className="learning-form-options">
                <label className="field-label">
                  总题数上限
                  <input
                    aria-label="总题数上限"
                    className="standard-input"
                    type="number"
                    min={1}
                    max={200}
                    step={1}
                    value={maximumDraft}
                    onChange={(e) => setMaximumDraft(e.target.value)}
                  />
                </label>
                <button
                  className="secondary"
                  disabled={
                    !!busy ||
                    !Number.isInteger(Number(maximumDraft)) ||
                    Number(maximumDraft) < 1 ||
                    Number(maximumDraft) > 200
                  }
                  onClick={() => void saveMaximum()}
                >
                  保存上限
                </button>
              </div>
            </details>
          )}
          {lesson && (
            <section className="learning-lesson">
              <header className="section-title">
                <h2>{lesson.title}</h2>
                <button
                  className="text-link"
                  onClick={() => {
                    setSelected('');
                    setLesson(null);
                  }}
                >
                  返回学习记录
                </button>
              </header>
              <div className="surface learning-explanation">
                {lesson.status === 'generating' && (
                  <p role="status">
                    <LoaderCircle size={16} className="spin" />{' '}
                    {lesson.progress?.stage === 'planning'
                      ? '讲解已保存，正在规划整套题目的覆盖与难度'
                      : lesson.progress?.stage === 'questions' || lesson.progress?.stage === 'repair'
                      ? '讲解已保存，正在分批准备练习'
                      : '正在准备详细讲解'}{' '}
                    · {lesson.progress?.completed || 0} / {lesson.progress?.total || total}题
                  </p>
                )}
                {lesson.error && (
                  <p className="error" role="alert">
                    {lesson.error} 部分内容保留，未自动重试；请明确新建生成请求。
                  </p>
                )}
                <PiMarkdown text={lesson.explanation || ''} />
              </div>
              {lesson.status === 'ready' && <h2>检验理解 · {lesson.questions?.length}题</h2>}
              {lesson.questions?.map((q) => (
                <Exercise
                  key={lesson.id + q.id}
                  draftKey={viewKey + lesson.id + q.id}
                  question={q}
                  latest={lesson.attempts?.filter((a) => a.questionId === q.id).at(-1)}
                  onGrade={(answer, id) => grade(lesson.id, q.id, answer, id)}
                />
              ))}
            </section>
          )}
          <section className="surface learning-history">
            <h2>学习记录</h2>
            {!lessons.length && <p className="muted">生成第一份讲解后，记录会保存在这里。</p>}
            {lessons.map((l) => (
              <button key={l.id} className="learning-history-row" onClick={() => setSelected(l.id)}>
                <span>
                  <strong>{l.title}</strong>
                  <small>
                    {dateLabel(l.createdAt)} ·{' '}
                    {l.status === 'ready'
                      ? '讲解与练习已保存'
                      : l.status === 'generating'
                        ? '生成中 · ' +
                          (l.progress?.completed || 0) +
                          ' / ' +
                          (l.progress?.total || '') +
                          '题'
                        : '生成未完成，请明确重试'}
                  </small>
                </span>
                <span>查看</span>
              </button>
            ))}
            {lessonsNext && (
              <button
                className="secondary"
                disabled={moreBusy}
                onClick={() => void older('lessons')}
              >
                {moreBusy ? '正在读取' : '加载更早学习记录'}
              </button>
            )}
          </section>
        </>
      ) : (
        <section className="learning-wrong">
          <label className="check-label">
            <input
              type="checkbox"
              checked={resolved}
              onChange={(e) => setResolved(e.target.checked)}
            />{' '}
            包含已掌握的题目
          </label>
          <p className="field-help">未达到80分自动收录；再练达到80分后标为已掌握，历史仍保留。</p>
          {!wrong.length && (
            <div className="surface">
              <BookOpen size={24} />
              <p>这里暂时没有待巩固的错题。</p>
            </div>
          )}
          {wrong.map((w) => (
            <div key={w.lessonId + w.questionId}>
              <header className="learning-review-heading">
                <strong>{w.title}</strong>
                <small>
                  答错{w.wrongCount}次 · 练习{w.reviewCount}次 · {w.resolved ? '已掌握' : '待巩固'}
                </small>
              </header>
              <Exercise
                draftKey={viewKey + w.lessonId + w.questionId}
                question={{ ...w.question, id: w.questionId }}
                latest={w.lastAttempt}
                onGrade={(answer, id) => grade(w.lessonId, w.questionId, answer, id)}
              />
            </div>
          ))}
          {wrongNext && (
            <button className="secondary" disabled={moreBusy} onClick={() => void older('wrong')}>
              {moreBusy ? '正在读取' : '加载更早错题'}
            </button>
          )}
        </section>
      )}
    </div>
  );
}
