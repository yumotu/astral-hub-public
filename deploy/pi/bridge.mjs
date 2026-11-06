import { createRunPool } from './run-pool.mjs';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, rm, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { z } from '/extensions/node_modules/zod/index.js';
import { StringDecoder } from 'node:string_decoder';
import { createProjects } from './projects.mjs';
import { createProjectFiles } from './project-files.mjs';
import { configureThinking, resolveThinkingLevel } from './thinking.mjs';
import { createSkillStore } from './skill-store.mjs';
import { createCronService } from './cron-service.mjs';
import { createTerminalRuntime, terminalSchema } from './terminal-runtime.mjs';
import { createModelContext, configureContext, contextCompaction } from './model-context.mjs';
import { recoverPackages, recoverPackagesForTurn } from './package-transaction.mjs';
import { checkPackageActivation, saveActivation } from './package-preflight.mjs';
import { cleanDiagnostic, runtimeDiagnostic } from './runtime-diagnostics.mjs';
import {
  loadSkills,
  SessionManager,
} from '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import { forkNativeSession } from './session-fork.mjs';
import { settleSteeringAck } from './steer-controls.mjs';
import { activityDeadline } from './activity-deadline.mjs';
import { packageResources } from './package-resources.mjs';
import { buildSkillCatalog } from './skill-catalog.mjs';
import { validQuestionContinuation } from './question-continuation.mjs';
const token = process.env.PI_BRIDGE_TOKEN || '';
if (token.length < 32) throw new Error('PI_BRIDGE_TOKEN must contain at least 32 characters');
const installed = spawnSync('pi', ['--version'], { encoding: 'utf8', timeout: 15000 });
if (installed.status !== 0) throw new Error('Pi is not available');
const version = installed.stdout.trim().slice(0, 80),
  model = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model)) throw new Error('Invalid model');
const models = JSON.parse(await readFile(new URL('./models.json', import.meta.url), 'utf8'));
models.providers['astral-deepseek'].models[0].id = model;
models.providers['astral-deepseek'].models[0].input = /flash/.test(model)
  ? ['text', 'image']
  : ['text'];
await mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
await writeFile(join(process.env.PI_CODING_AGENT_DIR, 'models.json'), JSON.stringify(models), {
  mode: 0o600,
});
const projectsPath = new URL('./projects.json', import.meta.url).pathname,
  backupDir = join(process.env.PI_CODING_AGENT_DIR, 'project-backups');
const projects = JSON.parse(await readFile(projectsPath, 'utf8'));
if (
  !Array.isArray(projects) ||
  projects.some(
    (p) => !p.id || !p.root?.startsWith('/projects/') || typeof p.readOnly !== 'boolean',
  )
)
  throw new Error('Invalid project configuration');
const privateRoot = join(process.env.PI_CODING_AGENT_DIR, 'astral');
const modelContext = createModelContext({
  root: privateRoot,
  model,
  apiKey: process.env.DEEPSEEK_API_KEY || '',
});
const skillsRoot = join(privateRoot, 'skills');
const packagesRoot = join(privateRoot, 'packages');
await recoverPackages(packagesRoot);
let engineReady = false,
  checkingPlugins = true;
const startupCheck = (async () => {
  let state;
  try {
    state = await checkPackageActivation(packagesRoot);
    engineReady = true;
  } catch (e) {
    state = {
      ready: false,
      checkedAt: new Date().toISOString(),
      diagnostic: e.diagnostic || runtimeDiagnostic(e, { phase: 'startup' }),
    };
    try {
      await checkPackageActivation(packagesRoot, { coreOnly: true });
      engineReady = true;
    } catch (e) {
      state.coreDiagnostic = e.diagnostic || runtimeDiagnostic(e, { phase: 'startup' });
    }
  }
  await saveActivation(packagesRoot, state);
})()
  .catch(() => {
    engineReady = false;
  })
  .finally(() => {
    checkingPlugins = false;
  });
const terminal = await createTerminalRuntime({
  target: 'pi',
  defaultCwd: join(packagesRoot, 'npm'),
  homeRoot: join(privateRoot, 'plugin-state'),
  agentDir: packagesRoot,
});
await mkdir(packagesRoot, { recursive: true, mode: 0o700 });
await mkdir(join(packagesRoot, 'npm'), { recursive: true, mode: 0o700 });
await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
const registry = await createProjects({
  sources: projects,
  registryFile: join(privateRoot, 'projects.json'),
  backupDir,
  fullAccess: true,
});
const projectPrincipalSchema = z
  .object({
    id: z.string().uuid(),
    username: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,31}$/),
    admin: z.boolean(),
  })
  .strict();
