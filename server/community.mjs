import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { createAccounts, equal, fail } from './accounts.mjs';
import { createChatFiles, readUpload } from './files.mjs';
import { createPiTasks } from './pi-tasks.mjs';
import { createPiSchedulePump } from './pi-schedules.mjs';
import { cronAction } from './schedule-actions.mjs';
import { questionReplySchema } from './question-continuation.mjs';
import { createPiConversations } from './pi-conversations.mjs';
import { createPiTitles } from './pi-titles.mjs';
import { createPiBranches } from './pi-branches.mjs';
import { createPiSessionContext } from './pi-session-context.mjs';
import { conversationList } from '../shared/pi-conversation-list.mjs';
import { decodeExportFiles } from './file-exports.mjs';
import { concurrencyLimits } from '../deploy/pi/concurrency.mjs';
import { clientAddress } from './client-address.mjs';
import { createProjectLabels, projectLabelSchema } from './project-labels.mjs';
import { activityDeadline } from '../deploy/pi/activity-deadline.mjs';
import { longGoalControl } from '../deploy/pi/long-goal-command.mjs';
import { createAgentBindings, serverPiRuntime } from './agent-bindings.mjs';
import { agentRunState, agentCapabilities } from '../shared/agent-runtime.mjs';
import {
  createAssistanceContext,
  assistanceSourceSchema,
  assistancePrompt,
} from './assistance-context.mjs';
const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{2,31}$/, '用户名为 3–32 位小写字母、数字、下划线或短横线');
const password = z.string().min(10, '密码至少 10 个字符').max(128);
const displayName = z.string().trim().min(1).max(40);
const uuid = z.string().uuid();
const diagnosticSchema = z
  .object({
    code: z.string().regex(/^[a-z_]{1,64}$/),
    message: z.string().max(500),
    details: z.string().max(12000),
    phase: z.enum(['startup', 'run']),
    exitCode: z.number().int().optional(),
  })
  .strict();
