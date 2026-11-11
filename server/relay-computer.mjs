import { z } from 'zod';
import { fail } from './accounts.mjs';
import { createRelayArtifacts } from './relay-artifacts.mjs';
import { longGoalControl } from '../deploy/pi/long-goal-command.mjs';
import { parseGoalPlan } from '../deploy/pi/goal-plan.mjs';
import { Readable } from 'node:stream';
import { agentRunState } from '../shared/agent-runtime.mjs';
import { createAgentBindings, computerPiRuntime } from './agent-bindings.mjs';
import {
  questionReplySchema,
  questionContinuation,
  continuedQuestions,
} from './question-continuation.mjs';
const uuid = z.string().uuid();
const count = z.number().finite().nonnegative().max(1e12);
const usageTokens = z
  .object({
    input: count.optional(),
    output: count.optional(),
    cacheRead: count.optional(),
    cacheWrite: count.optional(),
    total: count.optional(),
  })
  .strict();
const sessionContext = z
  .object({
    messageCount: count.optional(),
    stats: z
      .object({
        tokens: usageTokens.optional(),
        userMessages: count.optional(),
        assistantMessages: count.optional(),
        toolCalls: count.optional(),
        contextUsage: z
          .object({ tokens: count.nullable(), contextWindow: count, percent: count.nullable() })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();
const metrics = usageTokens.omit({ total: true }).extend({
  modelTurns: count.optional(),
  toolCalls: count.optional(),
  responseMs: count.optional(),
});
const longGoal = z
  .object({
    version: z.literal(1),
    id: z.string().max(200),
    objective: z.string().max(10000),
    status: z.enum(['active', 'paused', 'complete', 'budget_limited']),
    tokenBudget: z.number().int().nonnegative().nullable(),
    tokensUsed: z.number().int().nonnegative(),
    timeUsedSeconds: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    plan: z
      .unknown()
      .refine((v) => {
        try {
          parseGoalPlan(v);
          return true;
        } catch {
          return false;
        }
      }, '目标计划无效')
      .nullable()
      .optional(),
  })
  .strict();
const dialog = z
  .object({
    type: z.literal('extension_ui_request').optional(),
    id: z
      .string()
      .min(1)
      .max(200)
      .refine((id) => !/^(access:|mail:)/.test(id)),
    method: z.enum(['input', 'editor', 'select', 'confirm']),
    title: z.string().max(1000),
    message: z.string().max(4000).optional(),
    placeholder: z.string().max(1000).optional(),
    prefill: z.string().max(12000).optional(),
    options: z.array(z.string().max(1000)).max(100).optional(),
    source: z.literal('ask_user').optional(),
    questionId: uuid.optional(),
    toolCallId: z.string().min(1).max(200).optional(),
    createdAt: z.string().datetime(),
    status: z.enum(['pending', 'resolved']),
  })
  .strict();
const tool = z
  .object({
    id: z.string().max(200),
    name: z.string().max(128),
    path: z.string().max(500),
    status: z.enum(['running', 'done', 'error']),
    output: z.string().max(12000).optional(),
    command: z.string().max(8000).optional(),
    arguments: z.string().max(12000).optional(),
    summary: z.string().max(1000).optional(),
    backupId: uuid.optional(),
    sha256: z.string().max(64).optional(),
    bytes: z.number().nonnegative().optional(),
    exitCode: z.number().int().nullable().optional(),
  })
  .strict();
const progress = z
  .object({
    revision: z.number().int().min(1).max(2147483647),
    output: z.string().max(48000),
    thinking: z.string().max(48000),
    phase: z.string().max(100),
    tools: z.array(tool).max(100),
    uiRequests: z.array(dialog).max(100).optional(),
    longGoal: longGoal.nullable().optional(),
    metrics: metrics.optional(),
    context: sessionContext.optional(),
  })
  .strict();
export function createRelayComputer(
  db,
  { body, now, limit, ownedDevice, project, cancel, model, notifications, chatFiles, appFunctions },
) {
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(relay_jobs)')
      .all()
      .map((r) => r.name),
  );
  for (const [name, type] of [
    ['project_id', 'TEXT'],
    ['conversation_id', 'TEXT'],
    ['parent_id', 'TEXT'],
    ['execute', 'INTEGER NOT NULL DEFAULT 0'],
    ['delivery_sent', 'INTEGER NOT NULL DEFAULT 0'],
    ['state', "TEXT NOT NULL DEFAULT '{}'"],
    ['submission', 'TEXT'],
    ['attachments', "TEXT NOT NULL DEFAULT '[]'"],
    ['thinking_level', "TEXT NOT NULL DEFAULT 'off'"],
    ['scheduled', 'TEXT'],
    ['resumed', 'TEXT'],
  ])
    if (!columns.has(name)) db.exec(`ALTER TABLE relay_jobs ADD COLUMN ${name} ${type}`);
  db.exec(`CREATE TABLE IF NOT EXISTS relay_conversations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,device_id TEXT NOT NULL,project_id TEXT NOT NULL,title TEXT NOT NULL,manual INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS relay_conversation_jobs ON relay_jobs(owner,device_id,project_id,conversation_id,created_at);`);
  const conversationColumns = new Set(
    db
      .prepare('PRAGMA table_info(relay_conversations)')
      .all()
      .map((c) => c.name),
  );
  for (const name of ['pinned_at', 'archived_at'])
    if (!conversationColumns.has(name))
      db.exec(`ALTER TABLE relay_conversations ADD COLUMN ${name} TEXT`);
  db.exec(
    'CREATE TABLE IF NOT EXISTS relay_closed_conversations(id TEXT PRIMARY KEY,owner TEXT NOT NULL,device_id TEXT NOT NULL,project_id TEXT NOT NULL,closed_at TEXT NOT NULL)',
  );
  const bindings = createAgentBindings(db);
  for (const c of db
    .prepare(
      `SELECT owner,id,device_id,project_id FROM relay_conversations
       UNION SELECT owner,conversation_id AS id,device_id,project_id
       FROM relay_jobs WHERE conversation_id IS NOT NULL AND project_id IS NOT NULL`,
    )
    .all())
    bindings.bind(c.owner, 'computer', c.id, computerPiRuntime(c.device_id, c.project_id, c.id));
  const runtimeFor = (owner, device, pid, conversation) =>
    bindings.assert(owner, 'computer', conversation, computerPiRuntime(device, pid, conversation));
  const view = (j) =>
    j && {
      id: j.id,
      deviceId: j.device_id,
      projectId: j.project_id,
      conversationId: j.conversation_id,
      parentId: j.parent_id,
      input: j.input,
      access: j.access,
      thinkingLevel: j.thinking_level || 'off',
      canSchedule: db.prepare('SELECT role FROM users WHERE id=?').get(j.owner)?.role === 'owner',
      ...(j.resumed ? { resumeQuestion: JSON.parse(j.resumed) } : {}),
      ...(j.scheduled
        ? {
            schedule: JSON.parse(j.scheduled),
            toolAllowlist: JSON.parse(j.scheduled).toolAllowlist,
          }
        : {}),
      attachments:
        chatFiles?.selected(j.owner, j.conversation_id, JSON.parse(j.attachments || '[]')) || [],
      execute: !!j.execute,
      status: j.status,
      runtime: runtimeFor(j.owner, j.device_id, j.project_id, j.conversation_id),
      runState: agentRunState({
        ...JSON.parse(j.state || '{}'),
        status: j.status,
        stopPending:
          j.status === 'cancelled' &&
          !!JSON.parse(j.state || '{}').stop &&
          !JSON.parse(j.state || '{}').stop.acknowledgedAt,
      }),
      output: j.output,
      thinking: JSON.parse(j.state || '{}').thinking || '',
      phase: JSON.parse(j.state || '{}').phase || '',
      uiRequests: JSON.parse(j.state || '{}').uiRequests || [],
      longGoal: JSON.parse(j.state || '{}').longGoal,
      metrics: JSON.parse(j.state || '{}').metrics,
      context: JSON.parse(j.state || '{}').context,
      stopPending:
        j.status === 'cancelled' &&
        !!JSON.parse(j.state || '{}').stop &&
        !JSON.parse(j.state || '{}').stop.acknowledgedAt,
      tools: JSON.parse(j.tools),
      artifacts: artifacts.list(j.id),
      error: j.error,
      createdAt: j.created_at,
      updatedAt: j.updated_at,
    };
  const job = (device, id) => {
    const j = db
      .prepare('SELECT * FROM relay_jobs WHERE device_id=? AND id=? AND project_id IS NOT NULL')
      .get(device, id);
    if (!j) throw fail(404, '电脑任务不存在。');
    return j;
  };
  const aggregates = `COUNT(*) n,COALESCE(MAX(updated_at),'') at,COALESCE(SUM(COALESCE(json_extract(state,'$.revision'),0)+COALESCE(json_extract(state,'$.uiRevision'),0)+CASE status WHEN 'queued' THEN 1 WHEN 'running' THEN 2 WHEN 'delivering' THEN 3 WHEN 'accepted' THEN 4 WHEN 'applied' THEN 5 WHEN 'done' THEN 10 WHEN 'error' THEN 11 WHEN 'cancelled' THEN 12 ELSE 13 END),0) revision,SUM(CASE WHEN status IN ('queued','running','delivering','accepted','applied') THEN 1 ELSE 0 END) active,COALESCE(SUM((SELECT COUNT(*) FROM relay_job_files WHERE job_id=relay_jobs.id)),0) files`;
  const versionText = (r) => `${r?.n || 0}:${r?.at || ''}:${r?.revision || 0}:${r?.files || 0}`;
  const version = (owner, id) =>
    versionText(
      db
        .prepare(`SELECT ${aggregates} FROM relay_jobs WHERE owner=? AND conversation_id=?`)
        .get(owner, id),
    );
  function allowed(j) {
    if (!j.project_id) return;
    runtimeFor(j.owner, j.device_id, j.project_id, j.conversation_id);
    const p = project(j.device_id, j.project_id);
    if (j.access === 'edit' && !p.allow_write) throw fail(403, '本机已撤销文件修改权限。');
    if (j.execute && !p.allow_execute) throw fail(403, '本机未授权执行命令。');
  }
  function controls(j) {
    if (!j.project_id || j.status !== 'running') return [];
    const rows = db
      .prepare(
        "SELECT id,input FROM relay_jobs WHERE parent_id=? AND status='delivering' AND delivery_sent=0 ORDER BY created_at,rowid LIMIT 20",
      )
      .all(j.id);
    // Delivery is claimed before responding. Lost acknowledgements never cause an
    // automatic repeat of a steering message with possible side effects.
    for (const r of rows) db.prepare('UPDATE relay_jobs SET delivery_sent=1 WHERE id=?').run(r.id);
    // Replies may be delivered again after a lost heartbeat. The worker consumes
    // each dialog ID once; this cannot repeat a command or steering submission.
    const state = JSON.parse(j.state || '{}');
    return [
      ...rows,
      ...Object.values(state.uiReplies || {}).map((reply) => ({
        type: 'extension_ui_response',
        ...reply,
      })),
    ];
  }
  const artifacts = createRelayArtifacts(db, { chatFiles, job, allowed, ownedDevice, now, limit });
  function settleChildren(id) {
    db.prepare(
      "UPDATE relay_jobs SET status=CASE WHEN status='applied' THEN 'done' ELSE 'interrupted' END,error=CASE WHEN status='applied' THEN NULL ELSE '补充是否应用未确认，未自动重发。' END,updated_at=? WHERE parent_id=? AND status IN ('delivering','accepted','applied')",
    ).run(new Date(now()).toISOString(), id);
  }
  function sweep() {
    for (const r of db
      .prepare(
        "SELECT DISTINCT parent_id AS id FROM relay_jobs WHERE parent_id IS NOT NULL AND status IN ('delivering','accepted','applied') AND parent_id IN (SELECT id FROM relay_jobs WHERE status NOT IN ('queued','running'))",
      )
      .all())
      settleChildren(r.id);
    db.prepare(
      "UPDATE relay_jobs SET status='interrupted',error='此对话前一任务结果未知，未自动继续。' WHERE project_id IS NOT NULL AND parent_id IS NULL AND status='queued' AND conversation_id IN (SELECT conversation_id FROM relay_jobs WHERE parent_id IS NULL AND status='interrupted' AND project_id IS NOT NULL AND json_extract(state,'$.questionContinuation') IS NULL)",
    ).run();
  }
  function revoke(device, id) {
    for (const j of db
      .prepare(
        "SELECT id FROM relay_jobs WHERE device_id=? AND project_id IS NOT NULL AND status IN ('queued','running','delivering','accepted','applied')" +
          (id ? ' AND project_id=?' : ''),
      )
      .all(...(id ? [device, id] : [device]))) {
      cancel(j.id);
      db.prepare(
        "UPDATE relay_jobs SET status='cancelled',error='本机项目授权已撤销。' WHERE id=?",
      ).run(j.id);
      settleChildren(j.id);
    }
  }
  return {
    async schedule(run) {
      if (run.target?.kind !== 'computer' || !run.projectId)
        throw fail(400, '电脑定时任务缺少固定执行位置。');
      const actor = db.prepare('SELECT id,role FROM users WHERE id=?').get(run.ownerId);
      if (actor?.role !== 'owner') throw fail(403, '定时账号已失效。');
      const schedule = {
        jobId: run.jobId,
        jobName: run.jobName,
        scheduledAt: run.scheduledAt,
        timeZone: run.timeZone,
        toolAllowlist: run.toolAllowlist,
      };
      const old = db.prepare('SELECT * FROM relay_jobs WHERE id=?').get(run.id);
      if (old) {
        if (
          old.owner !== actor.id ||
          old.device_id !== run.target.deviceId ||
          old.project_id !== run.projectId ||
          old.conversation_id !== run.conversationId ||
          old.input !== run.input ||
          old.access !== run.access ||
          !!old.execute !== run.target.execute ||
          old.scheduled !== JSON.stringify(schedule)
        )
          throw fail(409, '定时请求编号已绑定其他内容。');
        if (['queued', 'running'].includes(old.status)) {
          try {
            ownedDevice(old.device_id, actor.id);
            const pr = project(old.device_id, old.project_id);
            if ((old.access === 'edit' && !pr.allow_write) || (old.execute && !pr.allow_execute))
              throw fail(403, '定时任务的电脑授权已撤销。');
          } catch (e) {
            cancel(old.id);
            throw e;
          }
        }
        return view(old);
      }
      if (run.skills.length) throw fail(400, '电脑定时计划不能加载服务器技能路径。');
      const input = {
        id: run.id,
        deviceId: run.target.deviceId,
        projectId: run.projectId,
        conversationId: run.conversationId,
        input: run.input,
        access: run.access,
        execute: run.target.execute,
        thinkingLevel: run.thinkingLevel,
        attachments: [],
        deliveryPreference: 'queue',
      };
      const req = Readable.from([Buffer.from(JSON.stringify(input))]);
      req.method = 'POST';
      req.headers = {};
      let value, status;
      const handled = await this.after(
        req,
        new URL('http://internal/api/relay/submissions'),
        (code, result) => {
          status = code;
          value = result;
        },
        actor,
        { schedule },
      );
      if (!handled || status >= 400)
        throw fail(status || 500, value?.error || '电脑定时请求失败。');
      return value.job;
    },
    view,
    allowed,
    controls,
    sweep,
    revoke,
    async before(req, url, json, d, res) {
      const path = url.pathname;
      if (await artifacts.before(req, url, json, d)) return true;
      const inputRoute = path.match(
        /^\/api\/relay\/device\/workspace\/jobs\/([^/]+)\/inputs(?:\/([^/]+))?$/,
      );
      if (inputRoute && req.method === 'GET') {
        const j = job(d.id, uuid.parse(inputRoute[1]));
        allowed(j);
        if (j.status !== 'running' || j.lease_until <= now() || j.owner !== d.owner)
          throw fail(403, '电脑任务已结束或附件授权已撤销。');
        if (!chatFiles) throw fail(503, '对话附件不可用。');
        if (inputRoute[2])
          await chatFiles.download(j.owner, j.conversation_id, uuid.parse(inputRoute[2]), res);
        else json(200, { files: chatFiles.list(j.owner, j.conversation_id) });
        return true;
      }
      const appRoute = path.match(
        /^\/api\/relay\/device\/workspace\/jobs\/([^/]+)\/app-functions$/,
      );
      if (appRoute && req.method === 'POST') {
        limit('computer-app-functions:' + d.id, 180);
        const j = job(d.id, uuid.parse(appRoute[1]));
        allowed(j);
        if (j.status !== 'running' || j.lease_until <= now() || j.owner !== d.owner)
          throw fail(409, '电脑任务已结束或授权已撤销。');
        if (!appFunctions) throw fail(503, '软件功能工具尚未配置。');
        json(
          200,
          await appFunctions(
            { owner: j.owner, task: j.id, conversation: j.conversation_id, origin: 'computer' },
            await body(req),
          ),
        );
        return true;
      }

      if (path === '/api/relay/device/workspace/jobs/poll' && req.method === 'GET') {
        limit('computer-poll:' + d.id, 120);
        sweep();
        const capacity = z.coerce
          .number()
          .int()
          .min(1)
          .max(8)
          .parse(url.searchParams.get('capacity') || 2);
        db.prepare('UPDATE relay_devices SET last_seen=? WHERE id=?').run(now(), d.id);
        if (
          db
            .prepare("SELECT COUNT(*) AS n FROM relay_jobs WHERE device_id=? AND status='running'")
            .get(d.id).n >= capacity ||
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM relay_jobs WHERE project_id IS NOT NULL AND status='running'",
            )
            .get().n >= 64
        ) {
          json(200, { job: null });
          return true;
        }
        const next = db
          .prepare(
            `SELECT j.* FROM relay_jobs j JOIN relay_projects p ON p.device_id=j.device_id AND p.id=j.project_id AND p.revoked=0
          WHERE j.device_id=? AND j.project_id IS NOT NULL AND j.parent_id IS NULL AND j.status='queued'
          AND NOT EXISTS(SELECT 1 FROM relay_operations o WHERE o.device_id=j.device_id AND o.project_id=j.project_id AND o.status IN ('queued','running') AND json_extract(o.input,'$.kind') IN ('package_install','package_remove','package_enable','package_rollback'))
          AND NOT EXISTS(SELECT 1 FROM relay_jobs r WHERE r.device_id=j.device_id AND r.conversation_id=j.conversation_id AND (r.status='running' OR (r.status='cancelled' AND json_extract(r.state,'$.stop.requestedAt') IS NOT NULL AND json_extract(r.state,'$.stop.acknowledgedAt') IS NULL))) ORDER BY j.created_at,j.rowid LIMIT 1`,
          )
          .get(d.id);
        if (!next) {
          json(200, { job: null });
          return true;
        }
        try {
          allowed(next);
        } catch (e) {
          cancel(next.id);
          json(200, { job: null });
          return true;
        }
        db.prepare(
          "UPDATE relay_jobs SET status='running',lease_until=?,updated_at=? WHERE id=?",
        ).run(now() + 45000, new Date(now()).toISOString(), next.id);
        json(200, { job: { ...view(job(d.id, next.id)), model } });
        return true;
      }
      const match = path.match(
        /^\/api\/relay\/device\/workspace\/jobs\/([^/]+)\/(progress|result|control)$/,
      );
      if (match && req.method === 'POST') {
        const j = job(d.id, uuid.parse(match[1]));
        limit('computer-progress:' + d.id, 1800);
        if (match[2] === 'control') {
          const p = z
            .object({
              id: uuid,
              status: z.enum(['accepted', 'applied', 'error']),
              error: z.string().max(1000).optional(),
            })
            .strict()
            .parse(await body(req));
          const c = job(d.id, p.id);
          if (c.parent_id !== j.id) throw fail(404, '补充不存在。');
          if (j.status === 'running' && ['delivering', 'accepted', 'applied'].includes(c.status))
            db.prepare('UPDATE relay_jobs SET status=?,error=?,updated_at=? WHERE id=?').run(
              c.status === 'applied' && p.status === 'accepted' ? 'applied' : p.status,
              p.error || null,
              new Date(now()).toISOString(),
              c.id,
            );
          json(200, { ok: true });
          return true;
        }
        const schema =
          match[2] === 'result'
            ? progress.extend({
                status: z.enum(['done', 'error', 'cancelled']),
                error: z.string().max(1000).nullable().optional(),
              })
            : progress;
        const p = schema.parse(await body(req));
        if (j.status === 'cancelled' && match[2] === 'result' && p.status === 'cancelled') {
          const state = JSON.parse(j.state || '{}');
          if (state.stop && !state.stop.acknowledgedAt) {
            state.stop.acknowledgedAt = new Date(now()).toISOString();
            state.uiRevision = (state.uiRevision || 0) + 1;
            db.prepare('UPDATE relay_jobs SET state=?,updated_at=? WHERE id=?').run(
              JSON.stringify(state),
              state.stop.acknowledgedAt,
              j.id,
            );
          }
        }
        if (j.status === 'running') {
          try {
            allowed(j);
          } catch (e) {
            cancel(j.id);
            json(200, { status: 'cancelled' });
            return true;
          }
          const old = JSON.parse(j.state || '{}');
          if (p.revision > (old.revision || 0))
            db.prepare(
              'UPDATE relay_jobs SET output=?,tools=?,state=?,updated_at=? WHERE id=?',
            ).run(
              p.output,
              JSON.stringify(p.tools),
              JSON.stringify({
                ...old,
                revision: p.revision,
                thinking: p.thinking,
                phase: p.phase,
                ...(p.longGoal !== undefined ? { longGoal: p.longGoal } : {}),
                ...(p.metrics !== undefined ? { metrics: p.metrics } : {}),
                ...(p.context !== undefined ? { context: p.context } : {}),
                uiRequests: (p.uiRequests || old.uiRequests || []).map((r) => ({
                  ...r,
                  status:
                    r.status === 'resolved'
                      ? 'resolved'
                      : old.uiRequests?.find((x) => x.id === r.id)?.status || r.status,
                })),
                uiReplies: Object.fromEntries(
                  Object.entries(old.uiReplies || {}).filter(
                    ([id]) => !p.uiRequests?.some((r) => r.id === id && r.status === 'resolved'),
                  ),
                ),
              }),
              new Date(now()).toISOString(),
              j.id,
            );
          if (match[2] === 'result') {
            db.prepare('UPDATE relay_jobs SET status=?,error=?,updated_at=? WHERE id=?').run(
              p.status,
              p.error || null,
              new Date(now()).toISOString(),
              j.id,
            );
            db.prepare('UPDATE relay_conversations SET updated_at=? WHERE id=?').run(
              new Date(now()).toISOString(),
              j.conversation_id,
            );
            settleChildren(j.id);
            if (p.status === 'error')
              try {
                notifications?.publish(
                  j.owner,
                  {
                    kind: 'error',
                    title: '电脑任务需要检查',
                    body: '任务结果已保存到智能助手中原来的电脑项目对话。',
                    conversationId: null,
                    taskId: j.id,
                  },
                  'computer:' + j.id + ':' + p.status,
                );
              } catch {
                console.warn('电脑任务通知未能保存。');
              }
          }
        }
        json(200, { status: job(d.id, j.id).status });
        return true;
      }
      return false;
    },
    async after(req, url, json, actor, internal = {}) {
      const path = url.pathname;
      const questionResumeRoute = path.match(/^\/api\/relay\/jobs\/([^/]+)\/question-resume$/);
      if (questionResumeRoute && req.method === 'POST') {
        limit('computer-question-resume:' + actor.id, 30);
        const original = db
          .prepare('SELECT * FROM relay_jobs WHERE id=? AND owner=? AND project_id IS NOT NULL')
          .get(uuid.parse(questionResumeRoute[1]), actor.id);
        if (!original) throw fail(404, '原电脑任务不存在。');
        ownedDevice(original.device_id, actor.id);
        allowed(original);
        const reply = questionReplySchema.parse(await body(req));
        const next = questionContinuation(actor.id, view(original), reply);
        if (next.reused) {
          const resumed = db
            .prepare('SELECT * FROM relay_jobs WHERE id=? AND owner=?')
            .get(next.id, actor.id);
          if (!resumed) throw fail(409, '续接结果未确认，不能重复执行。');
          json(200, { job: view(resumed) });
          return true;
        }
        cancel(original.id);
        const input = {
          id: next.id,
          deviceId: original.device_id,
          projectId: original.project_id,
          conversationId: original.conversation_id,
          input: reply.value,
          access: original.access,
          execute: !!original.execute,
          thinkingLevel: original.thinking_level || 'off',
          attachments: JSON.parse(original.attachments || '[]'),
          deliveryPreference: 'queue',
        };
        const synthetic = Readable.from([Buffer.from(JSON.stringify(input))]);
        synthetic.method = 'POST';
        synthetic.headers = {};
        return this.after(
          synthetic,
          new URL('http://internal/api/relay/submissions'),
          json,
          actor,
          {
            resumeQuestion: next.resumeQuestion,
            resumeFrom: original.id,
            reply,
            schedule: original.scheduled ? JSON.parse(original.scheduled) : undefined,
          },
        );
      }
      const replyRoute = path.match(/^\/api\/relay\/jobs\/([^/]+)\/ui$/);
      if (replyRoute && req.method === 'POST') {
        limit('computer-ui:' + actor.id, 60);
        const j = db
          .prepare('SELECT * FROM relay_jobs WHERE id=? AND owner=? AND project_id IS NOT NULL')
          .get(uuid.parse(replyRoute[1]), actor.id);
        if (!j) throw fail(404, '电脑任务不存在。');
        ownedDevice(j.device_id, actor.id);
        allowed(j);
        const reply = z
          .object({
            id: z.string().min(1).max(200),
            value: z.string().max(12000).optional(),
            confirmed: z.boolean().optional(),
            cancelled: z.boolean().optional(),
          })
          .strict()
          .parse(await body(req));
        const state = JSON.parse(j.state || '{}'),
          request = state.uiRequests?.find((r) => r.id === reply.id);
        if (j.status !== 'running' || j.lease_until <= now() || request?.status !== 'pending')
          throw fail(409, '问题已结束或已由其他设备回答。');
        if (
          reply.cancelled !== true &&
          (request.method === 'confirm'
            ? typeof reply.confirmed !== 'boolean'
            : typeof reply.value !== 'string' ||
              (request.method === 'select' &&
                !request.options?.includes(reply.value) &&
                !(
                  request.source === 'ask_user' &&
                  reply.value.trim().length > 0 &&
                  reply.value.length <= 4000
                )))
        )
          throw fail(400, '回答与问题类型不匹配。');
        const value = {
          id: request.id,
          ...(reply.cancelled
            ? { cancelled: true }
            : request.method === 'confirm'
              ? { confirmed: reply.confirmed }
              : { value: reply.value }),
        };
        state.uiRequests = state.uiRequests.map((r) =>
          r.id === request.id ? { ...r, status: 'responding' } : r,
        );
        state.uiReplies = { ...state.uiReplies, [request.id]: value };
        state.uiRevision = (state.uiRevision || 0) + 1;
        db.prepare('UPDATE relay_jobs SET state=?,updated_at=? WHERE id=?').run(
          JSON.stringify(state),
          new Date(now()).toISOString(),
          j.id,
        );
        json(200, { job: view(job(j.device_id, j.id)) });
        return true;
      }
      if (path === '/api/relay/submissions' && req.method === 'POST') {
        limit('computer-submit:' + actor.id, 60);
        const p = z
          .object({
            id: uuid,
            deviceId: uuid,
            projectId: uuid,
            conversationId: uuid,
            input: z.string().trim().max(8000),
            attachments: z.array(uuid).max(8).default([]),
            thinkingLevel: z.enum(['off', 'low', 'high', 'max']).default('off'),
            access: z.enum(['read', 'edit']),
            execute: z.boolean().default(false),
            deliveryPreference: z.enum(['queue', 'steer']).default('steer'),
          })
          .strict()
          .refine((p) => p.input.length || p.attachments.length, {
            message: '请输入消息或添加附件。',
          })
          .parse(await body(req));
        const device = ownedDevice(p.deviceId, actor.id);
        const pr = project(p.deviceId, p.projectId);
        const runtime = runtimeFor(actor.id, p.deviceId, p.projectId, p.conversationId);
        if (p.access === 'edit' && !pr.allow_write) throw fail(403, '本机未允许修改此项目。');
        if (p.execute && !pr.allow_execute) throw fail(403, '本机未授权终端或Agent执行命令。');
        if (db.prepare('SELECT 1 FROM relay_closed_conversations WHERE id=?').get(p.conversationId))
          throw fail(410, '电脑对话已删除，请新建对话。');
        if (p.attachments.length) chatFiles.selected(actor.id, p.conversationId, p.attachments);
        const signature = JSON.stringify(p),
          old = db.prepare('SELECT * FROM relay_jobs WHERE id=?').get(p.id);
        if (old) {
          if (
            (old.resumed || null) !==
            (internal.resumeQuestion ? JSON.stringify(internal.resumeQuestion) : null)
          )
            throw fail(409, '请求编号已绑定其他续接信息。');
          if (
            (old.scheduled || null) !==
            (internal.schedule ? JSON.stringify(internal.schedule) : null)
          )
            throw fail(409, '此请求已绑定其他定时上下文。');
          const previous = old.submission && JSON.parse(old.submission);
          const normalized = previous && {
            ...previous,
            attachments: previous.attachments || [],
            thinkingLevel: previous.thinkingLevel || 'off',
          };
          const canonical = (v) =>
            JSON.stringify(
              Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))),
            );
          if (
            old.owner !== actor.id ||
            !normalized ||
            canonical(normalized) !==
              canonical(previous.thinkingLevel === undefined ? { ...p, thinkingLevel: 'off' } : p)
          )
            throw fail(409, '请求编号已用于其他内容。');
          json(200, { job: view(old) });
          return true;
        }
        const capabilities = JSON.parse(device.capabilities || '[]');
        if (internal.resumeQuestion && !capabilities.includes('question_resume'))
          throw fail(409, '请先更新目标电脑，以安全续接中断的问题。');
        if (internal.schedule && !capabilities.includes('scheduled_tasks'))
          throw fail(409, '请先更新目标电脑，以使用绑定权限的定时任务。');
        if (p.attachments.length && !capabilities.includes('chat_inputs'))
          throw fail(409, '请先更新目标电脑的星屿客户端或执行器，以读取对话附件。');
        if (p.thinkingLevel !== 'off' && !capabilities.includes('thinking_levels'))
          throw fail(409, '请先更新目标电脑，以使用思考强度设置。');
        const conversation = db
          .prepare('SELECT * FROM relay_conversations WHERE id=?')
          .get(p.conversationId);
        if (
          conversation &&
          (conversation.owner !== actor.id ||
            conversation.device_id !== p.deviceId ||
            conversation.project_id !== p.projectId)
        )
          throw fail(409, '此对话已绑定其他电脑或项目。');
        if (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM relay_jobs WHERE status IN ('queued','running','delivering','accepted','applied')",
            )
            .get().n >= 512
        )
          throw fail(429, '电脑任务队列已满，请稍后再试。');
        if (
          db
            .prepare(
              "SELECT 1 FROM relay_jobs WHERE owner=? AND conversation_id=? AND parent_id IS NULL AND status='interrupted' AND json_extract(state,'$.questionContinuation') IS NULL AND id<>?",
            )
            .get(actor.id, p.conversationId, internal.resumeFrom || '')
        )
          throw fail(409, '此对话前一任务结果未知。请检查电脑文件后新建对话，旧任务不会自动重放。');
        if (
          internal.resumeQuestion &&
          db
            .prepare(
              "SELECT 1 FROM relay_jobs WHERE owner=? AND conversation_id=? AND parent_id IS NULL AND status IN ('queued','running')",
            )
            .get(actor.id, p.conversationId)
        )
          throw fail(409, '当前对话已有待处理任务，请先核对后再续接。');
        const parent =
          (p.deliveryPreference === 'steer' || longGoalControl(p.input)) && !p.attachments.length
            ? db
                .prepare(
                  "SELECT * FROM relay_jobs WHERE owner=? AND device_id=? AND project_id=? AND conversation_id=? AND parent_id IS NULL AND status='running'",
                )
                .get(actor.id, p.deviceId, p.projectId, p.conversationId)
            : null;
        if (
          parent &&
          (parent.access !== p.access ||
            !!parent.execute !== p.execute ||
            (parent.thinking_level || 'off') !== p.thinkingLevel)
        )
          throw fail(409, '执行中的补充必须沿用当前任务的文件和命令权限。');
        const at = new Date(now()).toISOString();
        db.exec('BEGIN IMMEDIATE');
        try {
          bindings.bind(actor.id, 'computer', p.conversationId, runtime);
          if (internal.resumeFrom) {
            const original = db
              .prepare('SELECT * FROM relay_jobs WHERE id=? AND owner=?')
              .get(internal.resumeFrom, actor.id);
            const next = questionContinuation(actor.id, view(original), internal.reply);
            if (
              next.id !== p.id ||
              JSON.stringify(next.resumeQuestion) !== JSON.stringify(internal.resumeQuestion)
            )
              throw fail(409, '问题已变化，请刷新后重新核对。');
            const state = JSON.parse(original.state || '{}');
            state.uiRequests = continuedQuestions(state.uiRequests, internal.reply, next);
            state.questionContinuation = p.id;
            state.uiRevision = (state.uiRevision || 0) + 1;
            db.prepare('UPDATE relay_jobs SET state=?,updated_at=? WHERE id=?').run(
              JSON.stringify(state),
              at,
              original.id,
            );
          }
          if (!conversation)
            db.prepare(
              'INSERT INTO relay_conversations(id,owner,device_id,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
            ).run(
              p.conversationId,
              actor.id,
              p.deviceId,
              p.projectId,
              p.input.slice(0, 40) || '附件对话',
              at,
              at,
            );
          db.prepare(
            'INSERT INTO relay_jobs(id,owner,device_id,project_id,conversation_id,parent_id,execute,input,access,status,submission,created_at,updated_at,attachments,thinking_level,scheduled,resumed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          ).run(
            p.id,
            actor.id,
            p.deviceId,
            p.projectId,
            p.conversationId,
            parent?.id || null,
            Number(p.execute),
            p.input,
            p.access,
            parent ? 'delivering' : 'queued',
            signature,
            at,
            at,
            JSON.stringify(p.attachments),
            p.thinkingLevel,
            internal.schedule ? JSON.stringify(internal.schedule) : null,
            internal.resumeQuestion ? JSON.stringify(internal.resumeQuestion) : null,
          );
          db.prepare('UPDATE relay_conversations SET updated_at=? WHERE id=?').run(
            at,
            p.conversationId,
          );
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        json(202, { job: view(db.prepare('SELECT * FROM relay_jobs WHERE id=?').get(p.id)) });
        return true;
      }
      if (path === '/api/relay/conversations' && req.method === 'GET') {
        const device = uuid.parse(url.searchParams.get('deviceId')),
          pid = uuid.parse(url.searchParams.get('projectId'));
        ownedDevice(device, actor.id);
        project(device, pid);
        const before = url.searchParams.get('before');
        let cursor;
        if (before) {
          cursor = db
            .prepare(
              'SELECT rowid AS seq,updated_at FROM relay_conversations WHERE id=? AND owner=? AND device_id=? AND project_id=?',
            )
            .get(uuid.parse(before), actor.id, device, pid);
          if (!cursor) throw fail(404, '电脑对话游标不存在。');
        }
        const rows = db
          .prepare(
            'SELECT rowid AS seq,id,title,pinned_at AS pinnedAt,archived_at AS archivedAt,created_at AS createdAt,updated_at AS updatedAt FROM relay_conversations WHERE owner=? AND device_id=? AND project_id=?' +
              (url.searchParams.get('archived') === 'include' ? '' : ' AND archived_at IS NULL') +
              (cursor ? ' AND (updated_at<? OR (updated_at=? AND rowid<?))' : '') +
              ' ORDER BY updated_at DESC,rowid DESC LIMIT 101',
          )
          .all(
            ...(cursor
              ? [actor.id, device, pid, cursor.updated_at, cursor.updated_at, cursor.seq]
              : [actor.id, device, pid]),
          );
        const page = rows.slice(0, 100),
          stats = new Map(
            page.length
              ? db
                  .prepare(
                    `SELECT conversation_id,${aggregates} FROM relay_jobs WHERE owner=? AND device_id=? AND project_id=? AND conversation_id IN (${page.map(() => '?').join(',')}) GROUP BY conversation_id`,
                  )
                  .all(actor.id, device, pid, ...page.map((c) => c.id))
                  .map((r) => [r.conversation_id, r])
              : [],
          );
        json(200, {
          conversations: page.map(({ seq, ...c }) => ({
            ...c,
            runtime: runtimeFor(actor.id, device, pid, c.id),
            version: versionText(stats.get(c.id)),
            active: stats.get(c.id)?.active || 0,
          })),
          next: rows.length > 100 ? rows[99].id : null,
        });
        return true;
      }
      const conversation = path.match(/^\/api\/relay\/conversations\/([^/]+)$/);
      if (conversation) {
        const c = db
          .prepare('SELECT * FROM relay_conversations WHERE id=? AND owner=?')
          .get(uuid.parse(conversation[1]), actor.id);
        if (!c) throw fail(404, '电脑对话不存在。');
        ownedDevice(c.device_id, actor.id);
        project(c.device_id, c.project_id);
        if (req.method === 'GET') {
          const before = url.searchParams.get('before');
          let cursor;
          if (before) {
            cursor = db
              .prepare(
                'SELECT rowid AS seq FROM relay_jobs WHERE id=? AND owner=? AND conversation_id=?',
              )
              .get(uuid.parse(before), actor.id, c.id);
            if (!cursor) throw fail(404, '历史游标不存在。');
          }
          const rows = db
            .prepare(
              'SELECT rowid AS seq,* FROM relay_jobs WHERE owner=? AND conversation_id=?' +
                (cursor ? ' AND rowid<?' : '') +
                ' ORDER BY rowid DESC LIMIT 101',
            )
            .all(...(cursor ? [actor.id, c.id, cursor.seq] : [actor.id, c.id]));
          json(200, {
            conversation: {
              id: c.id,
              title: c.title,
              deviceId: c.device_id,
              projectId: c.project_id,
              runtime: runtimeFor(actor.id, c.device_id, c.project_id, c.id),
              pinnedAt: c.pinned_at,
              archivedAt: c.archived_at,
              version: version(actor.id, c.id),
            },
            jobs: rows.slice(0, 100).reverse().map(view),
            next: rows.length > 100 ? rows[99].id : null,
          });
          return true;
        }
        if (req.method === 'PATCH') {
          const p = z
            .object({
              title: z.string().trim().min(1).max(120).optional(),
              pinned: z.boolean().optional(),
              archived: z.boolean().optional(),
            })
            .strict()
            .refine((p) => Object.keys(p).length > 0)
            .parse(await body(req));
          const at = new Date(now()).toISOString();
          db.prepare(
            'UPDATE relay_conversations SET title=?,manual=?,pinned_at=?,archived_at=?,updated_at=? WHERE id=? AND owner=?',
          ).run(
            p.title ?? c.title,
            p.title === undefined ? c.manual : 1,
            p.pinned === undefined ? c.pinned_at : p.pinned ? at : null,
            p.archived === undefined ? c.archived_at : p.archived ? at : null,
            at,
            c.id,
            actor.id,
          );
          json(200, { ok: true });
          return true;
        }
        if (req.method === 'DELETE') {
          if (
            db
              .prepare(
                "SELECT 1 FROM relay_jobs WHERE owner=? AND conversation_id=? AND status IN ('running','queued','delivering','accepted','applied')",
              )
              .get(actor.id, c.id)
          )
            throw fail(409, '对话仍有执行中或排队任务，请先停止任务。');
          if (
            db
              .prepare('SELECT 1 FROM pi_turns WHERE owner=? AND conversation_id=?')
              .get(actor.id, c.id)
          )
            throw fail(409, '此编号仍有关联服务器历史，请先分别处理。');
          db.exec('BEGIN IMMEDIATE');
          try {
            db.prepare('INSERT INTO relay_closed_conversations VALUES(?,?,?,?,?)').run(
              c.id,
              actor.id,
              c.device_id,
              c.project_id,
              new Date(now()).toISOString(),
            );
            db.prepare('DELETE FROM relay_job_files WHERE owner=? AND conversation_id=?').run(
              actor.id,
              c.id,
            );
            db.prepare('DELETE FROM relay_jobs WHERE owner=? AND conversation_id=?').run(
              actor.id,
              c.id,
            );
            db.prepare('DELETE FROM relay_conversations WHERE owner=? AND id=?').run(
              actor.id,
              c.id,
            );
            db.exec('COMMIT');
          } catch (e) {
            db.exec('ROLLBACK');
            throw e;
          }
          await chatFiles?.removeConversation(actor.id, c.id);
          json(200, { ok: true });
          return true;
        }
      }
      const lookup = path.match(/^\/api\/relay\/jobs\/([^/]+)$/);
      if (lookup && req.method === 'GET') {
        const j = db
          .prepare('SELECT * FROM relay_jobs WHERE id=? AND owner=? AND project_id IS NOT NULL')
          .get(uuid.parse(lookup[1]), actor.id);
        if (!j) throw fail(404, '电脑任务不存在。');
        ownedDevice(j.device_id, actor.id);
        project(j.device_id, j.project_id);
        json(200, { job: view(j) });
        return true;
      }
      return false;
    },
  };
}