function requestPrincipal(req) {
  const raw = req.headers['x-astral-project-principal'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.length > 500)
    throw Object.assign(new Error('Invalid project account'), { status: 403 });
  try {
    return projectPrincipalSchema.parse(JSON.parse(raw));
  } catch {
    throw Object.assign(new Error('Invalid project account'), { status: 403 });
  }
}
let files = registry.files;
const skillStore = createSkillStore(skillsRoot);
const cronService = await createCronService({
  root: join(privateRoot, 'plugin-state'),
  packagesRoot,
});
const active = createRunPool(process.env.PI_MAX_CONCURRENT, process.env.PI_MAX_CONCURRENT_PER_USER);
let managingSkills = false;
const forkingSessions = new Set();
async function execute(p, event) {
  await startupCheck;
  if (
    !active.canRun(p.sessionKey, p.ownerId || p.sessionKey) ||
    managingSkills ||
    forkingSessions.has(p.sessionKey)
  )
    throw Object.assign(new Error('Pi 正在处理请求。'), { status: 429 });
  const principal = p.projectPrincipal || (p.canManageSkills ? undefined : null);
  if (p.projectId && !principal && !p.canManageSkills)
    throw Object.assign(new Error('Missing project account'), { status: 403 });
  if (
    p.projectId &&
    principal &&
    (principal.id !== p.ownerId || principal.admin !== !!p.canManageSkills)
  )
    throw Object.assign(new Error('Project account does not match task'), { status: 403 });
  const scope = await registry.authorize(principal, p.projectId, p.access);
  const selected = p.projectId ? scope.find((project) => project.id === p.projectId) : null;
  if (selected?.readOnly && p.access === 'edit')
    throw Object.assign(new Error('项目为只读。'), { status: 403 });
  const lock = {
    sessionKey: p.sessionKey,
    ownerId: p.ownerId || p.sessionKey,
    requestId: p.requestId,
    projectId: p.projectId || null,
    child: null,
    controls: new Map(),
    pluginToken: randomBytes(32).toString('hex'),
    dialogs: new Map(),
  };
  active.acquire(p.sessionKey, lock);
  let dir,
    attempt,
    attemptCreated = false;
  try {
    await recoverPackagesForTurn(packagesRoot);
    const sessionRoot = join(privateRoot, 'sessions', p.sessionKey);
    dir = join(sessionRoot, 'runtime');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const home = join(privateRoot, 'plugin-state', p.ownerId || p.sessionKey, 'home');
    await mkdir(home, { recursive: true, mode: 0o700 });
    const localModels = structuredClone(models);
    const contextLimits = await modelContext.get(p.sessionKey);
    lock.contextWindow = contextLimits.contextWindow;
    p.contextLimits = contextLimits;
    p.thinkingLevel = resolveThinkingLevel(p.thinkingLevel, p.thinking);
    localModels.providers['astral-deepseek'].models[0] = configureThinking(
      configureContext(localModels.providers['astral-deepseek'].models[0], contextLimits),
      p.thinkingLevel,
    );
    await writeFile(join(dir, 'models.json'), JSON.stringify(localModels), { mode: 0o600 });
    await writeFile(join(dir, 'projects.json'), JSON.stringify(scope), { mode: 0o600 });
    await writeFile(join(dir, 'chat-files.json'), JSON.stringify(p.files || []), { mode: 0o600 });
    await writeFile(
      join(dir, 'web-search.json'),
      await readFile(new URL('./web-search.json', import.meta.url)),
      { mode: 0o600 },
    );
    let runtimeSettings = {};
    try {
      runtimeSettings = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await writeFile(
      join(dir, 'settings.json'),
      JSON.stringify({
        ...runtimeSettings,
        compaction: contextCompaction(
          contextLimits.contextWindow,
          runtimeSettings.compaction,
          localModels.providers['astral-deepseek'].models[0].maxTokens,
        ),
        enableAnalytics: false,
        enableInstallTelemetry: false,
      }),
      { mode: 0o600 },
    );
    const skills = await skillStore.list();
    lock.pluginContext = {
      ownerId: p.ownerId,
      conversationId: p.conversationId,
      projectId: p.projectId || null,
      access: p.access || 'read',
      thinkingLevel: p.thinkingLevel,
      model,
      cwd: selected?.root || join(sessionRoot, 'workspace'),
      timeZone: 'Asia/Shanghai',
      skills: skills.filter((s) => s.enabled).map((s) => join(skillsRoot, s.name, 'SKILL.md')),
    };
    attempt = null;
    if ((p.action || 'run') === 'run') {
      if (!/^[a-f0-9-]{36}$/.test(p.requestId || ''))
        throw Object.assign(new Error('请求编号格式不正确。'), { status: 400 });
      await mkdir(join(sessionRoot, 'requests'), { recursive: true, mode: 0o700 });
      attempt = join(sessionRoot, 'requests', p.requestId + '.json');
      try {
        const saved = JSON.parse(await readFile(attempt, 'utf8'));
        if (
          saved.input !== p.input ||
          saved.projectId !== (p.projectId || null) ||
          JSON.stringify(saved.attachmentIds || []) !== JSON.stringify(p.attachmentIds || []) ||
          saved.access !== (p.access || 'read')
        )
          throw Object.assign(new Error('请求编号已存在不同内容。'), { status: 409 });
        if (saved.result) return saved.result;
        throw Object.assign(new Error('此请求已经执行或中断，请检查记录后发送新请求。'), {
          status: 409,
        });
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      await writeFile(
        attempt,
        JSON.stringify({
          input: p.input,
          projectId: p.projectId || null,
          access: p.access || 'read',
          status: 'running',
          attachmentIds: p.attachmentIds || [],
        }),
        { mode: 0o600, flag: 'wx' },
      );
      attemptCreated = true;
    }
    await mkdir(join(sessionRoot, 'workspace'), { recursive: true, mode: 0o700 });
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['/bridge/rpc-worker.mjs'], {
        cwd: dir,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          HOME: home,
          LANG: 'C.UTF-8',
          TERM: 'dumb',
          NO_COLOR: '1',
          PI_CODING_AGENT_DIR: dir,
          PI_OFFLINE: '1',
          PI_TELEMETRY: '0',
          NODE_OPTIONS: '--max-old-space-size=384',
          DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
          ASTRAL_PROJECT_ID: p.projectId || '',
          ASTRAL_PROJECT_ACCESS: p.access || 'read',
          ASTRAL_PROJECTS_FILE: join(dir, 'projects.json'),
          ASTRAL_PROJECT_BACKUPS: backupDir,
          ASTRAL_SKILLS_ROOT: skillsRoot,
          ASTRAL_PACKAGES_ROOT: packagesRoot,
          ASTRAL_SKILLS_WRITE: p.canManageSkills === true ? '1' : '0',
          ASTRAL_CHAT_FILES_FILE: join(dir, 'chat-files.json'),
          ASTRAL_UPLOADS_ROOT: '/uploads',
          PI_WEB_ACCESS_CACHE_ROOT: join(sessionRoot, 'web-cache'),
          ASTRAL_PLUGIN_ENDPOINT: 'http://127.0.0.1:8790/native/cron',
          ASTRAL_PLUGIN_TOKEN: p.canManageSkills ? lock.pluginToken : '',
          ASTRAL_REQUEST_ID: p.requestId || '',
          ASTRAL_RESUME_GOAL_ID: p.resumeQuestion?.goalId || '',
          ASTRAL_HOST_ACCESS_URL: p.canManageSkills ? p.hostAccess?.url || '' : '',
          ASTRAL_HOST_ACCESS_TOKEN: p.canManageSkills ? p.hostAccess?.token || '' : '',
          ASTRAL_SANDBOX_ACCESS_URL: p.sandboxAccess?.url || '',
          ASTRAL_SANDBOX_ACCESS_TOKEN: p.sandboxAccess?.token || '',
          ASTRAL_GOAL_URL: p.goalAccess?.url || '',
          ASTRAL_GOAL_TOKEN: p.goalAccess?.token || '',
          ASTRAL_LONG_GOAL_ALLOWED:
            p.toolAllowlist &&
            !['create_goal', 'get_goal', 'update_goal', 'goal_plan'].every((name) =>
              p.toolAllowlist.includes(name),
            )
              ? '0'
              : '1',
          ASTRAL_APP_ACCESS_URL: p.appAccess?.url || '',
          ASTRAL_APP_ACCESS_TOKEN: p.appAccess?.token || '',
          ASTRAL_CAN_SCHEDULE:
            p.canManageSkills &&
            (!Array.isArray(p.toolAllowlist) ||
              p.toolAllowlist.some((name) => ['schedule_manage', 'app_functions'].includes(name)))
              ? '1'
              : '0',
          ASTRAL_MAIL_ACCESS_URL: p.mailAccess?.url || '',
          ASTRAL_MAIL_ACCESS_TOKEN: p.mailAccess?.token || '',
          TZ: 'Asia/Shanghai',
        },
      });
      lock.child = child;
      lock.uiResponse = (response) => {
        const dialog = lock.dialogs.get(response.id);
        if (!dialog) throw Object.assign(new Error('插件请求已结束或已经处理。'), { status: 409 });
        child.stdin.write(JSON.stringify({ type: 'extension_ui_response', ...response }) + '\n');
        lock.dialogs.delete(response.id);
        deadline.resume(response.id);
      };
      lock.steer = async (control) => {
        const prior = lock.controls.get(control.id);
        const fingerprint = JSON.stringify(control);
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            throw Object.assign(new Error('补充编号已存在不同内容。'), { status: 409 });
          return prior.promise;
        }
        if (lock.controls.size >= 20)
          throw Object.assign(new Error('本轮补充过多。'), { status: 429 });
        let accept, decline;
        const promise = new Promise((resolve, reject) => {
          accept = resolve;
          decline = reject;
        });
        promise.catch(() => {});
        const item = { fingerprint, promise, accept, decline };
        lock.controls.set(control.id, item);
        lock.controlChain = (lock.controlChain || Promise.resolve()).then(async () => {
          try {
            // Refresh the same scoped manifest; tools re-read it for newly attached files.
            const old = JSON.parse(await readFile(join(dir, 'chat-files.json'), 'utf8'));
            const merged = [
              ...new Map([...old, ...(control.files || [])].map((f) => [f.id, f])).values(),
            ];
            await writeFile(join(dir, 'chat-files.next.json'), JSON.stringify(merged), {
              mode: 0o600,
            });
            await rename(join(dir, 'chat-files.next.json'), join(dir, 'chat-files.json'));
            child.stdin.write(JSON.stringify({ type: 'steer', ...control }) + '\n');
          } catch {
            decline(Object.assign(new Error('当前任务已结束，补充未送达。'), { status: 409 }));
          }
        });
        return promise;
      };
      let forcedKill;
      const kill = () => {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        forcedKill ||= setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }, 3000);
        forcedKill.unref();
      };
      lock.cancel = kill;
      let buffer = '',
        result = null,
        failed = false;
      let stderr = '',
        framingError = '',
        expired = false;
      const decoder = new StringDecoder('utf8');
      const deadline = activityDeadline(p.action === 'run' ? 915000 : 205000, () => {
        failed = true;
        expired = true;
        kill();
      });
      function parse(text) {
        buffer += text;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          if (!line) continue;
          if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw Error('RPC记录过大。');
          const e = JSON.parse(line);
          deadline.touch();
          if (e.type === 'extension_ui_request') deadline.wait(e.id);
          if (e.type === 'extension_ui_resolved') deadline.resume(e.id);
          if (e.type === 'control_ack') {
            settleSteeringAck(lock.controls, e);
          } else if (e.type === 'done') result = e;
          else if (e.type === 'error') {
            failed = true;
            result = e;
          } else {
            if (e.type === 'runtime_warning')
              void saveActivation(packagesRoot, {
                ready: false,
                checkedAt: new Date().toISOString(),
                diagnostic: e.diagnostic,
              }).catch(() => {});
            if (e.type === 'extension_ui_request') lock.dialogs.set(e.id, e);
            event?.(e);
          }
        }
        if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) throw Error('RPC记录过大。');
      }
      child.stdout.on('data', (chunk) => {
        try {
          parse(decoder.write(chunk));
        } catch (e) {
          failed = true;
          framingError = e.message;
          kill();
        }
      });
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + cleanDiagnostic(chunk.toString())).slice(-24000);
      });
      child.stdin.on('error', () => {});
      child.once('error', (e) => {
        deadline.close();
        const diagnostic = runtimeDiagnostic(e, { stderr, phase: 'startup' });
        reject(Object.assign(new Error(diagnostic.message), { status: 502, diagnostic }));
      });
      child.once('close', (code) => {
        clearTimeout(forcedKill);
        for (const item of lock.controls.values())
          item.decline(Object.assign(new Error('任务已经结束，补充结果未确认。'), { status: 409 }));
        deadline.close();
        try {
          parse(decoder.end());
        } catch (e) {
          failed = true;
          framingError = e.message;
        }
        if (code !== 0 || failed || !result) {
          const diagnostic =
            result?.diagnostic ||
            runtimeDiagnostic(
              new Error(
                expired
                  ? 'Pi 执行超时'
                  : framingError || result?.error || 'Pi 工作进程退出，未返回结果。',
              ),
              { stderr, exitCode: code },
            );
          reject(
            Object.assign(
              new Error(
                result?.error === '当前上下文较短，无需压缩。' || result?.error
                  ? result.error
                  : diagnostic.message,
              ),
              {
                status:
                  result?.error === '当前上下文较短，无需压缩。' || result?.status === 400
                    ? 400
                    : result?.status === 402
                      ? 402
                      : 502,
                tools: result?.tools || [],
                diagnostic,
              },
            ),
          );
        } else resolve(result);
      });
      child.stdin.write(
        JSON.stringify({
          ...p,
          allowWrite: scope.some((p) => !p.readOnly),
          vision: localModels.providers['astral-deepseek'].models[0].input.includes('image'),
          model,
          cwd: selected?.root || join(sessionRoot, 'workspace'),
          sessionDir: sessionRoot,
          skills: skills.filter((s) => s.enabled).map((s) => join(skillsRoot, s.name, 'SKILL.md')),
        }) + '\n',
      );
    });
    if (attempt)
      await writeFile(
        attempt,
        JSON.stringify({
          input: p.input,
          projectId: p.projectId || null,
          access: p.access || 'read',
          result,
          attachmentIds: p.attachmentIds || [],
        }),
        { mode: 0o600 },
      );
    return result;
  } catch (e) {
    if (attemptCreated)
      await writeFile(
        attempt,
        JSON.stringify({
          input: p.input,
          projectId: p.projectId || null,
          access: p.access || 'read',
          attachmentIds: p.attachmentIds || [],
          status: 'error',
          error: e.message,
          diagnostic: e.diagnostic,
          finishedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
    throw e;
  } finally {
    active.release(p.sessionKey, lock);
    // Runtime configuration and plugin state must survive a turn and a restart.
  }
}
function validateRun(p) {
  if (p?.projectPrincipal) projectPrincipalSchema.parse(p.projectPrincipal);
  if (p) resolveThinkingLevel(p.thinkingLevel, p.thinking);
  if (
    !p ||
    (p.resumeQuestion !== undefined &&
      (!validQuestionContinuation(p.resumeQuestion) || p.input !== p.resumeQuestion.answer)) ||
    !/^[a-f0-9]{64}$/.test(p.sessionKey || '') ||
    !['run', 'inspect', 'compact'].includes(p.action || 'run') ||
    (p.projectId !== undefined && !/^[a-z0-9-]{1,50}$/.test(p.projectId)) ||
    (p.access !== undefined && !['read', 'edit'].includes(p.access)) ||
    (p.canManageSkills !== undefined && typeof p.canManageSkills !== 'boolean') ||
    (p.ownerId !== undefined && !/^[a-f0-9-]{36}$/.test(p.ownerId)) ||
    (p.conversationId !== undefined && !/^[a-f0-9-]{36}$/.test(p.conversationId)) ||
    (p.toolAllowlist !== undefined &&
      (!Array.isArray(p.toolAllowlist) ||
        p.toolAllowlist.length > 300 ||
        p.toolAllowlist.some((name) => !/^[A-Za-z0-9_.:-]{1,128}$/.test(name)))) ||
    (p.action !== 'inspect' &&
      p.action !== 'compact' &&
      (typeof p.input !== 'string' || p.input.length > 8000)) ||
    (p.history &&
      (!Array.isArray(p.history) ||
        !p.history.every(
          (m) => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string',
        )))
  )
    throw Object.assign(new Error('Invalid request'), { status: 400 });
}
async function readJSON(req, max = 4 * 1024 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > max) throw Object.assign(new Error('请求过大'), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks));
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}
const server = createServer(async (req, res) => {
  const json = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(data));
  };
  const url = new URL(req.url, 'http://localhost');
  const pluginRequest =
    ['/native/cron', '/native/package-lease'].includes(url.pathname) && req.method === 'POST';
  const pluginLock = pluginRequest
    ? active.byToken((req.headers.authorization || '').replace(/^Bearer /, ''))
    : null;
  const supplied = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, '')),
    expected = Buffer.from(pluginRequest ? pluginLock?.pluginToken || '' : token);
  if (
    !expected.length ||
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    json(401, { error: 'Unauthorized' });
    return;
  }
  try {
    if (url.pathname === '/native/package-lease' && req.method === 'POST') {
      const p = z
        .object({ acquire: z.boolean() })
        .strict()
        .parse(await readJSON(req, 1000));
      active.maintenance(pluginLock.sessionKey, p.acquire);
      json(200, { ok: true });
      return;
    }
    if (url.pathname === '/terminal' && req.method === 'POST') {
      const p = terminalSchema(z).parse(await readJSON(req, 32000));
      json(200, await terminal.handle(p));
      return;
    }
    if (url.pathname === '/sessions/context' && req.method === 'POST') {
      const p = z
        .object({
          sessionKey: z.string().regex(/^[a-f0-9]{64}$/),
          contextWindow: z.number().int().positive().max(100000000).nullable().optional(),
          refresh: z.boolean().optional(),
        })
        .strict()
        .parse(await readJSON(req, 1000));
      const state =
        p.contextWindow !== undefined
          ? await modelContext.set(p.sessionKey, p.contextWindow)
          : await modelContext.get(p.sessionKey, { refresh: p.refresh });
      json(200, {
        ...state,
        activeContextWindow: active.get(p.sessionKey)?.contextWindow || null,
      });
      return;
    }
    if (url.pathname === '/native/cron' && req.method === 'POST') {
      if (!pluginLock?.pluginContext?.ownerId)
        throw Object.assign(new Error('调度账号未绑定，请升级星屿服务。'), { status: 400 });
      const p = z
        .object({
          action: z.enum(['tool', 'status']),
          name: z
            .enum([
              'cron_create',
              'cron_list',
              'cron_update',
              'cron_delete',
              'cron_run',
              'cron_results',
            ])
            .optional(),
          params: z.record(z.string(), z.unknown()).optional(),
          callId: z.string().max(240).optional(),
          toolNames: z.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)).max(300),
        })
        .strict()
        .parse(await readJSON(req, 100000));
      const context = { ...pluginLock.pluginContext, toolNames: p.toolNames };
      json(200, await cronService.request(context, p));
      return;
    }
    if (url.pathname === '/schedules/manage' && req.method === 'POST') {
      const p = z
        .object({
          context: z
            .object({
              ownerId: z.string().uuid(),
              conversationId: z.string().uuid(),
              projectId: z
                .string()
                .regex(/^[a-z0-9-]{1,50}$/)
                .nullable(),
              access: z.enum(['read', 'edit']),
              thinkingLevel: z.enum(['off', 'low', 'high', 'max']),
              target: z.discriminatedUnion('kind', [
                z.object({ kind: z.literal('server') }).strict(),
                z
                  .object({
                    kind: z.literal('computer'),
                    deviceId: z.string().uuid(),
                    execute: z.boolean(),
                  })
                  .strict(),
              ]),
            })
            .strict(),
          data: z
            .object({
              action: z.enum(['tool', 'status']),
              name: z.string().max(30).optional(),
              params: z.record(z.string(), z.unknown()).optional(),
              callId: z.string().max(128).optional(),
            })
            .strict(),
        })
        .strict()
        .parse(await readJSON(req, 30000));
      const context = {
        ...p.context,
        model,
        timeZone: 'Asia/Shanghai',
        toolNames: null,
        skills: [],
        cwd: '/workspace',
      };
      if (context.target.kind === 'server') {
        const projects = await registry.authorize(
          { id: context.ownerId, admin: true },
          context.projectId,
          context.access,
        );
        const selected = projects.find((project) => project.id === context.projectId);
        if (selected?.readOnly && context.access === 'edit')
          throw Object.assign(Error('项目为只读。'), { status: 403 });
        context.cwd = selected?.root || join(privateRoot, 'schedule-workspace');
        await mkdir(context.cwd, { recursive: true, mode: 0o700 });
      }
      json(200, await cronService.request(context, p.data));
      return;
    }
    if (url.pathname === '/schedules/pending' && req.method === 'GET') {
      json(200, await cronService.pending());
      return;
    }
    if (url.pathname === '/schedules/conversation-delete' && req.method === 'POST') {
      const p = z
        .object({ ownerId: z.string().uuid(), conversationId: z.string().uuid() })
        .strict()
        .parse(await readJSON(req, 1000));
      json(200, await cronService.closeConversation(p.ownerId, p.conversationId));
      return;
    }
    if (url.pathname === '/schedules/ack' && req.method === 'POST') {
      const p = z
        .object({
          ownerId: z.string().uuid(),
          id: z.string().uuid(),
          status: z.enum([
            'queued',
            'running',
            'accepted',
            'done',
            'error',
            'cancelled',
            'interrupted',
          ]),
          output: z.string().max(48000).optional(),
          error: z.string().max(2000).optional(),
          startedAt: z.string().optional(),
          finishedAt: z.string().optional(),
          disablePlan: z.boolean().optional(),
        })
        .strict()
        .parse(await readJSON(req, 60000));
      json(200, await cronService.ack(p));
      return;
    }
    if (url.pathname === '/ui-response' && req.method === 'POST') {
      const p = z
        .object({
          sessionKey: z.string().regex(/^[a-f0-9]{64}$/),
          requestId: z.string().uuid(),
          id: z.string().min(1).max(200),
          cancelled: z.boolean().optional(),
          confirmed: z.boolean().optional(),
          value: z.string().max(12000).optional(),
        })
        .strict()
        .parse(await readJSON(req, 14000));
      const current = active.get(p.sessionKey);
      if (!current?.uiResponse || current.requestId !== p.requestId)
        throw Object.assign(new Error('插件请求所属任务已结束。'), { status: 409 });
      const { sessionKey, requestId, ...response } = p;
      current.uiResponse(response);
      json(200, { ok: true });
      return;
    }
    if (url.pathname === '/health' && req.method === 'GET') {
      let pluginActivation;
      try {
        pluginActivation = JSON.parse(await readFile(packagesRoot + '.activation.json', 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      json(200, {
        ready: !!process.env.DEEPSEEK_API_KEY && engineReady,
        pluginActivation: {
          ready: !!pluginActivation?.ready,
          checking: checkingPlugins,
          fallback: engineReady && pluginActivation?.ready === false,
          checkedAt: pluginActivation?.checkedAt,
          plugins: pluginActivation?.plugins,
          diagnostic: pluginActivation?.diagnostic,
        },
        version,
        model,
        projectFiles: true,
        nativeSessions: true,
        streaming: true,
        maxConcurrent: active.maximum,
        maxConcurrentPerUser: active.maxConcurrentPerUser,
        runningCount: active.size,
        memoryReady: active.memoryReady(),
        attachments: true,
        vision: /flash/.test(model),
        webSearch: true,
        skills: (await skillStore.list()).filter((s) => s.enabled).length,
        bash: true,
        scheduledTasks: true,
        pluginHost: cronService.status(),
        node: process.version,
      });
      return;
    }
    if (url.pathname === '/projects' && req.method === 'GET') {
      const principal = requestPrincipal(req);
      const projects = principal ? await registry.listFor(principal) : files.projects();
      files = registry.files;
      json(200, { projects });
      return;
    }
    if (url.pathname === '/projects' && req.method === 'POST') {
      const project = await registry.create(await readJSON(req, 2000), requestPrincipal(req));
      files = registry.files;
      json(201, { project });
      return;
    }
    const route = url.pathname.match(
      /^\/projects\/([a-z0-9-]+)\/(list|read|document|write|search|restore|diff|mkdir|grants|members)$/,
    );
    if (route) {
      const [, id, action] = route;
      const principal = requestPrincipal(req);
      if (['members', 'grants'].includes(action) && principal && !principal.admin)
        throw Object.assign(new Error('Only administrators can grant directory access'), {
          status: 403,
        });
      if (action === 'members') {
        if (req.method === 'GET') {
          json(200, { members: registry.files.project(id).memberGrants || [] });
          return;
        }
        if (req.method === 'POST') {
          const member = z
            .object({
              userId: z.string().uuid(),
              username: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,31}$/),
              access: z.enum(['read', 'edit']).nullable(),
            })
            .strict()
            .parse(await readJSON(req, 2000));
          if ([...active.values()].some((run) => run.ownerId === member.userId))
            throw Object.assign(new Error('请等待此成员的任务结束后变更目录授权。'), {
              status: 409,
            });
          json(200, { members: await registry.members(id, member) });
          files = registry.files;
          return;
        }
      }
      const scopedFiles =
        principal && !principal.admin
          ? createProjectFiles({
              projects: await registry.authorize(
                principal,
                id,
                ['write', 'restore', 'mkdir'].includes(action) ? 'edit' : 'read',
              ),
              backupDir,
            })
          : files;
      if (req.method === 'POST' && ['mkdir', 'grants'].includes(action)) {
        if (action === 'grants' && [...active.values()].some((run) => run.projectId === id))
          throw Object.assign(new Error('请等待此项目的任务结束后变更授权。'), { status: 409 });
        const p = await readJSON(req, 4000);
        const result =
          action === 'mkdir'
            ? await scopedFiles.mkdir(id, p.path)
            : { grants: await registry.grants(id, p.grants) };
        files = registry.files;
        json(200, result);
        return;
      }
      if (action === 'write' && req.method === 'POST') {
        const p = z
          .object({
            path: z.string().min(1).max(500),
            content: z.string().max(262144),
            expectedHash: z.string().regex(/^(?:new|[a-f0-9]{64})$/),
          })
          .strict()
          .parse(await readJSON(req, 2 * 1024 * 1024));
        json(200, await scopedFiles.write(id, p.path, p.content, p.expectedHash, 'edit'));
        return;
      }
      if (req.method === 'GET') {
        if (action === 'document') {
          json(200, await scopedFiles.document(id, url.searchParams.get('path')));
          return;
        }
        if (action === 'list') {
          json(200, await scopedFiles.list(id, url.searchParams.get('path') || '.'));
          return;
        }
        if (action === 'read') {
          json(
            200,
            await scopedFiles.read(
              id,
              url.searchParams.get('path'),
              Number(url.searchParams.get('startLine') || 1),
              200,
            ),
          );
          return;
        }
        if (action === 'search') {
          json(
            200,
            await scopedFiles.search(
              id,
              url.searchParams.get('query'),
              url.searchParams.get('path') || '.',
            ),
          );
          return;
        }
      }
      if ((action === 'restore' || action === 'diff') && req.method === 'POST') {
        if (active.size && action === 'restore')
          throw Object.assign(new Error('Pi 正在运行，请稍后恢复。'), { status: 409 });
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > 1000) throw Object.assign(new Error('请求过大'), { status: 413 });
          chunks.push(c);
        }
        const p = JSON.parse(Buffer.concat(chunks).toString());
        json(200, await scopedFiles[action](id, p.backupId));
        return;
      }
    }
    if (url.pathname === '/skills') {
      if (req.method === 'GET') {
        const query = z
          .object({ packages: z.literal('1').optional() })
          .strict()
          .parse(Object.fromEntries(url.searchParams));
        const owner = query.packages === '1';
        let packagePaths = [],
          warning;
        if (owner) {
          await startupCheck;
          try {
            const activation = JSON.parse(
              await readFile(packagesRoot + '.activation.json', 'utf8'),
            );
            if (!activation.ready) warning = '当前使用内置工具回退，插件技能尚未加载。';
            else
              packagePaths = (await packageResources(process.env.PI_CODING_AGENT_DIR, packagesRoot))
                .skills;
          } catch (e) {
            warning = '插件技能目录无法读取：' + cleanDiagnostic(e.message).slice(0, 300);
          }
        }
        const catalog = await buildSkillCatalog({
          root: skillsRoot,
          managed: await skillStore.list(),
          packagePaths,
          owner,
          includeRemoved: owner,
          cwd: process.env.PI_CODING_AGENT_DIR,
          agentDir: packagesRoot,
          loadSkills,
        });
        json(200, { ...catalog, ...(warning ? { warning } : {}) });
        return;
      }
      if (req.method === 'POST') {
        const definition = await readJSON(req, 80000);
        if (active.size || managingSkills)
          throw Object.assign(new Error('请等待当前任务完成。'), { status: 409 });
        managingSkills = true;
        try {
          await skillStore.save(definition);
          json(200, { skills: await skillStore.list() });
        } finally {
          managingSkills = false;
        }
        return;
      }
    }
    if (url.pathname === '/cancel' && req.method === 'POST') {
      const p = z
        .object({
          sessionKey: z.string().regex(/^[a-f0-9]{64}$/),
          requestId: z.string().uuid().optional(),
        })
        .strict()
        .parse(await readJSON(req, 1000));
      const current = active.get(p.sessionKey);
      if (p.requestId && current && current.requestId !== p.requestId)
        throw Object.assign(new Error('此对话已有其他任务，未停止它。'), { status: 409 });
      current?.cancel?.();
      if (p.requestId && current) {
        const until = Date.now() + 6000;
        while (active.get(p.sessionKey) === current && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 50));
        if (active.get(p.sessionKey) === current)
          throw Object.assign(new Error('旧任务尚未完全停止，请稍后续接。'), { status: 503 });
      }
      json(200, { ok: true });
      return;
    }
    if (url.pathname === '/steer' && req.method === 'POST') {
      const p = await readJSON(req);
      if (
        !/^[a-f0-9-]{36}$/.test(p.id || '') ||
        typeof p.input !== 'string' ||
        !p.input.trim() ||
        p.input.length > 8000
      )
        throw Object.assign(new Error('补充内容格式不正确。'), { status: 400 });
      const current = active.get(p.sessionKey);
      if (current && current.requestId !== p.requestId)
        throw Object.assign(new Error('当前任务已结束，补充未送达。'), { status: 409 });
      if (!current?.steer)
        throw Object.assign(new Error('当前任务正在启动，请稍候补充。'), { status: 503 });
      json(200, await current.steer(p));
      return;
    }
    if (url.pathname === '/sessions/fork' && req.method === 'POST') {
      const p = z
        .object({
          sourceKey: z.string().regex(/^[a-f0-9]{64}$/),
          targetKey: z.string().regex(/^[a-f0-9]{64}$/),
          turnId: z.string().uuid(),
          position: z.enum(['before', 'after']),
          checkpoints: z
            .array(z.object({ from: z.string().uuid(), to: z.string().uuid() }).strict())
            .max(10000)
            .optional(),
          input: z.string().max(8000),
        })
        .strict()
        .parse(await readJSON(req));
      if (active.get(p.targetKey) || forkingSessions.has(p.targetKey))
        throw Object.assign(new Error('目标对话正在使用。'), { status: 409 });
      forkingSessions.add(p.targetKey);
      try {
        json(200, await forkNativeSession(SessionManager, join(privateRoot, 'sessions'), p));
      } finally {
        forkingSessions.delete(p.targetKey);
      }
      return;
    }
    if (url.pathname === '/sessions/delete' && req.method === 'POST') {
      const p = await readJSON(req, 1000);
      validateRun({ ...p, action: 'inspect' });
      if (active.get(p.sessionKey))
        throw Object.assign(new Error('请先停止生成。'), { status: 409 });
      await rm(join(privateRoot, 'sessions', p.sessionKey), { recursive: true, force: true });
      json(200, { ok: true });
      return;
    }
    if (
      ['/run', '/run/stream', '/sessions/inspect', '/sessions/compact'].includes(url.pathname) &&
      req.method === 'POST'
    ) {
      const p = await readJSON(req);
      p.action = url.pathname.endsWith('/inspect')
        ? 'inspect'
        : url.pathname.endsWith('/compact')
          ? 'compact'
          : 'run';
      validateRun(p);
      if (url.pathname === '/run/stream') {
        if (!active.canRun(p.sessionKey, p.ownerId || p.sessionKey) || managingSkills)
          throw Object.assign(new Error('此对话正在执行或并发名额已满。'), { status: 429 });
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        });
        res.flushHeaders();
        const send = (e) => {
          if (!res.destroyed) res.write(JSON.stringify(e) + '\n');
        };
        const heartbeat = setInterval(() => send({ type: 'ping' }), 10000);
        try {
          send(await execute(p, send));
        } catch (e) {
          send({
            type: 'error',
            error: e.message,
            status: e.status || 502,
            diagnostic: e.diagnostic,
            tools: e.tools || [],
          });
        } finally {
          clearInterval(heartbeat);
          res.end();
        }
        return;
      }
      const usageEvents = [];
      try {
        json(200, {
          ...(await execute(p, (e) => {
            if (['response_start', 'usage', 'billing_start', 'billing_usage'].includes(e.type))
              usageEvents.push(e);
          })),
          usageEvents,
        });
      } catch (e) {
        e.usageEvents = usageEvents;
        throw e;
      }
      return;
    }
    json(404, { error: 'Not found' });
  } catch (e) {
    const isPlugin = url.pathname.startsWith('/schedules/') || url.pathname === '/native/cron';
    json(e instanceof z.ZodError ? 400 : e.status || (isPlugin ? 400 : 500), {
      ...(e.usageEvents ? { usageEvents: e.usageEvents } : {}),
      ...(e.diagnostic ? { diagnostic: e.diagnostic } : {}),
      error:
        e instanceof z.ZodError
          ? '请求格式不正确。'
          : e.status || isPlugin
            ? e.message
            : 'Project operation failed',
    });
  }
});
server.requestTimeout = 20000;
server.listen(8790, '0.0.0.0', () => console.log(`Astral Pi bridge ready · Pi ${version}`));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.close();
    server.closeIdleConnections();
    void cronService.close();
    terminal.close();
  });
