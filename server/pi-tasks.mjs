import { EventEmitter } from 'node:events';
import { fail } from './accounts.mjs';
import { applyPiTimeline, interruptedTools } from '../shared/pi-timeline.mjs';
import { applyRunMetrics, normalizeTodos } from '../shared/pi-activity.mjs';
import { concurrencyLimits } from '../deploy/pi/concurrency.mjs';
import { questionContinuation, continuedQuestions } from './question-continuation.mjs';
import { agentRunState } from '../shared/agent-runtime.mjs';
import { createAgentBindings, serverPiRuntime } from './agent-bindings.mjs';
import { createAgentDrivers } from './agent-drivers.mjs';

const pending = new Set(['queued', 'running', 'delivering', 'accepted', 'applied', 'stopping']);
const terminal = new Set(['done', 'error', 'cancelled', 'interrupted']);
export function createPiTasks(
  db,
  {
    run,
    steer,
    cancel,
    respond,
    available,
    completed,
    onEvent,
    maxConcurrent,
    maxConcurrentPerUser,
    activeCount,
    prepareQuestionResume,
  },
) {
  db.exec(`CREATE TABLE IF NOT EXISTS pi_tasks(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,id TEXT NOT NULL,conversation_id TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,UNIQUE(owner,id));
    CREATE INDEX IF NOT EXISTS pi_tasks_owner ON pi_tasks(owner,conversation_id,seq);
    CREATE TABLE IF NOT EXISTS pi_task_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL,task_id TEXT NOT NULL,event TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS pi_task_events_owner ON pi_task_events(owner,seq);`);
  db.exec(
    'CREATE TABLE IF NOT EXISTS pi_closed_conversations(owner TEXT NOT NULL,conversation_id TEXT NOT NULL,PRIMARY KEY(owner,conversation_id))',
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS pi_tasks_status ON pi_tasks(json_extract(state,'$.status'),seq)",
  );
  const bindings = createAgentBindings(db);
  const drivers = createAgentDrivers({
    bindings,
    adapters: [
      {
        backend: 'pi',
        transport: 'server',
        available,
        run,
        steer,
        cancel,
        respond,
        prepareQuestionResume,
      },
    ],
  });
  const notifications = new EventEmitter();
  notifications.setMaxListeners(200);
  const deliveries = new Map();
  const running = new Map(),
    retryAt = new Map();
  const limits = concurrencyLimits(maxConcurrent, maxConcurrentPerUser);
  const capacity = limits.maxConcurrent;
  const ownerRunning = (owner) =>
    Math.max(
      [...running.values()].filter((value) => value === owner).length,
      activeCount?.(owner) || 0,
    );
  const lane = (owner, task) => `${owner}:${task.conversationId}`;
  let closed = false,
    lastOwner = null;
  const decode = (row) => {
    if (!row) return null;
    const task = { ...JSON.parse(row.payload), ...JSON.parse(row.state) };
    const expectedRuntime = serverPiRuntime(row.owner, task.conversationId, task.projectId);
    task.runtime = bindings.assert(
      row.owner,
      'server',
      task.conversationId,
      task.runtime || expectedRuntime,
    );
    if (Object.keys(expectedRuntime).some((key) => task.runtime[key] !== expectedRuntime[key]))
      throw fail(409, '任务不能更换 Agent 或执行位置。');
    task.runState = agentRunState(task);
    return task;
  };
  const row = (owner, id) =>
    db.prepare('SELECT * FROM pi_tasks WHERE owner=? AND id=?').get(owner, id);
  const get = (owner, id) => decode(row(owner, id));
  const all = (owner) =>
    db.prepare('SELECT * FROM pi_tasks WHERE owner=? ORDER BY seq').all(owner).map(decode);
  const cursor = (owner) =>
    db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM pi_task_events WHERE owner=?').get(owner).n;
  function update(owner, id, patch, event) {
    if (closed) return;
    const current = row(owner, id);
    if (!current) return;
    const state = { ...JSON.parse(current.state), ...patch, updatedAt: new Date().toISOString() };
    db.prepare('UPDATE pi_tasks SET state=? WHERE owner=? AND id=?').run(
      JSON.stringify(state),
      owner,
      id,
    );
    const task = get(owner, id);
    const data = event || { type: 'task', task };
    db.prepare('INSERT INTO pi_task_events(owner,task_id,event) VALUES(?,?,?)').run(
      owner,
      id,
      JSON.stringify(data),
    );
    notifications.emit(owner);
    try {
      onEvent?.(owner, task, data);
    } catch {
      console.warn('通知记录未能保存。');
    }
    return task;
  }
  function event(owner, id, e, internalApproval = false) {
    if (closed || e.type === 'ping') return;
    if (
      ['extension_ui_request', 'extension_ui_resolved'].includes(e.type) &&
      /^(access|mail):/.test(String(e.id || '')) &&
      !internalApproval
    )
      return;
    const task = get(owner, id);
    if (!task) return;
    const patch = { lastActivityAt: new Date().toISOString() };
    if (e.type === 'long_goal') patch.longGoal = e.goal;
    if (e.type === 'runtime_warning')
      patch.runtimeWarnings = [...(task.runtimeWarnings || []), e.diagnostic].slice(-4);
    if (e.type === 'extension_ui_request') {
      if (!['input', 'editor', 'select', 'confirm'].includes(e.method) || typeof e.id !== 'string')
        return;
      patch.uiRequests = [
        ...(task.uiRequests || []).filter((r) => r.id !== e.id),
        { ...e, status: 'pending' },
      ].slice(-20);
      patch.phase = '等待你的回复';
    }
    if (e.type === 'extension_ui_resolved')
      patch.uiRequests = (task.uiRequests || []).map((r) =>
        r.id === e.id ? { ...r, status: 'resolved' } : r,
      );
    if (['response_start', 'tool_start', 'usage'].includes(e.type))
      patch.metrics = applyRunMetrics(task.metrics, e);
    if (['text_delta', 'thinking_delta', 'tool_start', 'tool_output', 'tool_end'].includes(e.type))
      patch.timeline = applyPiTimeline(task.timeline || [], e);
    if (e.type === 'response_start') Object.assign(patch, { phase: '正在回复' });
    if (e.type === 'text_delta')
      Object.assign(patch, { output: (task.output + e.delta).slice(-48000), phase: '正在回复' });
    if (e.type === 'thinking_delta')
      Object.assign(patch, {
        thinking: (task.thinking + e.delta).slice(-48000),
        phase: '正在思考',
      });
    if (e.type === 'compaction_start') patch.compacting = true;
    if (e.type === 'compaction_end') patch.compacting = false;
    if (e.type === 'tool_start')
      Object.assign(patch, {
        phase: '正在执行工具',
        tools: [
          ...task.tools,
          {
            id: e.id,
            name: e.name,
            path: e.path || '',
            status: 'running',
            ...(typeof e.command === 'string' ? { command: e.command.slice(0, 8000) } : {}),
          },
        ].slice(-100),
      });
    if (e.type === 'tool_output')
      patch.tools = task.tools.map((t) =>
        t.id === e.id ? { ...t, output: String(e.output || '').slice(-12000) } : t,
      );
    if (e.type === 'tool_end') {
      patch.phase = '等待模型继续';
    }
    if (e.type === 'tool_end')
      patch.tools = task.tools.map((t) =>
        t.id === e.id
          ? {
              ...t,
              status: e.error ? 'error' : 'done',
              ...(typeof e.output === 'string' ? { output: e.output.slice(-12000) } : {}),
              ...(Number.isInteger(e.exitCode) ? { exitCode: e.exitCode } : {}),
              ...(Array.isArray(e.todos) ? { todos: normalizeTodos(e.todos) } : {}),
              ...(typeof e.todoAction === 'string'
                ? { todoAction: e.todoAction.slice(0, 30) }
                : {}),
              ...Object.fromEntries(
                ['projectId', 'backupId', 'sha256', 'summary']
                  .filter((k) => typeof e[k] === 'string')
                  .map((k) => [k, e[k]]),
              ),
              ...Object.fromEntries(
                ['added', 'removed'].filter((k) => Number.isInteger(e[k])).map((k) => [k, e[k]]),
              ),
            }
          : t,
      );
    if (e.type === 'steer_applied') {
      const child = get(owner, e.id);
      if (child?.parentId === id && child.status !== 'done')
        update(owner, child.id, { status: 'applied' });
      return;
    }
    update(owner, id, patch, e);
  }
  // A restart never silently repeats an operation whose side effects are unknown.
  for (const r of db.prepare('SELECT * FROM pi_tasks ORDER BY seq').all()) {
    const task = decode(r);
    // Read legacy payloads without rewriting their task IDs, history or queues.
    bindings.bind(
      r.owner,
      'server',
      task.conversationId,
      serverPiRuntime(r.owner, task.conversationId, task.projectId),
    );
    if (pending.has(task.status) && task.status !== 'queued') {
      const done = completed(r.owner, task.id);
      update(r.owner, task.id, {
        status: done ? 'done' : 'interrupted',
        compacting: false,
        error: done ? '' : '服务重启，执行结果未确认。请检查对话和文件后发起新任务。',
      });
    }
  }
  for (const r of db.prepare('SELECT * FROM pi_tasks ORDER BY seq').all()) {
    const task = decode(r);
    if (
      task.status === 'queued' &&
      all(r.owner).some(
        (t) =>
          t.conversationId === task.conversationId &&
          t.status === 'interrupted' &&
          !t.questionContinuation,
      )
    )
      update(r.owner, task.id, {
        status: 'interrupted',
        error: '前一任务因服务重启中断；请核对后重新发送。',
      });
  }
  function pump() {
    if (closed) return;
    while (running.size < capacity) {
      const first = new Map();
      for (const r of db
        .prepare(
          "SELECT * FROM pi_tasks WHERE json_extract(state,'$.status')='queued' ORDER BY seq",
        )
        .all()) {
        const task = decode(r),
          key = lane(r.owner, task);
        if (!first.has(key)) first.set(key, { owner: r.owner, task, key });
      }
      const choices = [...first.values()].filter(
        ({ owner, task, key }) =>
          !running.has(key) &&
          Date.now() >= (retryAt.get(key) || 0) &&
          drivers.available(owner, task),
      );
      if (!choices.length) break;
      // Prefer the least occupied user, then rotate ties. FIFO is retained inside each lane.
      const owners = [...new Set(choices.map((x) => x.owner))];
      const least = Math.min(...owners.map(ownerRunning));
      const after = owners.indexOf(lastOwner);
      const owner = [...owners.slice(after + 1), ...owners.slice(0, after + 1)].find(
        (id) => ownerRunning(id) === least,
      );
      const next = choices.find((x) => x.owner === owner);
      lastOwner = owner;
      running.set(next.key, owner);
      void execute(owner, next.task, next.key);
    }
    const seen = new Set();
    for (const r of db
      .prepare("SELECT * FROM pi_tasks WHERE json_extract(state,'$.status')='queued' ORDER BY seq")
      .all()) {
      const task = decode(r),
        key = lane(r.owner, task);
      const phase =
        running.has(key) || seen.has(key)
          ? '等待本对话前序任务'
          : Date.now() < (retryAt.get(key) || 0)
            ? '等待执行器就绪'
            : running.size >= capacity
              ? '等待空闲执行名额'
              : !drivers.available(r.owner, task)
                ? '等待执行器就绪'
                : '等待公平调度';
      seen.add(key);
      if (task.phase !== phase) update(r.owner, task.id, { phase });
    }
  }
  function interruptQueued(owner, task) {
    for (const queued of all(owner).filter(
      (t) => t.conversationId === task.conversationId && t.status === 'queued',
    ))
      update(owner, queued.id, {
        status: 'interrupted',
        error: '前一任务未正常完成，后续消息已暂停，请核对后重新发送。',
      });
  }
  async function execute(owner, task, key) {
    update(owner, task.id, {
      status: 'running',
      phase: '正在连接 Pi',
      startedAt: new Date().toISOString(),
    });
    try {
      const result = await drivers.invoke('run', owner, task, (e) => event(owner, task.id, e));
      if (closed) return;
      const latest = get(owner, task.id);
      retryAt.delete(key);
      update(owner, task.id, {
        status: latest.status === 'stopping' ? 'cancelled' : 'done',
        ...result,
        ...(latest.status === 'stopping' ? interruptedTools({ ...latest, ...result }) : {}),
        finishedAt: result.execution?.finishedAt || new Date().toISOString(),
        compacting: false,
        phase: '',
      });
      if (latest.status === 'stopping') interruptQueued(owner, task);
      for (const child of all(owner).filter(
        (t) => t.parentId === task.id && pending.has(t.status),
      )) {
        update(
          owner,
          child.id,
          child.status === 'applied'
            ? { status: 'done' }
            : { status: 'error', error: '本次补充未确认进入 Pi，请核对回复后重新发送。' },
        );
      }
    } catch (e) {
      if (closed) return;
      const latest = get(owner, task.id);
      if (e.status === 429 && latest.status === 'running') {
        retryAt.set(key, Date.now() + 1500);
        update(owner, task.id, { status: 'queued', phase: '等待执行器就绪', startedAt: null });
        return;
      }
      const stopped = latest.status === 'stopping';
      retryAt.delete(key);
      update(owner, task.id, {
        status: stopped ? 'cancelled' : 'error',
        error: stopped ? '已停止。' : e.status ? e.message : 'Pi 执行失败或中断，请检查记录。',
        ...interruptedTools({ ...latest, tools: e.tools || latest.tools }),
        ...(e.diagnostic ? { diagnostic: e.diagnostic } : {}),
        compacting: false,
        phase: '',
        finishedAt: new Date().toISOString(),
      });
      for (const child of all(owner).filter((t) => t.parentId === task.id && pending.has(t.status)))
        update(owner, child.id, {
          status: 'error',
          error: '原任务已结束；补充是否执行请核对回复与文件。',
        });
      // Do not automatically execute further instructions in a conversation after a failure/stop.
      interruptQueued(owner, task);
    } finally {
      running.delete(key);
      if (!closed) queueMicrotask(pump);
    }
  }
  const timer = setInterval(() => void pump(), 1000);
  timer.unref();
  const api = {
    get,
    all,
    event,
    approvalEvent: (owner, id, e) => event(owner, id, e, true),
    live: (owner, conversation) =>
      all(owner).filter((t) => t.conversationId === conversation && pending.has(t.status)),
    scope(owner, conversation) {
      const t = all(owner)
        .filter((t) => t.conversationId === conversation)
        .at(-1);
      return t ? { projectId: t.projectId || null, access: t.access } : null;
    },
    snapshot(owner) {
      const tasks = all(owner);
      return {
        tasks: [
          ...tasks.filter((t) => pending.has(t.status)),
          ...tasks.filter((t) => !pending.has(t.status)).slice(-100),
        ],
        cursor: cursor(owner),
        scheduler: {
          ...limits,
          running: ownerRunning(owner),
          queued: tasks.filter((t) => t.status === 'queued').length,
        },
      };
    },
    async changes(owner, after, req, res) {
      const read = () => {
        const rows = db
          .prepare(
            'SELECT seq,task_id AS taskId,event FROM pi_task_events WHERE owner=? AND seq>? ORDER BY seq LIMIT 201',
          )
          .all(owner, after);
        if (rows.length <= 200) return rows.map((r) => ({ ...r, event: JSON.parse(r.event) }));
        // A slow or resumed client should see the current partial answer in one
        // response, rather than replay thousands of obsolete character events.
        // Use real per-task event cursors so older clients also understand this.
        const latest = db
          .prepare(
            'SELECT task_id AS taskId,MAX(seq) AS seq FROM pi_task_events WHERE owner=? AND seq>? GROUP BY task_id ORDER BY seq LIMIT 200',
          )
          .all(owner, after);
        const result = [];
        let bytes = 0;
        for (const r of latest) {
          const task = get(owner, r.taskId);
          const event = task
            ? { type: 'task', task }
            : JSON.parse(
                db
                  .prepare('SELECT event FROM pi_task_events WHERE seq=? AND owner=?')
                  .get(r.seq, owner).event,
              );
          const size = Buffer.byteLength(JSON.stringify(event));
          if (result.length && bytes + size > 1500000) break;
          bytes += size;
          result.push({ ...r, event });
        }
        return result;
      };
      let events = read();
      if (!events.length && !res.destroyed)
        await new Promise((resolve) => {
          const finish = () => {
            clearTimeout(timeout);
            notifications.off(owner, finish);
            res.off('close', finish);
            resolve();
          };
          const timeout = setTimeout(finish, 20000);
          notifications.once(owner, finish);
          res.once('close', finish);
        });
      if (closed || res.destroyed) return { events: [], cursor: after };
      events = read();
      return { events, cursor: events.at(-1)?.seq ?? after };
    },
    add(owner, p) {
      if (p.projectId === undefined) {
        const existing = bindings.get(owner, 'server', p.conversationId);
        if (existing) p = { ...p, projectId: existing.projectId };
      }
      const runtime = bindings.assert(
        owner,
        'server',
        p.conversationId,
        serverPiRuntime(owner, p.conversationId, p.projectId),
      );
      if (p.runtime) {
        const requested = bindings.assert(owner, 'server', p.conversationId, p.runtime);
        if (Object.keys(runtime).some((key) => requested[key] !== runtime[key]))
          throw fail(409, '任务不能更换 Agent 或执行位置。');
      }
      p = { ...p, runtime };
      if (
        db
          .prepare('SELECT 1 FROM pi_closed_conversations WHERE owner=? AND conversation_id=?')
          .get(owner, p.conversationId)
      )
        throw fail(409, '此对话已删除，请重新绑定定时计划。');
      const old = get(owner, p.id);
      if (old) {
        if (
          [
            'conversationId',
            'input',
            'projectId',
            'access',
            'mode',
            'parentId',
            'thinkingLevel',
            'attachments',
            'toolAllowlist',
            'skills',
            'schedule',
            'resumeQuestion',
          ].some((k) => JSON.stringify(old[k] ?? null) !== JSON.stringify(p[k] ?? null))
        )
          throw fail(409, '这条请求已存在不同内容。');
        return old;
      }
      if (all(owner).filter((t) => pending.has(t.status)).length >= 20)
        throw fail(429, '最多保留20条待处理消息，请先处理队列。');
      if (
        db
          .prepare(
            "SELECT count(*) n FROM pi_tasks WHERE json_extract(state,'$.status') IN ('queued','running','delivering','accepted','applied','stopping')",
          )
          .get().n >= 500
      )
        throw fail(429, '服务器待处理任务已满，请稍后再试。');
      const state = {
        status: p.mode === 'steer' ? 'delivering' : 'queued',
        revision: 1,
        output: '',
        thinking: '',
        tools: [],
        timeline: [],
        phase: '',
        compacting: false,
        uiRequests: [],
        metrics: { modelTurns: 0, toolCalls: 0 },
        createdAt: new Date().toISOString(),
      };
      bindings.bind(owner, 'server', p.conversationId, runtime);
      db.prepare(
        'INSERT INTO pi_tasks(owner,id,conversation_id,payload,state) VALUES(?,?,?,?,?)',
      ).run(owner, p.id, p.conversationId, JSON.stringify(p), JSON.stringify(state));
      const task = update(owner, p.id, {});
      if (p.mode === 'steer') {
        // Submission is owned by the server and keeps running if the HTTP client disconnects.
        const key = owner + ':' + task.parentId;
        const delivery = (deliveries.get(key) || Promise.resolve())
          .catch(() => {})
          .then(() => {
            if (closed || get(owner, task.id)?.status !== 'delivering') return;
            return drivers.invoke('steer', owner, task);
          });
        deliveries.set(key, delivery);
        void delivery
          .then(
            () => {
              if (!closed && get(owner, p.id)?.status === 'delivering')
                update(owner, p.id, { status: 'accepted' });
            },
            (e) => {
              if (!closed && get(owner, p.id)?.status === 'delivering')
                update(owner, p.id, {
                  status: 'error',
                  error: e.status ? e.message : '补充未确认送达，请核对后重新发送。',
                });
            },
          )
          .finally(() => {
            if (deliveries.get(key) === delivery) deliveries.delete(key);
          });
      } else setImmediate(() => void pump());
      return task;
    },
    edit(owner, id, p) {
      const t = get(owner, id);
      if (!t) throw fail(404, '任务不存在。');
      if (t.status !== 'queued' || t.revision !== p.revision)
        throw fail(409, '消息已开始执行或已被其他设备修改，请刷新队列。');
      const old = row(owner, id);
      db.prepare('UPDATE pi_tasks SET payload=? WHERE owner=? AND id=?').run(
        JSON.stringify({ ...JSON.parse(old.payload), input: p.input }),
        owner,
        id,
      );
      return update(owner, id, { revision: t.revision + 1 });
    },
    closeConversation(owner, id) {
      db.prepare('INSERT OR IGNORE INTO pi_closed_conversations VALUES(?,?)').run(owner, id);
    },
    async respond(owner, id, response) {
      const task = get(owner, id);
      if (!task) throw fail(404, '任务不存在。');
      const request = task.uiRequests?.find((r) => r.id === response.id);
      if (task.status !== 'running' || request?.status !== 'pending')
        throw fail(409, '插件请求已结束或已由其他设备处理。');
      let reply;
      if (response.cancelled === true) reply = { id: request.id, cancelled: true };
      else if (request.method === 'confirm' && typeof response.confirmed === 'boolean')
        reply = {
          id: request.id,
          confirmed: response.confirmed,
          ...(request.id.startsWith('access:') && response.confirmed && response.approval
            ? { approval: response.approval }
            : {}),
        };
      else if (
        request.method !== 'confirm' &&
        typeof response.value === 'string' &&
        (request.method !== 'select' ||
          request.options.includes(response.value) ||
          (request.source === 'ask_user' &&
            response.value.trim().length > 0 &&
            response.value.length <= 4000))
      )
        reply = { id: request.id, value: response.value };
      else throw fail(400, '插件回复与请求类型不匹配。');
      update(owner, id, {
        uiRequests: task.uiRequests.map((r) =>
          r.id === request.id ? { ...r, status: 'responding' } : r,
        ),
      });
      try {
        if (!respond) throw fail(503, '执行器暂不支持插件交互。');
        await drivers.invoke('respond', owner, task, reply);
        const latest = get(owner, id);
        return update(owner, id, {
          uiRequests: latest.uiRequests.map((r) =>
            r.id === request.id ? { ...r, status: 'resolved' } : r,
          ),
        });
      } catch (e) {
        const latest = get(owner, id);
        update(owner, id, {
          uiRequests: latest.uiRequests.map((r) =>
            r.id === request.id ? { ...r, status: e.status === 409 ? 'resolved' : 'pending' } : r,
          ),
        });
        throw e;
      }
    },
    async resumeQuestion(owner, id, reply) {
      const original = get(owner, id);
      let next = questionContinuation(owner, original, reply);
      if (next.reused) {
        const resumed = get(owner, next.id);
        if (!resumed) throw fail(409, '续接结果未确认，请检查记录，不能重复执行。');
        return resumed;
      }
      const check = () => {
        if (
          closed ||
          api.live(owner, original.conversationId).length ||
          all(owner).some(
            (t) =>
              t.conversationId === original.conversationId &&
              t.id !== id &&
              t.status === 'interrupted' &&
              !t.questionContinuation,
          )
        )
          throw fail(409, '此对话还有运行中或结果未知的任务，请先核对。');
      };
      check();
      bindings.bind(
        owner,
        'server',
        original.conversationId,
        serverPiRuntime(owner, original.conversationId, original.projectId),
      );
      if (!prepareQuestionResume) throw fail(503, '执行器暂不支持问题续接。');
      await drivers.invoke('prepareQuestionResume', owner, original);
      next = questionContinuation(owner, get(owner, id), reply);
      if (next.reused) return get(owner, next.id);
      check();
      const payload = Object.fromEntries(
        [
          'conversationId',
          'projectId',
          'access',
          'thinkingLevel',
          'attachments',
          'toolAllowlist',
          'skills',
          'schedule',
        ]
          .filter((key) => original[key] !== undefined)
          .map((key) => [key, original[key]]),
      );
      db.exec('BEGIN IMMEDIATE');
      try {
        const resumed = api.add(owner, {
          ...payload,
          id: next.id,
          input: reply.value,
          mode: 'queue',
          parentId: null,
          resumeQuestion: next.resumeQuestion,
        });
        update(owner, id, {
          uiRequests: continuedQuestions(original.uiRequests, reply, next),
          questionContinuation: next.id,
        });
        db.exec('COMMIT');
        return resumed;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async stop(owner, id) {
      const t = get(owner, id);
      if (!t) throw fail(404, '任务不存在。');
      if (terminal.has(t.status)) return t;
      if (t.status === 'queued')
        return update(owner, id, { status: 'cancelled', revision: t.revision + 1 });
      if (t.parentId) throw fail(409, '补充已交给 Pi，无法单独撤回；可停止当前任务。');
      update(owner, id, { status: 'stopping', phase: '正在停止' });
      await drivers.invoke('cancel', owner, t);
      return get(owner, id);
    },
    close() {
      closed = true;
      clearInterval(timer);
      for (const name of notifications.eventNames()) notifications.emit(name);
    },
  };
  return api;
}