export function createCommunity(store, { token, body, options = {} }) {
  const now = options.now || Date.now;
  const cleaningHelpers = new Map();
  const helperOperations = new Map();
  let communityClosed = false;
  let helperLifetimesReady = false;
  function withNotice(work) {
    store.db.exec('SAVEPOINT social_notice');
    try {
      const result = work();
      store.db.exec('RELEASE social_notice');
      return result;
    } catch (e) {
      store.db.exec('ROLLBACK TO social_notice; RELEASE social_notice');
      throw e;
    }
  }
  const accounts = createAccounts(store.db, { now: options.now });
  const projectLabels = createProjectLabels(store.db);
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS pi_submission_receipts(owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,id TEXT NOT NULL,input TEXT NOT NULL,PRIMARY KEY(owner,id))',
  );
  const conversationMetadata = createPiConversations(store.db, { now: options.now });
  const runtimeBindings = createAgentBindings(store.db);
  const titles = createPiTitles(conversationMetadata, options.generateTitle);
  const sessionContext = createPiSessionContext(store.db, { now: options.now });
  const chatFiles = createChatFiles(store.db, {
    root: options.filesDir,
    piRoot: options.piUploadsRoot ?? options.filesDir,
  });
  const pi = options.piConfig ?? {
    url: process.env.PI_BRIDGE_URL || '',
    token: process.env.PI_BRIDGE_TOKEN || '',
    fetch,
  };
  const piReady = !!(pi.url && pi.token);
  const assistanceContext = createAssistanceContext(store.db, {
    now: options.now,
    serverProject: (owner, id) => projectFor(accounts.profile(owner), id, 'read'),
  });
  const windows = new Map();
  function limit(key, max, span = 60000) {
    const now = Date.now();
    if (windows.size > 2000) for (const [k, v] of windows) if (v.until <= now) windows.delete(k);
    const w = windows.get(key);
    if (w && w.until > now) {
      if (w.count >= max) throw fail(429, '请求较多，请稍后再试。');
      w.count++;
    } else {
      if (windows.size > 4000) throw fail(429, '请求较多，请稍后再试。');
      windows.set(key, { count: 1, until: now + span });
    }
  }
  const activePi = new Set();
  const limits = concurrencyLimits(
    options.piConcurrency ?? process.env.PI_MAX_CONCURRENT,
    options.piConcurrencyPerUser ?? process.env.PI_MAX_CONCURRENT_PER_USER,
  );
  const concurrency = limits.maxConcurrent;
  const activeFor = (owner) => [...activePi].filter((key) => key.startsWith(owner + ':')).length;
  function requireUser(actor) {
    if (!actor?.id) throw fail(401, '请先登录独立账号。');
  }
  const projectIdSchema = z.string().regex(/^[a-z0-9-]{1,50}$/);
  const toolsSchema = z
    .array(
      z
        .object({
          id: z.string().max(200),
          name: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
          path: z.string().max(500),
          command: z.string().max(8000).optional(),
          arguments: z.string().max(12000).optional(),
          output: z.string().max(12000).optional(),
          exitCode: z.number().int().optional(),
          projectId: projectIdSchema.optional(),
          status: z.enum(['done', 'error', 'running']),
          summary: z.string().max(1000).optional(),
          backupId: z.string().uuid().optional(),
          sha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          bytes: z.number().int().nonnegative().optional(),
          added: z.number().int().nonnegative().optional(),
          removed: z.number().int().nonnegative().optional(),
          todoAction: z.string().max(30).optional(),
          todos: z
            .array(
              z
                .object({
                  id: z.string().max(160),
                  text: z.string().max(2000),
                  status: z.enum(['pending', 'running', 'done', 'cancelled']),
                })
                .strict(),
            )
            .max(100)
            .optional(),
        })
        .strict(),
    )
    .max(100);
  const principalFor = (actor) => ({
    id: actor.id,
    username: actor.username,
    admin: actor.role === 'owner',
  });
  async function projectsFor(actor) {
    const result = await bridge('/projects', undefined, 10000, principalFor(actor));
    return {
      projects: projectLabels.decorate(
        actor.id,
        'server',
        (result.projects || []).filter(
          (p) =>
            actor.role === 'owner' ||
            p.ownerId === actor.id ||
            ['read', 'edit'].includes(p.memberAccess),
        ),
      ),
    };
  }
  async function projectFor(actor, id, access = 'read') {
    const { projects } = await projectsFor(actor),
      project = projects.find((p) => p.id === id);
    if (!project) throw fail(actor.role === 'owner' ? 404 : 403, '此账号尚未获准访问这个项目。');
    if (
      access === 'edit' &&
      (project.readOnly ||
        (actor.role !== 'owner' && project.ownerId !== actor.id && project.memberAccess !== 'edit'))
    )
      throw fail(403, '此账号尚未获准修改这个项目。');
    return project;
  }
  async function bridge(path, data, timeout = 10000, principal) {
    if (!piReady) throw fail(503, '远程 Pi 尚未配置。');
    let response;
    try {
      response = await (pi.fetch ?? fetch)(`${pi.url}${path}`, {
        method: data ? 'POST' : 'GET',
        headers: {
          Authorization: `Bearer ${pi.token}`,
          ...(principal ? { 'X-Astral-Project-Principal': JSON.stringify(principal) } : {}),
          ...(data ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(data ? { body: JSON.stringify(data) } : {}),
        signal: AbortSignal.timeout(timeout),
        redirect: 'error',
      });
    } catch {
      throw fail(502, 'Pi 连接超时或中断，请检查任务记录和项目文件。');
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw fail(502, 'Pi 返回了无效响应，请检查任务记录。');
    }
    for (const event of result.usageEvents || [])
      options.usage?.pi(
        data?.ownerId,
        { id: data?.requestId || data?.sessionKey, assistance: !!data?.mailAccess },
        event,
      );
    if (!response.ok)
      throw Object.assign(
        fail(
          [400, 403, 404, 409, 413, 429, 503].includes(response.status) ? response.status : 502,
          typeof result.error === 'string' ? result.error.slice(0, 500) : 'Pi 请求失败。',
        ),
        {
          tools: toolsSchema.parse(result.tools || []),
          ...(result.diagnostic ? { diagnostic: diagnosticSchema.parse(result.diagnostic) } : {}),
        },
      );
    return result;
  }
  async function streamBridge(payload, res, onEvent) {
    let response;
    const controller = new AbortController();
    const deadline = activityDeadline(930000, () => controller.abort());
    try {
      response = await (pi.fetch ?? fetch)(`${pi.url}/run/stream`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${pi.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch {
      deadline.close();
      throw fail(502, 'Pi 连接中断。');
    }
    if (!response.ok) {
      deadline.close();
      let data = {};
      try {
        data = await response.json();
      } catch {}
      throw fail(response.status === 429 ? 429 : 502, data.error || 'Pi 请求失败。');
    }
    if (!response.headers.get('content-type')?.includes('application/x-ndjson')) {
      deadline.close();
      throw fail(502, 'Pi 服务需要升级才能流式输出。');
    }
    res?.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    res?.flushHeaders();
    const reader = response.body.getReader(),
      decoder = new TextDecoder();
    let buffer = '',
      result = null;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          if (!line) continue;
          if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw fail(502, 'Pi 单条输出过多。');
          const e = JSON.parse(line);
          if (e.type !== 'ping') deadline.touch();
          if (e.type === 'extension_ui_request') deadline.wait(e.id);
          if (e.type === 'extension_ui_resolved') deadline.resume(e.id);
          if (['billing_start', 'billing_usage'].includes(e.type)) {
            options.usage?.pi(payload.ownerId, { id: payload.requestId || payload.sessionKey }, e);
            continue;
          }
          if (e.type === 'done') result = e;
          else if (e.type === 'error')
            throw Object.assign(
              fail(
                [400, 402, 429].includes(e.status) ? e.status : 502,
                z
                  .string()
                  .max(1000)
                  .parse(e.error || 'Pi 执行失败。'),
              ),
              {
                tools: toolsSchema.parse(e.tools || []),
                ...(e.diagnostic ? { diagnostic: diagnosticSchema.parse(e.diagnostic) } : {}),
              },
            );
          else if (e.type === 'runtime_warning') {
            const warning = {
              type: 'runtime_warning',
              diagnostic: diagnosticSchema.parse(e.diagnostic),
            };
            onEvent?.(warning);
            if (res && !res.destroyed) res.write(JSON.stringify(warning) + '\n');
          } else if (
            [
              'text_delta',
              'thinking_delta',
              'response_start',
              'usage',
              'tool_start',
              'tool_output',
              'tool_end',
              'compaction_start',
              'compaction_end',
              'ping',
              'steer_applied',
              'extension_ui_request',
              'extension_ui_resolved',
              'long_goal',
              'notification',
              'notification_policy',
            ].includes(e.type)
          ) {
            options.usage?.pi(
              payload.ownerId,
              { id: payload.requestId, assistance: !!payload.mailAccess },
              e,
            );
            onEvent?.(e);
            if (res && !res.destroyed) res.write(JSON.stringify(e) + '\n');
          }
        }
        if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) throw fail(502, 'Pi 单条输出过多。');
      }
    } finally {
      deadline.close();
      reader.releaseLock();
    }
    if (buffer.trim() || !result) throw fail(502, 'Pi 流式结果不完整，请检查记录。');
    return result;
  }
  const keyFor = (owner, id) => createHash('sha256').update(`${owner}:${id}`).digest('hex');
  const branches = createPiBranches(store.db, {
    accounts,
    metadata: conversationMetadata,
    chatFiles,
    forkNative: async ({ owner, source, target, ...p }) => {
      const sourceRuntime = runtimeBindings.get(owner, 'server', source);
      if (sourceRuntime) {
        runtimeBindings.assert(
          owner,
          'server',
          source,
          serverPiRuntime(owner, source, sourceRuntime.projectId),
        );
        runtimeBindings.assert(
          owner,
          'server',
          target,
          serverPiRuntime(owner, target, sourceRuntime.projectId),
        );
      }
      const health = await bridge('/health');
      if (!health.nativeSessions) return { native: false };
      return bridge(
        '/sessions/fork',
        { ...p, sourceKey: keyFor(owner, source), targetKey: keyFor(owner, target) },
        30000,
      );
    },
  });
  const messageSchema = z
    .object({
      id: uuid,
      conversationId: uuid,
      input: z.string().trim().min(1).max(8000),
      projectId: projectIdSchema.nullable().default(null),
      access: z.enum(['read', 'edit']).default('read'),
      thinkingLevel: z.enum(['off', 'low', 'high', 'max']).default('off'),
      attachments: z.array(uuid).max(8).default([]),
      mode: z.enum(['queue', 'steer']).default('queue'),
      parentId: uuid.nullable().default(null),
    })
    .strict();
  const tasks = createPiTasks(store.db, {
    onEvent: (owner, task, event) => {
      // A completed reply starts a fresh idle window, even when generation took
      // longer than the configured lifetime. Polling never extends the window.
      if (
        helperLifetimesReady &&
        task.assistance === 'selection' &&
        ['done', 'cancelled'].includes(task.status)
      )
        store.db
          .prepare('UPDATE pi_assistance_lifetimes SET last_active=? WHERE owner=? AND id=?')
          .run(now(), owner, task.conversationId);
      options.notifications?.task(owner, task, event);
    },
    maxConcurrent: concurrency,
    maxConcurrentPerUser: limits.maxConcurrentPerUser,
    activeCount: activeFor,
    available: (owner, task) =>
      piReady &&
      activePi.size < concurrency &&
      !activePi.has(`${owner}:${task.conversationId}`) &&
      !cleaningHelpers.has(`${owner}:${task.conversationId}`),
    completed: (owner, id) =>
      accounts.piTurn(owner, id) ||
      store.db
        .prepare(
          "SELECT 1 FROM pi_turns,json_each(COALESCE(supplements,'[]')) WHERE owner=? AND json_extract(json_each.value,'$.id')=? LIMIT 1",
        )
        .get(owner, id),
    cancel: async (owner, task) => {
      await options.terminals?.revoke(owner, task.id);
      options.sandboxNetwork?.revokeTask(owner, task.id);
      options.mailAgent?.revoke(owner, task.id);
      options.appFunctions?.revoke(owner, task.id);
      return bridge('/cancel', { sessionKey: keyFor(owner, task.conversationId) });
    },
    respond: async (owner, task, response) => {
      if (await options.terminals?.respond(owner, task, response)) return;
      if (await options.mailAgent?.respond(owner, task, response)) return;
      return bridge('/ui-response', {
        sessionKey: keyFor(owner, task.conversationId),
        requestId: task.id,
        ...response,
      });
    },
    prepareQuestionResume: async (owner, task) => {
      const actor = accounts.profile(owner);
      if (task.projectId) await projectFor(actor, task.projectId, task.access);
      chatFiles.selected(owner, task.conversationId, task.attachments);
      await bridge('/cancel', {
        sessionKey: keyFor(owner, task.conversationId),
        requestId: task.id,
      });
      if (task.projectId) await projectFor(accounts.profile(owner), task.projectId, task.access);
      chatFiles.selected(owner, task.conversationId, task.attachments);
    },
    async steer(owner, task) {
      const parent = tasks.get(owner, task.parentId);
      if (
        !parent ||
        parent.status !== 'running' ||
        !activePi.has(`${owner}:${task.conversationId}`)
      )
        throw fail(409, '当前任务已经结束，请将补充作为下一条消息发送。');
      const payload = {
        sessionKey: keyFor(owner, task.conversationId),
        requestId: task.parentId,
        id: task.id,
        input: task.input,
        attachmentIds: task.attachments,
        files: chatFiles.modelFiles(owner, task.conversationId, task.attachments),
      };
      const until = Date.now() + 60000;
      while (true) {
        try {
          await bridge('/steer', payload, 20000);
          return;
        } catch (e) {
          if (
            e.status !== 503 ||
            Date.now() >= until ||
            tasks.get(owner, task.parentId)?.status !== 'running'
          )
            throw e;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    },
    async run(owner, p, event) {
      if (cleaningHelpers.has(`${owner}:${p.conversationId}`))
        throw fail(409, '临时对话正在清理，请重新打开后发送。');
      activePi.add(`${owner}:${p.conversationId}`);
      const goalAccess = !p.assistance ? options.goals?.grant(owner, p) : null;
      const sandboxAccess = !p.assistance ? options.sandboxNetwork?.scope(owner, p) : null;
      const appAccess = !p.assistance ? options.appFunctions?.scope(owner, p) : null;
      const mailAccess =
        !p.assistance || p.assistance === 'mail-manage'
          ? options.mailAgent?.scope(owner, p, (e) => tasks.approvalEvent(owner, p.id, e))
          : null;
      try {
        const actor = accounts.profile(owner);
        const canManage = !p.assistance && actor.role === 'owner';
        const hostAccess = canManage
          ? options.terminals?.scope(owner, p, (e) => tasks.approvalEvent(owner, p.id, e))
          : undefined;
        if (p.projectId) {
          await projectFor(actor, p.projectId, p.access);
        }
        const parentContext = p.assistanceSource
          ? await assistanceContext.read(owner, p.assistanceSource)
          : null;
        const attachments = chatFiles.selected(owner, p.conversationId, p.attachments);
        const result = await streamBridge(
          {
            canManageSkills: canManage,
            projectPrincipal: principalFor(actor),
            ...(goalAccess ? { goalAccess: { url: goalAccess.url, token: goalAccess.token } } : {}),
            ...(hostAccess ? { hostAccess } : {}),
            ...(sandboxAccess
              ? { sandboxAccess: { url: sandboxAccess.url, token: sandboxAccess.token } }
              : {}),
            ...(appAccess ? { appAccess: { url: appAccess.url, token: appAccess.token } } : {}),
            ...(mailAccess ? { mailAccess: { url: mailAccess.url, token: mailAccess.token } } : {}),
            sessionKey: keyFor(owner, p.conversationId),
            ownerId: owner,
            conversationId: p.conversationId,
            requestId: p.id,
            input: assistancePrompt(p.input, parentContext),
            ...(p.resumeQuestion ? { resumeQuestion: p.resumeQuestion } : {}),
            history: [
              ...(!p.assistance
                ? (await options
                    .unified?.()
                    ?.handoff(owner, { origin: 'server', nativeId: p.conversationId })) || []
                : []),
              ...accounts.piTranscript(owner, p.conversationId),
            ],
            thinkingLevel: p.thinkingLevel,
            files: chatFiles.modelFiles(owner, p.conversationId, p.attachments),
            attachmentIds: p.attachments,
            ...(p.toolAllowlist ? { toolAllowlist: p.toolAllowlist } : {}),
            ...(p.projectId ? { projectId: p.projectId, access: p.access } : {}),
          },
          null,
          event,
        );
        const output = z.string().trim().min(1).max(48000).parse(result.output);
        const tools = toolsSchema.parse(result.tools || []);
        const artifacts = [];
        for (const [i, file] of decodeExportFiles(result.exports).entries()) {
          const hex = createHash('sha256').update(`${owner}:${p.id}:${i}`).digest('hex');
          const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
          artifacts.push(await chatFiles.save(owner, p.conversationId, file.name, file.bytes, id));
        }
        const supplements = tasks
          .all(owner)
          .filter((t) => t.parentId === p.id && t.status === 'applied')
          .map((t) => ({
            id: t.id,
            input: t.input,
            attachments: chatFiles.selected(owner, t.conversationId, t.attachments),
          }));
        const timeline = tasks.get(owner, p.id)?.timeline || [];
        if (
          timeline.length &&
          !timeline.some((item) => item.kind === 'text' && item.text.trim() === output.trim())
        )
          timeline.push({ kind: 'text', text: output });
        const current = tasks.get(owner, p.id);
        const execution = {
          startedAt: current?.startedAt,
          finishedAt: new Date().toISOString(),
          metrics: current?.metrics,
          context: result.context || null,
          runtimeWarnings: current?.runtimeWarnings || [],
        };
        accounts.savePiTurn(
          owner,
          { ...p, attachments, artifacts, supplements, execution },
          output,
          tools,
          (result.thinking || '').slice(0, 48000),
          timeline,
        );
        sessionContext.task(owner, p.conversationId, result.context);
        if (!p.assistance) {
          conversationMetadata.create(owner, p.conversationId, p);
          titles.consider(owner, p, output);
        }
        return {
          output,
          artifacts,
          thinking: (result.thinking || '').slice(0, 48000),
          tools,
          timeline,
          context: result.context || null,
          execution,
        };
      } finally {
        goalAccess?.revoke();
        sandboxAccess?.revoke();
        mailAccess?.revoke();
        appAccess?.revoke();
        await options.terminals?.revoke(owner, p.id);
        activePi.delete(`${owner}:${p.conversationId}`);
      }
    },
  });
  store.db.exec(
    `CREATE TABLE IF NOT EXISTS pi_assistance_conversations(owner TEXT NOT NULL,id TEXT NOT NULL,kind TEXT NOT NULL,PRIMARY KEY(owner,id));
     CREATE TABLE IF NOT EXISTS pi_assistance_sources(owner TEXT NOT NULL,id TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(owner,id));
     CREATE TABLE IF NOT EXISTS pi_assistance_parents(owner TEXT NOT NULL,parent_key TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(owner,parent_key));
     CREATE TABLE IF NOT EXISTS pi_assistance_preferences(owner TEXT NOT NULL,parent_key TEXT NOT NULL,ttl_hours INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(owner,parent_key));
     CREATE TABLE IF NOT EXISTS pi_assistance_lifetimes(owner TEXT NOT NULL,id TEXT NOT NULL,last_active INTEGER NOT NULL,retained INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(owner,id));
     CREATE TABLE IF NOT EXISTS pi_assistance_expirations(owner TEXT NOT NULL,parent_key TEXT NOT NULL,id TEXT NOT NULL,expired_at INTEGER NOT NULL,PRIMARY KEY(owner,parent_key,id));`,
  );
  // Legacy temporary histories get an initial idle window. Records explicitly
  // saved to the main list remain retained even if they are archived later.
  store.db
    .prepare(
      `INSERT OR IGNORE INTO pi_assistance_lifetimes(owner,id,last_active,retained)
      SELECT a.owner,a.id,?,CASE WHEN c.id IS NOT NULL AND c.archived_at IS NULL THEN 1 ELSE 0 END
      FROM pi_assistance_conversations a LEFT JOIN pi_conversations c ON c.owner=a.owner AND c.id=a.id WHERE a.kind='selection'`,
    )
    .run(now());
  helperLifetimesReady = true;
  const parentIdentity = (owner, source) => {
    const segment = store.db
      .prepare(
        'SELECT display_id FROM assistant_segments WHERE owner=? AND origin=? AND native_id=?',
      )
      .get(owner, source.origin, source.id);
    if (!segment)
      return { key: JSON.stringify(['native', source.origin, source.id]), aliases: [], source };
    const first = store.db
      .prepare(
        'SELECT origin,native_id FROM assistant_segments WHERE owner=? AND display_id=? ORDER BY ordinal LIMIT 1',
      )
      .get(owner, segment.display_id);
    const aliases = store.db
      .prepare(
        'SELECT origin,native_id FROM assistant_segments WHERE owner=? AND display_id=? ORDER BY ordinal',
      )
      .all(owner, segment.display_id)
      .map((ref) => JSON.stringify(['native', ref.origin, ref.native_id]));
    return {
      key: JSON.stringify(['display', segment.display_id]),
      aliases,
      source: { origin: first.origin, id: first.native_id },
    };
  };
  const lifetimeSchema = z
    .object({
      source: assistanceSourceSchema,
      ttlHours: z.union([z.literal(1), z.literal(6), z.literal(24), z.literal(168)]),
    })
    .strict();
  const helperSaved = (owner, id) => {
    const lifetime = store.db
      .prepare('SELECT retained FROM pi_assistance_lifetimes WHERE owner=? AND id=?')
      .get(owner, id);
    const metadata = conversationMetadata.get(owner, id);
    return !!lifetime?.retained || !!(metadata && !metadata.archivedAt);
  };
  const helperBusy = (owner, id) =>
    activePi.has(`${owner}:${id}`) ||
    !!helperOperations.get(`${owner}:${id}`) ||
    !!store.db
      .prepare(
        `SELECT 1 FROM pi_tasks WHERE owner=? AND conversation_id=? AND (
        COALESCE(json_extract(state,'$.status'),'') NOT IN ('done','error','cancelled') OR
        (json_extract(state,'$.status')='error' AND (
          instr(COALESCE(json_extract(state,'$.error'),''),'未确认')>0 OR
          instr(COALESCE(json_extract(state,'$.error'),''),'中断')>0 OR
          instr(COALESCE(json_extract(state,'$.error'),''),'不完整')>0 OR
          instr(COALESCE(json_extract(state,'$.error'),''),'超时')>0 OR
          instr(COALESCE(json_extract(state,'$.error'),''),'未知')>0
        ))
      ) LIMIT 1`,
      )
      .get(owner, id) ||
    !!store.db
      .prepare(
        `SELECT 1 FROM pi_jobs WHERE owner=? AND conversation_id=? AND status NOT IN ('done','error','cancelled') LIMIT 1`,
      )
      .get(owner, id);
  async function helperOperation(owner, id, work) {
    const key = `${owner}:${id}`;
    if (
      cleaningHelpers.has(key) ||
      store.db
        .prepare('SELECT 1 FROM pi_closed_conversations WHERE owner=? AND conversation_id=?')
        .get(owner, id)
    )
      throw fail(409, '对话已关闭或正在清理，请重新打开后操作。');
    helperOperations.set(key, (helperOperations.get(key) || 0) + 1);
    try {
      return await work();
    } finally {
      const remaining = helperOperations.get(key) - 1;
      if (remaining) helperOperations.set(key, remaining);
      else helperOperations.delete(key);
    }
  }
  function helperLifetime(owner, id, parent) {
    const preference = store.db
      .prepare('SELECT ttl_hours FROM pi_assistance_preferences WHERE owner=? AND parent_key=?')
      .get(owner, parent.key);
    const prior = parent.aliases
      .map((key) =>
        store.db
          .prepare('SELECT ttl_hours FROM pi_assistance_preferences WHERE owner=? AND parent_key=?')
          .get(owner, key),
      )
      .find(Boolean);
    const ttlHours = preference?.ttl_hours || prior?.ttl_hours || 1;
    const row = store.db
      .prepare('SELECT last_active FROM pi_assistance_lifetimes WHERE owner=? AND id=?')
      .get(owner, id);
    const saved = helperSaved(owner, id);
    return {
      ttlHours,
      expiresAt:
        saved || helperBusy(owner, id) ? null : (row?.last_active ?? now()) + ttlHours * 3600000,
      saved,
    };
  }
  function helperParent(owner, id) {
    const source = store.db
      .prepare('SELECT source FROM pi_assistance_sources WHERE owner=? AND id=?')
      .get(owner, id);
    if (source) return parentIdentity(owner, JSON.parse(source.source));
    const binding = store.db
      .prepare(
        'SELECT parent_key FROM pi_assistance_parents WHERE owner=? AND id=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(owner, id);
    if (!binding) return { key: JSON.stringify(['legacy', id]), aliases: [] };
    const key = JSON.parse(binding.parent_key);
    if (key[0] === 'native') return parentIdentity(owner, { origin: key[1], id: key[2] });
    return { key: binding.parent_key, aliases: [] };
  }
  function touchHelper(owner, id) {
    store.db
      .prepare(
        `INSERT INTO pi_assistance_lifetimes(owner,id,last_active) VALUES(?,?,?)
      ON CONFLICT(owner,id) DO UPDATE SET last_active=excluded.last_active`,
      )
      .run(owner, id, now());
  }
  function expireHelper(owner, id) {
    const key = `${owner}:${id}`;
    if (cleaningHelpers.has(key)) return cleaningHelpers.get(key);
    const work = (async () => {
      // Always recheck after asynchronous calls. Retaining a record while the
      // bridge is being contacted must take precedence over automatic expiry.
      const due = () => {
        const row = store.db
          .prepare('SELECT last_active FROM pi_assistance_lifetimes WHERE owner=? AND id=?')
          .get(owner, id);
        if (!row || helperSaved(owner, id) || helperBusy(owner, id)) return false;
        return (
          row.last_active + helperLifetime(owner, id, helperParent(owner, id)).ttlHours * 3600000 <=
          now()
        );
      };
      if (communityClosed || !due()) return false;
      const health = await bridge('/health');
      if (communityClosed || !due()) return false;
      // A native deletion acknowledgement is required before any local history
      // is removed; older or unavailable bridges keep the entire record.
      if (health.nativeSessions !== true)
        throw fail(503, '暂时无法清理临时对话的原生会话，请稍后重试。');
      const result = await bridge('/sessions/delete', { sessionKey: keyFor(owner, id) });
      if (result.ok !== true) throw fail(502, '临时对话的原生会话清理尚未确认。');
      if (communityClosed || !due()) return false;
      // No submit/open/retention endpoint can enter this helper while it is
      // locked, so a successful native deletion cannot race a new prompt.
      tasks.closeConversation(owner, id);
      await chatFiles.removeConversation(owner, id);
      if (communityClosed) return false;
      store.db.exec('SAVEPOINT expire_helper');
      try {
        const parent = helperParent(owner, id);
        const keys = new Set([
          parent.key,
          ...parent.aliases,
          ...store.db
            .prepare('SELECT parent_key FROM pi_assistance_parents WHERE owner=? AND id=?')
            .all(owner, id)
            .map((row) => row.parent_key),
        ]);
        for (const parentKey of keys)
          store.db
            .prepare('INSERT OR REPLACE INTO pi_assistance_expirations VALUES(?,?,?,?)')
            .run(owner, parentKey, id, now());
        store.db
          .prepare(
            'DELETE FROM pi_submission_receipts WHERE owner=? AND id IN (SELECT id FROM pi_tasks WHERE owner=? AND conversation_id=? UNION SELECT id FROM pi_turns WHERE owner=? AND conversation_id=?)',
          )
          .run(owner, owner, id, owner, id);
        accounts.deletePiConversation(owner, id);
        conversationMetadata.remove(owner, id);
        sessionContext.remove(owner, id);
        store.db
          .prepare(
            'DELETE FROM pi_task_events WHERE owner=? AND task_id IN (SELECT id FROM pi_tasks WHERE owner=? AND conversation_id=?)',
          )
          .run(owner, owner, id);
        store.db.prepare('DELETE FROM pi_tasks WHERE owner=? AND conversation_id=?').run(owner, id);
        store.db.prepare('DELETE FROM pi_jobs WHERE owner=? AND conversation_id=?').run(owner, id);
        for (const table of [
          'pi_assistance_sources',
          'pi_assistance_conversations',
          'pi_assistance_parents',
          'pi_assistance_lifetimes',
        ])
          store.db.prepare(`DELETE FROM ${table} WHERE owner=? AND id=?`).run(owner, id);
        store.db
          .prepare(
            "DELETE FROM agent_conversation_bindings WHERE owner=? AND origin='server' AND conversation_id=?",
          )
          .run(owner, id);
        options.unified?.()?.nativeDeleted(owner, { origin: 'server', nativeId: id });
        store.db.exec('RELEASE expire_helper');
      } catch (error) {
        store.db.exec('ROLLBACK TO expire_helper; RELEASE expire_helper');
        throw error;
      }
      return true;
    })();
    cleaningHelpers.set(key, work);
    void work
      .finally(() => {
        if (cleaningHelpers.get(key) === work) cleaningHelpers.delete(key);
      })
      .catch(() => {});
    return work;
  }
  async function lifetimePreferences(owner, input) {
    const p = lifetimeSchema.parse(input);
    limit(`pi-assist-preferences:${owner}`, 60);
    await assistanceContext.read(owner, p.source);
    const parent = parentIdentity(owner, p.source);
    // A helper may still be reserved by its original native key when its
    // parent first enters unified navigation. Reuse that reservation exactly
    // as the status/open paths do; changing a preference must renew it too.
    const find = () =>
      [parent.key, ...parent.aliases]
        .map((key) =>
          store.db
            .prepare('SELECT id FROM pi_assistance_parents WHERE owner=? AND parent_key=?')
            .get(owner, key),
        )
        .find(Boolean);
    const bound = find();
    if (bound && cleaningHelpers.has(`${owner}:${bound.id}`))
      await cleaningHelpers.get(`${owner}:${bound.id}`);
    store.db
      .prepare(
        `INSERT INTO pi_assistance_preferences VALUES(?,?,?) ON CONFLICT(owner,parent_key) DO UPDATE SET ttl_hours=excluded.ttl_hours`,
      )
      .run(owner, parent.key, p.ttlHours);
    for (const alias of parent.aliases)
      store.db
        .prepare(
          `INSERT INTO pi_assistance_preferences VALUES(?,?,?) ON CONFLICT(owner,parent_key) DO UPDATE SET ttl_hours=excluded.ttl_hours`,
        )
        .run(owner, alias, p.ttlHours);
    const current = find();
    if (current) touchHelper(owner, current.id);
    return current
      ? helperLifetime(owner, current.id, parent)
      : { ttlHours: p.ttlHours, expiresAt: null, saved: false };
  }
  async function lifetimeStatus(owner, input) {
    const p = z.object({ source: assistanceSourceSchema }).strict().parse(input);
    limit(`pi-assist-status:${owner}`, 60);
    await assistanceContext.read(owner, p.source);
    const parent = parentIdentity(owner, p.source);
    const keys = [parent.key, ...parent.aliases];
    const find = () =>
      keys
        .map((key) =>
          store.db
            .prepare('SELECT id FROM pi_assistance_parents WHERE owner=? AND parent_key=?')
            .get(owner, key),
        )
        .find(Boolean);
    const before = find();
    if (before) await expireHelper(owner, before.id);
    const bound = find();
    return {
      conversationId: bound?.id || null,
      ...helperLifetime(owner, bound?.id || '', parent),
      expiredConversationIds: [
        ...new Set(
          keys.flatMap((key) =>
            store.db
              .prepare(
                'SELECT id FROM pi_assistance_expirations WHERE owner=? AND parent_key=? ORDER BY expired_at DESC LIMIT 2000',
              )
              .all(owner, key)
              .map((row) => row.id),
          ),
        ),
      ],
    };
  }
  async function selectionSession(owner, input) {
    const p = z.object({ source: assistanceSourceSchema }).strict().parse(input);
    limit(`pi-assist-session:${owner}`, 60);
    // Opening/reopening is a read operation: validate every original location,
    // but never submit a task or grant main-conversation tools to the helper.
    await assistanceContext.read(owner, p.source);
    const parent = parentIdentity(owner, p.source);
    let bound = store.db
      .prepare('SELECT id FROM pi_assistance_parents WHERE owner=? AND parent_key=?')
      .get(owner, parent.key);
    if (bound) {
      await expireHelper(owner, bound.id);
      bound = store.db
        .prepare('SELECT id FROM pi_assistance_parents WHERE owner=? AND parent_key=?')
        .get(owner, parent.key);
    }
    if (
      bound &&
      store.db
        .prepare('SELECT 1 FROM pi_closed_conversations WHERE owner=? AND conversation_id=?')
        .get(owner, bound.id)
    ) {
      store.db
        .prepare('DELETE FROM pi_assistance_parents WHERE owner=? AND parent_key=?')
        .run(owner, parent.key);
      bound = null;
    }
    if (!bound) {
      const old = store.db
        .prepare(
          `SELECT s.id,s.source FROM pi_assistance_sources s
        JOIN pi_assistance_conversations c ON c.owner=s.owner AND c.id=s.id AND c.kind='selection'
        WHERE s.owner=? AND NOT EXISTS(SELECT 1 FROM pi_closed_conversations x WHERE x.owner=s.owner AND x.conversation_id=s.id)
        ORDER BY s.rowid DESC`,
        )
        .all(owner)
        .find((row) => parentIdentity(owner, JSON.parse(row.source)).key === parent.key);
      // A main chat may enter unified navigation after its helper was opened.
      // Reuse its reserved native binding even before the first helper message.
      const reserved = parent.aliases
        .map((key) =>
          store.db
            .prepare(
              'SELECT p.id FROM pi_assistance_parents p WHERE p.owner=? AND p.parent_key=? AND NOT EXISTS(SELECT 1 FROM pi_closed_conversations x WHERE x.owner=p.owner AND x.conversation_id=p.id)',
            )
            .get(owner, key),
        )
        .find(Boolean);
      const id = reserved?.id || old?.id || randomUUID();
      store.db
        .prepare('INSERT INTO pi_assistance_parents(owner,parent_key,id) VALUES(?,?,?)')
        .run(owner, parent.key, id);
      bound = { id };
    }
    // Migration of a legacy or native-only reservation must apply the same
    // expiry check as a binding that was already indexed by display ID.
    await expireHelper(owner, bound.id);
    if (
      store.db
        .prepare('SELECT 1 FROM pi_closed_conversations WHERE owner=? AND conversation_id=?')
        .get(owner, bound.id)
    ) {
      const id = randomUUID();
      store.db
        .prepare('INSERT OR REPLACE INTO pi_assistance_parents VALUES(?,?,?)')
        .run(owner, parent.key, id);
      bound = { id };
    }
    touchHelper(owner, bound.id);
    const source = store.db
      .prepare('SELECT source FROM pi_assistance_sources WHERE owner=? AND id=?')
      .get(owner, bound.id);
    return {
      conversationId: bound.id,
      source: source ? JSON.parse(source.source) : parent.source,
      turns: accounts.piHistory(owner, bound.id),
      tasks: tasks.all(owner).filter((task) => task.conversationId === bound.id),
      ...helperLifetime(owner, bound.id, parent),
      expiredConversationIds: store.db
        .prepare(
          'SELECT id FROM pi_assistance_expirations WHERE owner=? AND parent_key=? ORDER BY expired_at DESC LIMIT 2000',
        )
        .all(owner, parent.key)
        .map((row) => row.id),
    };
  }
  async function assist(owner, input) {
    const p = z
      .object({
        id: uuid,
        conversationId: uuid,
        input: z.string().trim().min(1).max(8000),
        kind: z.enum(['selection', 'mail', 'mail-manage']),
        source: assistanceSourceSchema.optional(),
      })
      .strict()
      .parse(input);
    if (cleaningHelpers.has(`${owner}:${p.conversationId}`))
      throw fail(409, '临时对话正在清理，请重新打开后发送。');
    if (!piReady) throw fail(503, '远程 Pi 尚未配置。');
    if (
      p.source &&
      (p.kind !== 'selection' || (p.source.origin === 'server' && p.source.id === p.conversationId))
    )
      throw fail(400, '临时对话来源无效。');
    if (
      p.kind === 'selection' &&
      store.db
        .prepare('SELECT 1 FROM pi_assistance_lifetimes WHERE owner=? AND id=?')
        .get(owner, p.conversationId)
    )
      await expireHelper(owner, p.conversationId);
    if (
      store.db
        .prepare('SELECT 1 FROM pi_closed_conversations WHERE owner=? AND conversation_id=?')
        .get(owner, p.conversationId)
    )
      throw fail(409, '此临时对话已删除。');
    let existing = store.db
      .prepare('SELECT kind FROM pi_assistance_conversations WHERE owner=? AND id=?')
      .get(owner, p.conversationId);
    if (existing && existing.kind !== p.kind) throw fail(409, '临时对话用途不匹配。');
    const sourceRow = store.db
      .prepare('SELECT source FROM pi_assistance_sources WHERE owner=? AND id=?')
      .get(owner, p.conversationId);
    const source = sourceRow ? JSON.parse(sourceRow.source) : p.source || null;
    const assertReservation = () => {
      const reservations = store.db
        .prepare('SELECT parent_key FROM pi_assistance_parents WHERE owner=? AND id=?')
        .all(owner, p.conversationId);
      if (!reservations.length) return;
      if (p.kind !== 'selection' || !source) throw fail(409, '临时对话不能更换所属主对话或用途。');
      const parent = parentIdentity(owner, source),
        keys = new Set([parent.key, ...parent.aliases]);
      if (reservations.some((row) => !keys.has(row.parent_key)))
        throw fail(409, '临时对话不能更换所属主对话。');
    };
    assertReservation();
    if (sourceRow && p.source && JSON.stringify(source) !== JSON.stringify(p.source))
      throw fail(409, '临时对话不能更换所属主对话。');
    if (existing && !sourceRow && p.source) throw fail(409, '已有临时对话不能更换来源。');
    const acceptedTask = () => {
      const oldTask = tasks.get(owner, p.id);
      if (!oldTask) return null;
      if (
        oldTask.conversationId !== p.conversationId ||
        oldTask.input !== p.input ||
        oldTask.assistance !== p.kind ||
        JSON.stringify(oldTask.assistanceSource || null) !== JSON.stringify(source)
      )
        throw fail(409, '这条请求已存在不同内容。');
      return oldTask;
    };
    const oldTask = acceptedTask();
    if (oldTask) return oldTask;
    const snapshot = source ? await assistanceContext.read(owner, source) : null;
    assistancePrompt(p.input, snapshot);
    // Parent-project verification can await a bridge request. Another first
    // submission may have bound this helper meanwhile; recheck before creating
    // anything, and return the accepted task for an identical concurrent retry.
    existing = store.db
      .prepare('SELECT kind FROM pi_assistance_conversations WHERE owner=? AND id=?')
      .get(owner, p.conversationId);
    const currentSource = store.db
      .prepare('SELECT source FROM pi_assistance_sources WHERE owner=? AND id=?')
      .get(owner, p.conversationId);
    if (existing && existing.kind !== p.kind) throw fail(409, '临时对话用途不匹配。');
    if (
      (currentSource &&
        JSON.stringify(JSON.parse(currentSource.source)) !== JSON.stringify(source)) ||
      (existing && !currentSource && source)
    )
      throw fail(409, '临时对话不能更换所属主对话。');
    if (
      store.db
        .prepare('SELECT 1 FROM pi_closed_conversations WHERE owner=? AND conversation_id=?')
        .get(owner, p.conversationId)
    )
      throw fail(409, '此临时对话已删除。');
    assertReservation();
    const concurrentTask = acceptedTask();
    if (concurrentTask) return concurrentTask;
    if (cleaningHelpers.has(`${owner}:${p.conversationId}`))
      throw fail(409, '临时对话正在清理，请重新打开后发送。');
    if (
      !existing &&
      (conversationMetadata.get(owner, p.conversationId) ||
        accounts.piScope(owner, p.conversationId))
    )
      throw fail(409, '请为辅助对话使用独立上下文。');
    if (!existing) {
      conversationMetadata.create(owner, p.conversationId);
      conversationMetadata.patch(owner, p.conversationId, {
        title:
          p.kind === 'mail'
            ? '邮件撰写助手'
            : p.kind === 'mail-manage'
              ? '邮件管理助手'
              : '划选临时对话',
        archived: true,
      });
      store.db
        .prepare('INSERT INTO pi_assistance_conversations VALUES(?,?,?)')
        .run(owner, p.conversationId, p.kind);
      if (source)
        store.db
          .prepare('INSERT INTO pi_assistance_sources VALUES(?,?,?)')
          .run(owner, p.conversationId, JSON.stringify(source));
    }
    limit(`pi-assist:${owner}`, 20);
    const task = tasks.add(owner, {
      ...messageSchema.parse({ id: p.id, conversationId: p.conversationId, input: p.input }),
      assistance: p.kind,
      ...(source ? { assistanceSource: source } : {}),
      toolAllowlist: p.kind === 'mail-manage' ? ['mail_manage'] : [],
    });
    if (p.kind === 'selection') touchHelper(owner, p.conversationId);
    return task;
  }
  let sweeping = false;
  const helperTimer = setInterval(async () => {
    if (communityClosed || sweeping) return;
    sweeping = true;
    try {
      const rows = store.db
        .prepare('SELECT owner,id FROM pi_assistance_lifetimes WHERE retained=0 AND last_active<=?')
        .all(now() - 3600000);
      for (const row of rows) {
        if (communityClosed) break;
        try {
          await expireHelper(row.owner, row.id);
        } catch {
          /* Retain records until native deletion is confirmed. */
        }
      }
    } finally {
      sweeping = false;
    }
  }, options.temporaryChatSweepMs ?? 60000);
  helperTimer.unref();
  const scheduled = createPiSchedulePump({
    bridge,
    tasks,
    ownerAllowed: (owner) =>
      store.db.prepare('SELECT role FROM users WHERE id=?').get(owner)?.role === 'owner',
    scope: (owner, id) => {
      options
        .unified?.()
        ?.assertWritable(owner, { origin: 'server', nativeId: id }, { switchingStatus: 503 });
      return accounts.piScope(owner, id) || tasks.scope(owner, id);
    },
    completed: (owner, id) => accounts.piTurn(owner, id),
    computer: (run) => options.scheduleComputer?.(run),
  });
  const unifiedList = (owner) =>
    conversationList({
      history: accounts.piConversations(owner),
      tasks: tasks.all(owner).filter((t) => !t.assistance),
      metadata: conversationMetadata.list(owner),
    })
      .filter(
        (c) =>
          !store.db
            .prepare('SELECT 1 FROM pi_assistance_conversations WHERE owner=? AND id=?')
            .get(owner, c.id) || !c.archivedAt,
      )
      .map((c) => {
        const live = tasks
          .all(owner)
          .find(
            (t) =>
              t.conversationId === c.id &&
              ['queued', 'running', 'stopping', 'delivering', 'accepted', 'interrupted'].includes(
                t.status,
              ),
          );
        return {
          ...c,
          runtime: serverPiRuntime(owner, c.id, c.projectId),
          runState: live
            ? { ...agentRunState(live), busy: true }
            : { busy: activePi.has(`${owner}:${c.id}`), label: '' },
        };
      });
  return {
    unified: {
      list: (actor) => unifiedList(actor.id),
      projects: projectsFor,
      visible: (owner, ref) =>
        assistanceContext.read(owner, { origin: ref.origin, id: ref.nativeId }),
      async state(actor, id) {
        const c = unifiedList(actor.id).find((c) => c.id === id);
        if (!c) throw fail(404, '对话不存在。');
        if (c.projectId) await projectFor(actor, c.projectId);
        if (!piReady) throw fail(503, 'Pi尚未配置。');
        const pending = tasks
          .all(actor.id)
          .filter(
            (t) =>
              t.conversationId === id &&
              ['queued', 'running', 'stopping', 'delivering', 'accepted', 'interrupted'].includes(
                t.status,
              ),
          );
        const t = pending[0];
        return t
          ? { ...agentRunState(t), busy: true }
          : { busy: activePi.has(`${actor.id}:${id}`), label: '正在核对任务' };
      },
    },
    async manageSchedule(ctx, input, callId, computerJob) {
      if (store.db.prepare('SELECT role FROM users WHERE id=?').get(ctx.owner)?.role !== 'owner')
        throw fail(403, '当前仅管理员可使用定时任务。');
      const task = ctx.origin === 'computer' ? computerJob : tasks.get(ctx.owner, ctx.task);
      if (
        !task ||
        task.id !== ctx.task ||
        task.conversationId !== ctx.conversation ||
        task.status !== 'running' ||
        task.assistance
      )
        throw fail(403, '定时任务必须由当前运行中的主对话创建或管理。');
      const context = {
        ownerId: ctx.owner,
        conversationId: task.conversationId,
        projectId: task.projectId || null,
        access: task.access || 'read',
        thinkingLevel: task.thinkingLevel || 'off',
        target:
          ctx.origin === 'computer'
            ? { kind: 'computer', deviceId: task.deviceId, execute: !!task.execute }
            : { kind: 'server' },
      };
      return bridge('/schedules/manage', { context, data: cronAction(input, callId) }, 25000);
    },
    chatFiles,
    accounts,
    piReady,
    assist,
    assistancePreferences: lifetimePreferences,
    close: () => {
      communityClosed = true;
      clearInterval(helperTimer);
      titles.close();
      scheduled.close();
      tasks.close();
    },
    async before(req, url, json) {
      const path = url.pathname;
      if (path === '/api/auth/status' && req.method === 'GET') {
        json(200, { initialized: accounts.initialized(), registration: 'invite' });
        return true;
      }
      if (
        ['/api/auth/bootstrap', '/api/auth/register', '/api/auth/login'].includes(path) &&
        req.method === 'POST'
      ) {
        limit(
          `auth:${clientAddress(req, options.trustedProxyIPs ?? process.env.TRUSTED_PROXY_IPS ?? '')}`,
          20,
          15 * 60000,
        );
        if (path.endsWith('/login')) {
          const p = z
            .object({ username, password: z.string().min(1).max(128) })
            .strict()
            .parse(await body(req));
          limit(`login:${p.username}`, 8, 15 * 60000);
          json(200, await accounts.login(p));
        } else if (path.endsWith('/bootstrap')) {
          const p = z
            .object({ username, password, displayName, adminToken: z.string().max(256) })
            .strict()
            .parse(await body(req));
          if (!equal(p.adminToken, token)) throw fail(403, '管理员令牌不正确。');
          json(201, await accounts.register(p, true));
        } else {
          const p = z
            .object({ username, password, displayName, invite: z.string().max(128) })
            .strict()
            .parse(await body(req));
          json(201, await accounts.register(p));
        }
        return true;
      }
      return false;
    },
    async after(req, url, json, actor, res) {
      const path = url.pathname,
        method = req.method;
      if (!['/api/auth/', '/api/social/', '/api/pi/'].some((prefix) => path.startsWith(prefix)))
        return false;
      requireUser(actor);
      if (path === '/api/pi/assist/session' && method === 'POST') {
        json(200, await selectionSession(actor.id, await body(req)));
        return true;
      }
      if (path === '/api/pi/assist/preferences' && method === 'PATCH') {
        json(200, await lifetimePreferences(actor.id, await body(req)));
        return true;
      }
      if (path === '/api/pi/assist/preferences' && method === 'POST') {
        json(200, await lifetimeStatus(actor.id, await body(req)));
        return true;
      }
      if (path === '/api/pi/assist' && method === 'POST') {
        const task = await assist(actor.id, await body(req));
        json(202, {
          task,
          ...(task.assistance === 'selection'
            ? helperLifetime(
                actor.id,
                task.conversationId,
                helperParent(actor.id, task.conversationId),
              )
            : {}),
        });
        return true;
      }
      const sessionKey = (id) => createHash('sha256').update(`${actor.id}:${id}`).digest('hex');
      if (path === '/api/pi/tasks/updates' && method === 'GET') {
        const after = z.coerce
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .parse(url.searchParams.get('after') || '0');
        const result = await tasks.changes(actor.id, after, req, res);
        if (!res.destroyed) json(200, result);
        return true;
      }
      if (path === '/api/pi/tasks' && method === 'GET') {
        json(200, tasks.snapshot(actor.id));
        return true;
      }
      const uiRoute = path.match(/^\/api\/pi\/tasks\/([^/]+)\/ui$/);
      const questionResumeRoute = path.match(/^\/api\/pi\/tasks\/([^/]+)\/question-resume$/);
      if (questionResumeRoute && method === 'POST') {
        limit(`pi-question-resume:${actor.id}`, 30);
        const p = questionReplySchema.parse(await body(req));
        json(202, {
          task: await tasks.resumeQuestion(actor.id, uuid.parse(questionResumeRoute[1]), p),
        });
        return true;
      }
      if (uiRoute && method === 'POST') {
        const id = uuid.parse(uiRoute[1]);
        const p = z
          .object({
            id: z.string().min(1).max(200),
            cancelled: z.boolean().optional(),
            confirmed: z.boolean().optional(),
            approval: z.enum(['once', 'exact', 'similar', '15m', '60m', 'full']).optional(),
            value: z.string().max(12000).optional(),
          })
          .strict()
          .parse(await body(req));
        limit(`pi-ui:${actor.id}`, 60);
        json(200, { task: await tasks.respond(actor.id, id, p) });
        return true;
      }
      const taskRoute = path.match(/^\/api\/pi\/tasks\/([^/]+)$/);
      if (taskRoute) {
        const id = uuid.parse(taskRoute[1]);
        if (method === 'PATCH') {
          const p = z
            .object({
              input: z.string().trim().min(1).max(8000),
              revision: z.number().int().positive(),
            })
            .strict()
            .parse(await body(req));
          const task = tasks.get(actor.id, id);
          if (task && cleaningHelpers.has(`${actor.id}:${task.conversationId}`))
            throw fail(409, '临时对话正在清理，请重新打开后操作。');
          json(200, { task: tasks.edit(actor.id, id, p) });
          return true;
        }
        if (method === 'DELETE') {
          json(200, { task: await tasks.stop(actor.id, id) });
          return true;
        }
      }
      if (['/api/pi/tasks', '/api/pi/submissions'].includes(path) && method === 'POST') {
        const auto = path === '/api/pi/submissions';
        const raw = (
          auto
            ? messageSchema.extend({
                deliveryPreference: z.enum(['queue', 'steer']).default('steer'),
              })
            : messageSchema
        ).parse(await body(req));
        const { deliveryPreference, ...clean } = raw;
        let p = clean;
        if (cleaningHelpers.has(`${actor.id}:${p.conversationId}`))
          throw fail(409, '临时对话正在清理，请重新打开后发送。');
        const signature = JSON.stringify(raw);
        if (auto) {
          const receipt = store.db
            .prepare('SELECT input FROM pi_submission_receipts WHERE owner=? AND id=?')
            .get(actor.id, p.id);
          if (receipt) {
            if (receipt.input !== signature) throw fail(409, '这条发送请求已有不同内容。');
            const task = tasks.get(actor.id, p.id);
            if (!task) throw fail(409, '请求已有历史记录，不会重复执行。');
            json(200, { task });
            return true;
          }
        }
        if (branches.pending(actor.id, p.conversationId))
          throw fail(409, '分支上下文正在建立，请稍候发送。');
        if (tasks.get(actor.id, p.id)) {
          if (auto) throw fail(409, '此编号已有任务，请查看原任务。');
          json(200, { task: tasks.add(actor.id, p) });
          return true;
        }
        options
          .unified?.()
          ?.assertWritable(actor.id, { origin: 'server', nativeId: p.conversationId });
        if (!piReady) throw fail(503, '远程 Pi 尚未配置。');
        if (accounts.piTurn(actor.id, p.id) || accounts.piJob(actor.id, p.id))
          throw fail(409, '此请求已执行过，请查看历史。');
        if (p.projectId) await projectFor(actor, p.projectId, p.access);
        if (!p.projectId && p.access === 'edit') throw fail(400, '请先选择项目。');
        const scope =
          accounts.piScope(actor.id, p.conversationId) ||
          tasks.scope(actor.id, p.conversationId) ||
          conversationMetadata.get(actor.id, p.conversationId);
        if (scope && scope.projectId !== p.projectId)
          throw fail(409, '此对话已绑定其他项目，请建立新对话。');
        const pendingTask = tasks.live(actor.id, p.conversationId).find((t) => !t.parentId);
        if (
          (pendingTask && pendingTask.access !== p.access) ||
          (!pendingTask &&
            scope &&
            scope.access !== p.access &&
            activePi.has(`${actor.id}:${p.conversationId}`))
        )
          throw fail(409, '当前任务和队列结束后可切换模式。');
        const attachmentFiles = chatFiles.selected(actor.id, p.conversationId, p.attachments);
        if (auto) {
          const current = tasks
            .live(actor.id, p.conversationId)
            .find((t) => !t.parentId && t.status === 'running');
          p = {
            ...p,
            mode:
              (deliveryPreference === 'steer' ||
                (!p.attachments.length && longGoalControl(p.input))) &&
              current
                ? 'steer'
                : 'queue',
            parentId:
              (deliveryPreference === 'steer' ||
                (!p.attachments.length && longGoalControl(p.input))) &&
              current
                ? current.id
                : null,
          };
        }
        if (p.mode === 'steer') {
          const parent = tasks.get(actor.id, p.parentId);
          if (!parent || parent.conversationId !== p.conversationId || parent.status !== 'running')
            throw fail(409, '当前任务已经结束，请排到下一条。');
          if (parent.access !== p.access) throw fail(409, '任务补充必须沿用当前任务的模式。');
        } else if (p.parentId) throw fail(400, '排队消息不应绑定补充任务。');
        options
          .unified?.()
          ?.assertWritable(actor.id, { origin: 'server', nativeId: p.conversationId });
        limit(`pi-task:${actor.id}`, 30);
        if (cleaningHelpers.has(`${actor.id}:${p.conversationId}`))
          throw fail(409, '临时对话正在清理，请重新打开后发送。');
        if (auto) {
          let task;
          store.db.exec('BEGIN IMMEDIATE');
          try {
            task = tasks.add(actor.id, { ...p, attachmentFiles });
            store.db
              .prepare('INSERT INTO pi_submission_receipts VALUES(?,?,?)')
              .run(actor.id, p.id, signature);
            store.db.exec('COMMIT');
          } catch (e) {
            store.db.exec('ROLLBACK');
            throw e;
          }
          json(202, { task });
        } else json(202, { task: tasks.add(actor.id, { ...p, attachmentFiles }) });
        return true;
      }
      if (path === '/api/pi/skills') {
        if (method === 'GET') {
          const r = await bridge(actor.role === 'owner' ? '/skills?packages=1' : '/skills');
          json(200, {
            ...(actor.role === 'owner' ? { diagnostics: r.diagnostics, warning: r.warning } : {}),
            skills:
              actor.role === 'owner'
                ? r.skills
                : r.skills
                    .filter((s) => s.enabled)
                    .map(({ name, description }) => ({ name, description, enabled: true })),
          });
          return true;
        }
        if (method === 'POST') {
          if (actor.role !== 'owner') throw fail(403, '仅管理员可管理可执行技能。');
          const p = z
            .object({
              name: z
                .string()
                .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
                .max(64),
              description: z.string().trim().min(1).max(1024),
              instructions: z.string().max(60000),
              enabled: z.boolean(),
            })
            .strict()
            .parse(await body(req));
          json(200, await bridge('/skills', p));
          return true;
        }
      }
      const contextRoute = path.match(/^\/api\/pi\/conversations\/([^/]+)\/context$/);
      if (contextRoute && ['GET', 'POST'].includes(method)) {
        const id = uuid.parse(contextRoute[1]);
        const p =
          method === 'POST'
            ? z
                .object({
                  contextWindow: z.number().int().positive().max(100000000).nullable().optional(),
                  refresh: z.boolean().optional(),
                })
                .strict()
                .parse(await body(req))
            : {};
        limit(`pi-context:${actor.id}`, 30);
        if (p.refresh) limit(`pi-context-refresh:${actor.id}`, 6);
        json(
          200,
          await helperOperation(actor.id, id, () =>
            bridge('/sessions/context', { sessionKey: sessionKey(id), ...p }, 15000),
          ),
        );
        return true;
      }
      const nativeRoute = path.match(
        /^\/api\/pi\/conversations\/([^/]+)\/(inspect|compact|cancel)$/,
      );
      if (nativeRoute && method === 'POST') {
        const id = uuid.parse(nativeRoute[1]),
          action = nativeRoute[2];
        const p = z
          .object({
            projectId: projectIdSchema.nullable().optional(),
            access: z.enum(['read', 'edit']).default('read'),
          })
          .strict()
          .parse(await body(req));
        if (p.projectId) await projectFor(actor, p.projectId, p.access);
        const scope =
          accounts.piScope(actor.id, id) ||
          tasks.scope(actor.id, id) ||
          conversationMetadata.get(actor.id, id);
        if (scope && scope.projectId !== (p.projectId || null))
          throw fail(409, '对话的项目不一致。');
        if (action !== 'cancel' && activePi.has(`${actor.id}:${id}`))
          throw fail(409, '请等待当前请求结束。');
        limit(`pi-control:${actor.id}`, 20);
        const observation =
          action === 'inspect' || action === 'compact' ? sessionContext.begin(actor.id, id) : null;
        if (action !== 'cancel' && !observation) throw fail(409, '此对话已删除，请建立新对话。');
        const result = await helperOperation(actor.id, id, () =>
          bridge(
            action === 'cancel' ? '/cancel' : `/sessions/${action}`,
            {
              sessionKey: sessionKey(id),
              ownerId: actor.id,
              conversationId: id,
              canManageSkills: actor.role === 'owner',
              projectPrincipal: principalFor(actor),
              ...(p.projectId ? { projectId: p.projectId, access: p.access } : {}),
            },
            // Inspection starts a real Pi process and loads native packages.
            // Leave room for cold starts within the web client's 100s timeout;
            // cancellation keeps its shorter deadline and never retries work.
            action === 'compact' ? 190000 : action === 'inspect' ? 90000 : 15000,
          ),
        );
        if (observation) sessionContext.commit(actor.id, id, observation, result.context, action);
        json(
          200,
          action === 'inspect'
            ? { ...result, sessionContext: sessionContext.get(actor.id, id) }
            : result,
        );
        return true;
      }
      if (path === '/api/pi/projects' || path.startsWith('/api/pi/projects/')) {
        const projectBridge = (path, data, timeout = 10000) =>
          bridge(path, data, timeout, principalFor(actor));
        if (path === '/api/pi/projects' && method === 'GET') {
          json(200, await projectsFor(actor));
          return true;
        }
        if (path === '/api/pi/projects' && method === 'POST') {
          const p = z
            .object({
              name: z.string().trim().min(1).max(60),
              sourceId: projectIdSchema,
              path: z.string().min(1).max(500),
            })
            .strict()
            .parse(await body(req));
          const source = await projectFor(actor, p.sourceId, 'edit');
          if (actor.role !== 'owner' && (!source.userRoot || source.ownerId !== actor.id))
            throw fail(403, '只能在自己的用户名目录中新建项目。');
          json(201, await projectBridge('/projects', p));
          return true;
        }
        const labelRoute = path.match(/^\/api\/pi\/projects\/([^/]+)\/display-name$/);
        if (labelRoute && method === 'PUT') {
          requireUser(actor);
          limit('project-label:' + actor.id, 60);
          const id = projectIdSchema.parse(labelRoute[1]);
          await projectFor(actor, id);
          const p = projectLabelSchema.parse(await body(req));
          projectLabels.set(actor.id, 'server', id, p.name);
          json(200, { project: await projectFor(actor, id) });
          return true;
        }
        const memberRoute = path.match(/^\/api\/pi\/projects\/([^/]+)\/members$/);
        if (memberRoute) {
          if (actor.role !== 'owner') throw fail(403, '仅管理员可授权跨用户目录。');
          const id = projectIdSchema.parse(memberRoute[1]);
          await projectFor(actor, id);
          if (method === 'GET') {
            json(200, await projectBridge(`/projects/${id}/members`));
            return true;
          }
          if (method === 'POST') {
            const p = z
              .object({ username, access: z.enum(['read', 'edit']).nullable() })
              .strict()
              .parse(await body(req));
            const target = store.db
              .prepare("SELECT id,username FROM users WHERE username=? AND role='member'")
              .get(p.username);
            if (!target) throw fail(404, '请填写已注册的普通用户账号。');
            json(
              200,
              await projectBridge(`/projects/${id}/members`, {
                userId: target.id,
                username: target.username,
                access: p.access,
              }),
            );
            return true;
          }
        }
        const route = path.match(
          /^\/api\/pi\/projects\/([^/]+)\/(list|read|document|write|search|restore|diff|mkdir|grants)$/,
        );
        if (route) {
          const id = projectIdSchema.parse(route[1]),
            action = route[2];
          if (action === 'grants' && actor.role !== 'owner')
            throw fail(403, '仅管理员可增加跨目录授权。');
          await projectFor(
            actor,
            id,
            ['write', 'restore', 'mkdir'].includes(action) ? 'edit' : 'read',
          );
          if (method === 'POST' && action === 'write') {
            const p = z
              .object({
                path: z.string().min(1).max(500),
                content: z.string().max(262144),
                expectedHash: z.string().regex(/^(?:new|[a-f0-9]{64})$/),
              })
              .strict()
              .parse(await body(req));
            json(200, await projectBridge(`/projects/${id}/write`, p, 20000));
            return true;
          }
          if (method === 'POST' && ['mkdir', 'grants'].includes(action)) {
            const p = (
              action === 'mkdir'
                ? z.object({ path: z.string().min(1).max(500) }).strict()
                : z
                    .object({
                      grants: z
                        .array(
                          z
                            .object({
                              projectId: projectIdSchema,
                              access: z.enum(['read', 'edit']),
                            })
                            .strict(),
                        )
                        .max(8),
                    })
                    .strict()
            ).parse(await body(req));
            json(200, await projectBridge(`/projects/${id}/${action}`, p));
            return true;
          }
          if (method === 'GET' && action !== 'restore') {
            const query = new URLSearchParams();
            for (const key of ['path', 'startLine', 'query']) {
              const v = url.searchParams.get(key);
              if (v !== null) {
                if (v.length > 500) throw fail(400, '查询内容过长。');
                query.set(key, v);
              }
            }
            json(200, await projectBridge(`/projects/${id}/${action}?${query}`));
            return true;
          }
          if (method === 'POST' && (action === 'restore' || action === 'diff')) {
            const p = z
              .object({ backupId: uuid })
              .strict()
              .parse(await body(req));
            if (activePi.size && action === 'restore') throw fail(409, '请等待 Pi 完成本次任务。');
            json(200, await projectBridge(`/projects/${id}/${action}`, p));
            return true;
          }
        }
      }
      const job = path.match(/^\/api\/pi\/jobs\/([^/]+)$/);
      if (job && method === 'GET') {
        const result = accounts.piJob(actor.id, uuid.parse(job[1]));
        if (!result) throw fail(404, '任务记录不存在。');
        json(200, { job: result });
        return true;
      }
      if (path === '/api/auth/me' && method === 'GET') {
        json(200, { user: accounts.profile(actor.id) });
        return true;
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        accounts.logout(actor);
        json(200, { ok: true });
        return true;
      }
      if (path === '/api/auth/profile' && method === 'POST') {
        const p = z
          .object({ displayName, bio: z.string().trim().max(300), city: z.string().trim().max(80) })
          .strict()
          .parse(await body(req));
        json(200, { user: accounts.updateProfile(actor.id, p) });
        return true;
      }
      if (path === '/api/auth/password' && method === 'POST') {
        limit(`password:${actor.id}`, 5, 15 * 60000);
        const p = z
          .object({ oldPassword: z.string().min(1).max(128), password })
          .strict()
          .parse(await body(req));
        json(200, await accounts.changePassword(actor, p));
        return true;
      }
      if (path === '/api/auth/invitations' && method === 'POST') {
        limit(`invite:${actor.id}`, 10);
        json(201, accounts.invite(actor));
        return true;
      }
      if (path === '/api/social/overview' && method === 'GET') {
        json(200, accounts.overview(actor.id));
        return true;
      }
      if (path === '/api/social/unread' && method === 'GET') {
        json(200, accounts.unread(actor.id));
        return true;
      }
      const readMessages = path.match(/^\/api\/social\/messages\/([^/]+)\/read$/);
      if (readMessages && method === 'POST') {
        limit(`message-read:${actor.id}`, 120);
        const p = z
          .object({ through: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
          .strict()
          .parse(await body(req));
        json(200, accounts.readMessages(actor.id, uuid.parse(readMessages[1]), p.through));
        return true;
      }
      if (path === '/api/social/contacts' && method === 'POST') {
        limit(`contact:${actor.id}`, 10);
        const p = z
          .object({ username })
          .strict()
          .parse(await body(req));
        withNotice(() => {
          accounts.request(actor.id, p.username);
          const recipient = store.db
            .prepare('SELECT id FROM users WHERE username=?')
            .get(p.username);
          options.notifications?.publish(
            recipient.id,
            {
              kind: 'friend',
              title: '新的联系人申请',
              body: `${actor.displayName} 请求添加你为联系人。`,
              target: { type: 'contacts' },
            },
            'friend:' +
              actor.id +
              ':' +
              recipient.id +
              ':' +
              store.db
                .prepare('SELECT created_at FROM contacts WHERE requester=? AND (a=? OR b=?)')
                .get(actor.id, recipient.id, recipient.id).created_at,
          );
        });
        json(201, { ok: true });
        return true;
      }
      const contact = path.match(/^\/api\/social\/contacts\/([^/]+)$/);
      if (contact) {
        const other = uuid.parse(contact[1]);
        if (method === 'POST') {
          const p = z
            .object({ accept: z.boolean() })
            .strict()
            .parse(await body(req));
          accounts.respond(actor.id, other, p.accept);
          json(200, { ok: true });
          return true;
        }
        if (method === 'DELETE') {
          accounts.removeContact(actor.id, other);
          json(200, { ok: true });
          return true;
        }
      }
      const messages = path.match(/^\/api\/social\/messages\/([^/]+)$/);
      if (messages) {
        const other = uuid.parse(messages[1]);
        if (method === 'GET') {
          const before = z.coerce
            .number()
            .int()
            .positive()
            .max(Number.MAX_SAFE_INTEGER)
            .parse(url.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
          json(200, { messages: accounts.messages(actor.id, other, before) });
          return true;
        }
        if (method === 'POST') {
          limit(`message:${actor.id}`, 40);
          const p = z
            .object({ id: uuid, content: z.string().trim().min(1).max(5000) })
            .strict()
            .parse(await body(req));
          const sent = withNotice(() => {
            const messages = accounts.send(actor.id, other, p);
            options.notifications?.publish(
              other,
              {
                kind: 'contact',
                title: actor.displayName + ' 发来消息',
                body: p.content.slice(0, 1200),
                target: { type: 'contact', contactId: actor.id },
              },
              'message:' + actor.id + ':' + p.id,
            );
            return messages;
          });
          json(201, { messages: sent });
          return true;
        }
      }
      if (path === '/api/social/location') {
        if (method === 'POST') {
          limit(`location:${actor.id}`, 10);
          const p = z
            .object({
              latitude: z.number().min(-90).max(90),
              longitude: z.number().min(-180).max(180),
              accuracy: z.number().min(0).max(10000000),
              ttlMinutes: z.union([z.literal(15), z.literal(60)]),
            })
            .strict()
            .parse(await body(req));
          accounts.shareLocation(actor.id, p);
          json(200, { ok: true });
          return true;
        }
        if (method === 'DELETE') {
          accounts.stopLocation(actor.id);
          json(200, { ok: true });
          return true;
        }
      }
      if (path === '/api/pi/status' && method === 'GET') {
        if (!piReady) {
          json(200, {
            available: false,
            agent: {
              backend: 'pi',
              transport: 'server',
              capabilities: agentCapabilities({}, '服务器 Pi 尚未配置。'),
            },
            dsh: { enabled: false, available: false, reason: 'DSH 接入尚未启用。' },
          });
          return true;
        }
        try {
          const response = await (pi.fetch ?? fetch)(`${pi.url}/health`, {
            headers: { Authorization: `Bearer ${pi.token}` },
            signal: AbortSignal.timeout(5000),
            redirect: 'error',
          });
          if (!response.ok) throw new Error();
          const p = await response.json();
          json(200, {
            available: !!p.ready,
            version: p.version,
            model: p.model,
            tools: !!p.projectFiles && actor.role === 'owner',
            nativeSessions: !!p.nativeSessions,
            streaming: !!p.streaming,
            vision: !!p.vision,
            webSearch: !!p.webSearch,
            attachments: !!p.attachments,
            agent: {
              backend: 'pi',
              transport: 'server',
              capabilities: agentCapabilities(
                {
                  streaming: p.streaming === true,
                  attachments: p.attachments === true,
                  ...Object.fromEntries(
                    Object.entries(p.agentCapabilities || {}).filter(
                      ([name]) => !['terminal', '__proto__', 'constructor'].includes(name),
                    ),
                  ),
                },
                p.ready ? '' : '服务器 Pi 尚未就绪。',
              ),
            },
            dsh: { enabled: false, available: false, reason: 'DSH 接入尚未启用。' },
            concurrency: {
              maxConcurrent: Math.min(concurrency, Number(p.maxConcurrent) || concurrency),
              maxConcurrentPerUser: Math.min(
                limits.maxConcurrentPerUser,
                Number(p.maxConcurrentPerUser) || limits.maxConcurrentPerUser,
              ),
              running: activeFor(actor.id),
            },
            ...(actor.role === 'owner' && p.pluginActivation
              ? {
                  pluginActivation: {
                    ready: !!p.pluginActivation.ready,
                    checking: !!p.pluginActivation.checking,
                    fallback: !!p.pluginActivation.fallback,
                    checkedAt: p.pluginActivation.checkedAt,
                    ...(p.pluginActivation.diagnostic
                      ? { diagnostic: diagnosticSchema.parse(p.pluginActivation.diagnostic) }
                      : {}),
                  },
                }
              : {}),
          });
        } catch {
          json(200, {
            available: false,
            agent: {
              backend: 'pi',
              transport: 'server',
              capabilities: agentCapabilities({}, '服务器 Pi 连接中断。'),
            },
            dsh: { enabled: false, available: false, reason: 'DSH 接入尚未启用。' },
          });
        }
        return true;
      }
      if (path === '/api/pi/preferences') {
        if (method === 'GET') {
          let preferences = conversationMetadata.preferences(actor.id);
          if (!preferences.configured && piReady) {
            const { projects = [] } = await projectsFor(actor);
            const project =
              projects.find((p) =>
                actor.role === 'owner'
                  ? p.id === 'workspace'
                  : p.userRoot && p.ownerId === actor.id,
              ) || projects.find((p) => !p.readOnly);
            preferences = { defaultProjectId: project?.id || null, configured: false };
          }
          json(200, { preferences });
          return true;
        }
        if (method === 'PATCH') {
          limit(`pi-preferences:${actor.id}`, 30);
          const p = z
            .object({ defaultProjectId: projectIdSchema.nullable() })
            .strict()
            .parse(await body(req));
          if (p.defaultProjectId) {
            await projectFor(actor, p.defaultProjectId);
          }
          json(200, {
            preferences: conversationMetadata.setPreferences(actor.id, p.defaultProjectId),
          });
          return true;
        }
      }
      const listConversations = () =>
        conversationList({
          history: accounts.piConversations(actor.id),
          tasks: tasks.all(actor.id),
          metadata: conversationMetadata.list(actor.id),
        }).map((c) => ({
          ...c,
          runtime: serverPiRuntime(actor.id, c.id, c.projectId),
          branch: branches.info(actor.id, c.id),
        }));
      const forkRoute = path.match(/^\/api\/pi\/conversations\/([^/]+)\/fork$/);
      if (forkRoute && method === 'POST') {
        const source = uuid.parse(forkRoute[1]);
        const p = z
          .object({ id: uuid, turnId: uuid, position: z.enum(['before', 'after']) })
          .strict()
          .parse(await body(req));
        if (
          p.id === source ||
          tasks.all(actor.id).some((t) => t.conversationId === p.id) ||
          store.db
            .prepare('SELECT 1 FROM pi_closed_conversations WHERE owner=? AND conversation_id=?')
            .get(actor.id, p.id)
        )
          throw fail(409, '目标对话已存在或已删除。');
        const original = accounts.piTurn(actor.id, p.turnId);
        const live = tasks.get(actor.id, p.turnId);
        if (original?.project_id || live?.projectId)
          await projectFor(
            actor,
            original?.project_id || live.projectId,
            original?.access || live?.access || 'read',
          );
        limit(`pi-fork:${actor.id}`, 15);
        const result = await helperOperation(actor.id, source, () =>
          branches.create(actor.id, source, p, live),
        );
        json(201, { ...result, conversation: listConversations().find((c) => c.id === p.id) });
        return true;
      }
      if (path === '/api/pi/conversations' && method === 'GET') {
        const archived = z
          .enum(['exclude', 'include', 'only'])
          .parse(url.searchParams.get('archived') || 'exclude');
        json(200, {
          conversations: listConversations().filter(
            (c) => archived === 'include' || (archived === 'only' ? !!c.archivedAt : !c.archivedAt),
          ),
        });
        return true;
      }
      if (path === '/api/pi/conversations' && method === 'POST') {
        const p = z
          .object({
            id: uuid,
            projectId: projectIdSchema.nullable().optional(),
            access: z.enum(['read', 'edit']).default('read'),
          })
          .strict()
          .parse(await body(req));
        if (
          store.db
            .prepare('SELECT 1 FROM pi_closed_conversations WHERE owner=? AND conversation_id=?')
            .get(actor.id, p.id)
        )
          throw fail(409, '此对话已删除，请建立新对话。');
        const existing = listConversations().find((c) => c.id === p.id);
        let projectId = p.projectId;
        if (projectId === undefined && existing) projectId = existing.projectId || null;
        if (projectId === undefined && !piReady)
          projectId = conversationMetadata.preferences(actor.id).defaultProjectId;
        if (projectId === undefined || projectId) {
          const { projects = [] } = await projectsFor(actor);
          if (projectId === undefined) {
            const preferences = conversationMetadata.preferences(actor.id);
            projectId = preferences.configured
              ? preferences.defaultProjectId
              : (
                  projects.find((project) =>
                    actor.role === 'owner'
                      ? project.id === 'workspace'
                      : project.userRoot && project.ownerId === actor.id,
                  ) || projects.find((project) => !project.readOnly)
                )?.id || null;
          }
          const project = projects.find((project) => project.id === projectId);
          if (projectId && !project)
            throw fail(
              actor.role === 'owner' ? 404 : 403,
              '工作目录不存在或尚未授权，请重新选择默认工作目录。',
            );
          if (project?.readOnly && p.access === 'edit') throw fail(403, '所选项目为只读。');
        }
        projectId ||= null;
        if (existing && (existing.projectId || null) !== projectId)
          throw fail(409, '此对话已绑定其他项目，请建立新对话。');
        if (!projectId && p.access === 'edit') throw fail(400, '请先选择工作目录。');
        limit(`pi-conversation:${actor.id}`, 30);
        conversationMetadata.create(actor.id, p.id, {
          projectId,
          access: existing?.access || p.access,
        });
        json(201, { conversation: listConversations().find((c) => c.id === p.id) });
        return true;
      }
      const fileRoute = path.match(/^\/api\/pi\/conversations\/([^/]+)\/files(?:\/([^/]+))?$/);
      if (fileRoute) {
        const conversationId = uuid.parse(fileRoute[1]);
        if (fileRoute[2] && method === 'GET') {
          await chatFiles.download(actor.id, conversationId, uuid.parse(fileRoute[2]), res);
          return true;
        }
        if (fileRoute[2] && method === 'DELETE') {
          if (
            activePi.has(`${actor.id}:${conversationId}`) ||
            tasks.live(actor.id, conversationId).length
          )
            throw fail(409, '请等待当前回复和队列结束。');
          await chatFiles.remove(actor.id, conversationId, uuid.parse(fileRoute[2]));
          json(200, { ok: true });
          return true;
        }
        if (!fileRoute[2] && method === 'GET') {
          json(200, { files: chatFiles.list(actor.id, conversationId) });
          return true;
        }
        if (!fileRoute[2] && method === 'POST') {
          limit(`upload:${actor.id}`, 20);
          const name = z.string().min(1).max(160).parse(url.searchParams.get('name'));
          json(
            201,
            await helperOperation(actor.id, conversationId, async () => ({
              file: await chatFiles.save(actor.id, conversationId, name, await readUpload(req)),
            })),
          );
          return true;
        }
      }
      const conversation = path.match(/^\/api\/pi\/conversations\/([^/]+)$/);
      if (conversation) {
        const id = uuid.parse(conversation[1]);
        if (method === 'GET') {
          const before = url.searchParams.has('before')
            ? z.coerce.number().int().positive().parse(url.searchParams.get('before'))
            : Number.MAX_SAFE_INTEGER;
          json(200, {
            turns: accounts.piHistory(actor.id, id, before),
            conversation: listConversations().find((c) => c.id === id) || null,
            sessionContext: sessionContext.get(actor.id, id),
          });
          return true;
        }
        if (method === 'PATCH') {
          if (cleaningHelpers.has(`${actor.id}:${id}`))
            throw fail(409, '临时对话正在清理，请重新打开后操作。');
          const p = z
            .object({
              title: z.string().trim().min(1).max(120).optional(),
              pinned: z.boolean().optional(),
              archived: z.boolean().optional(),
            })
            .strict()
            .refine((value) => Object.keys(value).length > 0)
            .parse(await body(req));
          const existing = listConversations().find((c) => c.id === id);
          if (!existing) throw fail(404, '对话不存在。');
          if (cleaningHelpers.has(`${actor.id}:${id}`))
            throw fail(409, '临时对话正在清理，请重新打开后操作。');
          limit(`pi-conversation-update:${actor.id}`, 60);
          conversationMetadata.create(actor.id, id, existing);
          conversationMetadata.patch(actor.id, id, p);
          if (p.archived === false)
            store.db
              .prepare('UPDATE pi_assistance_lifetimes SET retained=1 WHERE owner=? AND id=?')
              .run(actor.id, id);
          await options.unified?.()?.nativePatch(actor, { origin: 'server', nativeId: id }, p);
          json(200, { conversation: listConversations().find((c) => c.id === id) });
          return true;
        }
        if (method === 'DELETE') {
          if (cleaningHelpers.has(`${actor.id}:${id}`))
            throw fail(409, '临时对话正在清理，请稍后再操作。');
          const manager = options.unified?.(),
            ref = { origin: 'server', nativeId: id };
          const managed = manager?.forNative(actor.id, ref);
          if (managed && !manager.deleting(actor.id, ref)) {
            json(200, await manager.remove(actor, managed.id));
            return true;
          }
          manager?.assertNativeDelete(actor.id, ref);
          if (
            store.db
              .prepare(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='relay_conversations'",
              )
              .get() &&
            store.db
              .prepare('SELECT 1 FROM relay_conversations WHERE id=? AND owner=?')
              .get(id, actor.id)
          )
            throw fail(409, '请在电脑对话中管理这段历史。');
          if (activePi.has(`${actor.id}:${id}`) || tasks.live(actor.id, id).length)
            throw fail(409, '请先停止任务并撤回队列后再删除。');
          const health = await bridge('/health');
          if (activePi.has(`${actor.id}:${id}`) || tasks.live(actor.id, id).length)
            throw fail(409, '请先停止任务并撤回队列后再删除。');
          tasks.closeConversation(actor.id, id);
          if (health.scheduledTasks)
            await bridge('/schedules/conversation-delete', {
              ownerId: actor.id,
              conversationId: id,
            });
          if (health.nativeSessions)
            await bridge('/sessions/delete', { sessionKey: sessionKey(id) });
          accounts.deletePiConversation(actor.id, id);
          options.sandboxNetwork?.revokeConversation(actor.id, id);
          conversationMetadata.remove(actor.id, id);
          sessionContext.remove(actor.id, id);
          store.db
            .prepare(
              'DELETE FROM pi_task_events WHERE owner=? AND task_id IN (SELECT id FROM pi_tasks WHERE owner=? AND conversation_id=?)',
            )
            .run(actor.id, actor.id, id);
          store.db
            .prepare('DELETE FROM pi_tasks WHERE owner=? AND conversation_id=?')
            .run(actor.id, id);
          await chatFiles.removeConversation(actor.id, id);
          options.unified?.()?.nativeDeleted(actor.id, { origin: 'server', nativeId: id });
          json(200, { ok: true });
          return true;
        }
      }
      if (path === '/api/pi/message' && method === 'POST') {
        const p = z
          .object({
            id: uuid,
            conversationId: uuid,
            input: z.string().trim().min(1).max(8000),
            projectId: projectIdSchema.nullable().optional(),
            access: z.enum(['read', 'edit']).default('read'),
            stream: z.boolean().optional(),
            thinking: z.boolean().optional(),
            thinkingLevel: z.enum(['off', 'low', 'high', 'max']).optional(),
            attachments: z.array(uuid).max(8).default([]),
          })
          .strict()
          .parse(await body(req));
        if (
          cleaningHelpers.has(`${actor.id}:${p.conversationId}`) ||
          store.db
            .prepare('SELECT 1 FROM pi_closed_conversations WHERE owner=? AND conversation_id=?')
            .get(actor.id, p.conversationId)
        )
          throw fail(409, '临时对话已关闭或正在清理，请重新打开后发送。');
        const runtime = runtimeBindings.assert(
          actor.id,
          'server',
          p.conversationId,
          serverPiRuntime(actor.id, p.conversationId, p.projectId),
        );
        if (tasks.get(actor.id, p.id)) throw fail(409, '此请求已交给后台任务，请查看任务状态。');
        if (p.projectId) await projectFor(actor, p.projectId, p.access);
        if (!p.projectId && p.access === 'edit') throw fail(400, '请先选择项目。');
        const scope =
          accounts.piScope(actor.id, p.conversationId) ||
          tasks.scope(actor.id, p.conversationId) ||
          conversationMetadata.get(actor.id, p.conversationId);
        if (scope && scope.projectId !== (p.projectId || null))
          throw fail(409, '此对话已绑定其他项目，请建立新对话。');
        const old = accounts.piTurn(actor.id, p.id);
        if (old) {
          if (
            old.conversation_id !== p.conversationId ||
            old.input !== p.input ||
            (old.project_id || null) !== (p.projectId || null) ||
            (old.access || 'read') !== p.access ||
            JSON.stringify(JSON.parse(old.attachments || '[]').map((f) => f.id)) !==
              JSON.stringify(p.attachments)
          )
            throw fail(409, '这条请求已存在不同内容。');
          json(200, { turns: accounts.piHistory(actor.id, p.conversationId) });
          return true;
        }
        options
          .unified?.()
          ?.assertWritable(actor.id, { origin: 'server', nativeId: p.conversationId });
        if (!piReady) throw fail(503, '远程 Pi 尚未配置。');
        if (tasks.live(actor.id, p.conversationId).length)
          throw fail(409, '请等待当前任务和队列完成。');
        if (
          activePi.has(`${actor.id}:${p.conversationId}`) ||
          activePi.size >= concurrency ||
          activeFor(actor.id) >= limits.maxConcurrentPerUser
        )
          throw fail(429, '此对话正在执行或并发名额已满，请使用任务队列。');
        const previous = accounts.piJob(actor.id, p.id);
        if (previous)
          throw fail(409, '此项目任务已经执行或中断，不会自动重复修改；请查看记录后发起新任务。');
        if (p.projectId) {
          const configured = await bridge('/projects');
          const project = configured.projects?.find((x) => x.id === p.projectId);
          if (!project) throw fail(404, '项目不存在。');
          if (project.readOnly && p.access === 'edit') throw fail(403, '所选项目为只读。');
        }
        limit(`pi:${actor.id}`, 5);
        limit('pi:global', 10);
        const history = [
          ...((await options
            .unified?.()
            ?.handoff(actor.id, { origin: 'server', nativeId: p.conversationId })) || []),
          ...accounts.piTranscript(actor.id, p.conversationId),
        ];
        const attachments = chatFiles.selected(actor.id, p.conversationId, p.attachments);
        const availableFiles = chatFiles.modelFiles(actor.id, p.conversationId, p.attachments);
        if (
          cleaningHelpers.has(`${actor.id}:${p.conversationId}`) ||
          store.db
            .prepare('SELECT 1 FROM pi_closed_conversations WHERE owner=? AND conversation_id=?')
            .get(actor.id, p.conversationId)
        )
          throw fail(409, '临时对话已关闭或正在清理，请重新打开后发送。');
        if (
          activePi.has(`${actor.id}:${p.conversationId}`) ||
          activePi.size >= concurrency ||
          activeFor(actor.id) >= limits.maxConcurrentPerUser
        )
          throw fail(429, '此对话正在执行或并发名额已满，请使用任务队列。');
        options
          .unified?.()
          ?.assertWritable(actor.id, { origin: 'server', nativeId: p.conversationId });
        runtimeBindings.bind(actor.id, 'server', p.conversationId, runtime);
        activePi.add(`${actor.id}:${p.conversationId}`);
        if (p.projectId) accounts.reservePiJob(actor.id, p);
        try {
          const payload = {
            canManageSkills: actor.role === 'owner',
            projectPrincipal: principalFor(actor),
            sessionKey: sessionKey(p.conversationId),
            ownerId: actor.id,
            conversationId: p.conversationId,
            requestId: p.id,
            input: p.input,
            history,
            messages: [...history, { role: 'user', content: p.input }],
            thinking: !!p.thinking,
            thinkingLevel: p.thinkingLevel ?? (p.thinking ? 'high' : 'off'),
            files: availableFiles,
            attachmentIds: p.attachments,
            ...(p.projectId ? { projectId: p.projectId, access: p.access } : {}),
          };
          const result = p.stream
            ? await streamBridge(payload, res)
            : await bridge('/run', payload, 200000);
          const output = z.string().trim().min(1).max(48000).parse(result.output);
          const tools = toolsSchema.parse(result.tools || []);
          p.attachments = attachments;
          p.artifacts = [];
          for (const [i, file] of decodeExportFiles(result.exports).entries()) {
            const hex = createHash('sha256').update(`${actor.id}:${p.id}:${i}`).digest('hex');
            const fileId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
            p.artifacts.push(
              await chatFiles.save(actor.id, p.conversationId, file.name, file.bytes, fileId),
            );
          }
          accounts.savePiTurn(
            actor.id,
            {
              ...p,
              execution: {
                runtimeWarnings: z
                  .array(diagnosticSchema)
                  .max(4)
                  .parse(result.runtimeWarnings || []),
              },
            },
            output,
            tools,
            typeof result.thinking === 'string' ? result.thinking.slice(0, 48000) : '',
          );
          sessionContext.task(actor.id, p.conversationId, result.context);
          conversationMetadata.create(actor.id, p.conversationId, p);
          titles.consider(actor.id, p, output);
          if (p.projectId) accounts.finishPiJob(actor.id, p.id, 'done', tools);
          const completed = {
            turns: accounts.piHistory(actor.id, p.conversationId),
            context: result.context,
          };
          if (p.stream) {
            res.write(JSON.stringify({ type: 'done', ...completed }) + '\n');
            res.end();
          } else json(200, completed);
        } catch (e) {
          if (p.projectId) accounts.finishPiJob(actor.id, p.id, 'error', e.tools || [], e.message);
          if (p.stream && res.headersSent) {
            res.write(
              JSON.stringify({
                type: 'error',
                error: e.status ? e.message : 'Pi 执行失败或中断，请查看记录。',
                ...(e.diagnostic ? { diagnostic: e.diagnostic } : {}),
                tools: e.tools || [],
              }) + '\n',
            );
            res.end();
          } else throw e;
        } finally {
          activePi.delete(`${actor.id}:${p.conversationId}`);
        }
        return true;
      }
      return false;
    },
  };
}
