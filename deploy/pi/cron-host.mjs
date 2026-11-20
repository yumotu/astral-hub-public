// Long-lived, model-free host for the installed pi-cron tools and scheduling core.
// Execution is handed to Astral's durable queue instead of pi-cron's bare `pi -p`.
import { loadCron } from './native-cron.mjs';
import { attachJsonlLineReader } from '/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/jsonl.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createCronLedger, cronTerminal } from './cron-ledger.mjs';
import { sameScheduleScope, ownsScheduleScope } from './cron-scope.mjs';
const { createCronTools } = await loadCron('src/tools.ts');
const store = await loadCron('src/core/store.ts');
const { planTick } = await loadCron('src/core/scheduler.ts');
const { paths } = await loadCron('src/core/paths.ts');
const home = process.env.PI_CRON_HOME;
mkdirSync(home, { recursive: true, mode: 0o700 });
const ledger = createCronLedger(join(home, 'astral-runs.sqlite'), process.env.ASTRAL_OWNER_ID);
let lastError = '',
  ticking = false;
function reportCompleted() {
  for (const run of ledger.unreported()) {
    const startedAt = run.startedAt || run.createdAt,
      finishedAt = run.finishedAt || run.updatedAt;
    const outputPath = join(paths.outputDir(run.jobId), run.id + '.md');
    mkdirSync(paths.outputDir(run.jobId), { recursive: true });
    writeFileSync(outputPath, `# ${run.jobName}\n\n${run.output || run.error || run.status}\n`, {
      mode: 0o600,
    });
    const status = { done: 'ok', error: 'error', cancelled: 'aborted', interrupted: 'crashed' }[
      run.status
    ];
    store.writeJsonAtomic(join(paths.runsDir(run.jobId), run.id + '.json'), {
      jobId: run.jobId,
      jobName: run.jobName,
      status,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      exitCode: run.status === 'done' ? 0 : null,
      outputPath,
      error: run.error || null,
      delivery: {},
    });
    store.mutateJobs((jobs) => ({
      jobs: jobs.map((j) =>
        j.id === run.jobId
          ? {
              ...j,
              running: null,
              lastRunAt: startedAt,
              lastStatus: status,
              lastOutputPath: outputPath,
              runCount: ledger.all().filter((r) => r.jobId === j.id && cronTerminal.has(r.status))
                .length,
            }
          : j,
      ),
      result: undefined,
    }));
    ledger.reported(run.id);
  }
}
function tick(now = new Date()) {
  if (ticking) return;
  ticking = true;
  try {
    reportCompleted();
    store.mutateJobs((jobs) => {
      const contexts = new Map(jobs.map((j) => [j.id, ledger.context(j.id)]));
      const original = new Map(jobs.map((j) => [j.id, j]));
      // Running/unknown operations are owned by the durable ledger, never by a PID.
      // Reuse upstream's schedule/window/catch-up calculations without replaying its
      // automatic "dead PID means run again" policy.
      const eligible = jobs
        .filter((j) => contexts.get(j.id) && !ledger.active(j.id))
        .map((j) => ({ ...j, running: null }));
      const plan = planTick(eligible, now, () => true);
      for (const job of plan.due)
        ledger.enqueue(job, original.get(job.id).nextRunAt, contexts.get(job.id));
      const changed = new Map(plan.jobs.map((j) => [j.id, { ...j, running: null }]));
      return { jobs: jobs.map((j) => changed.get(j.id) || j), result: undefined };
    });
    lastError = '';
  } catch (e) {
    lastError = String(e.message).slice(0, 500);
  } finally {
    ticking = false;
  }
}
function status() {
  const jobs = store.loadJobs();
  return {
    active: true,
    timeZone: process.env.TZ,
    jobs: jobs.length,
    pending: ledger.pending().length,
    unbound: jobs.filter((j) => !ledger.context(j.id)).length,
    error: lastError,
    next:
      jobs
        .filter((j) => j.enabled && j.nextRunAt)
        .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))[0]?.nextRunAt || null,
  };
}
async function request(p) {
  if (p.action === 'close_conversation') {
    store.mutateJobs((jobs) => ({
      jobs: jobs.map((j) =>
        ledger.context(j.id)?.conversationId === p.conversationId ? { ...j, enabled: false } : j,
      ),
      result: undefined,
    }));
    return { ok: true };
  }
  if (p.action === 'pending') {
    tick();
    return { runs: ledger.pending(), status: status() };
  }
  if (p.action === 'ack') {
    if (p.run.disablePlan) {
      const run = ledger.get(p.run.id);
      if (run)
        store.mutateJobs((jobs) => ({
          jobs: jobs.map((j) => (j.id === run.jobId ? { ...j, enabled: false } : j)),
          result: undefined,
        }));
    }
    ledger.update(p.run.id, p.run);
    reportCompleted();
    return { ok: true };
  }
  if (p.action === 'status') return status();
  if (p.action !== 'tool') throw new Error('不支持的调度操作。');
  const context = p.context,
    params = p.params || {};
  const pi = {
    getAllTools: () => (context.toolNames || params.tools || []).map((name) => ({ name })),
  };
  const scopedJobs = store
    .loadJobs()
    .filter((j) => ownsScheduleScope(ledger.context(j.id), context));
  if (params.job) {
    const target = store.findJob(scopedJobs, params.job);
    if (!target) throw new Error('当前对话、项目和执行位置没有这个计划。');
    params.job = target.id;
  }
  if (p.name === 'cron_results') {
    const ids = new Set(
      scopedJobs.filter((j) => !params.job || j.id === params.job).map((j) => j.id),
    );
    const runs = ledger
      .all()
      .filter((r) => ids.has(r.jobId))
      .slice(-50);
    return {
      content: [{ type: 'text', text: JSON.stringify({ runs }) }],
      details: { runs, scheduler: status() },
    };
  }
  const tools = Object.values(
    createCronTools(pi, {
      schedulerActive: () => true,
      runNow: (job) => {
        if (ledger.active(job.id)) return false;
        const scope = ledger.context(job.id);
        if (!scope) throw new Error('计划尚未绑定星屿项目和对话，请重新创建。');
        ledger.enqueue(job, 'manual:' + p.callId, scope);
        return true;
      },
    }),
  );
  const tool = tools.find((t) => t.name === p.name);
  if (!tool) throw new Error('定时工具不存在。');
  if (['cron_create', 'cron_update'].includes(p.name)) {
    if (params.prompt && params.prompt.length > 7700)
      throw new Error('定时任务说明最多 7700 字符。');
    if (params.cwd && params.cwd !== context.cwd) throw new Error('定时任务必须使用当前所选项目。');
    if (params.model && ![context.model, 'astral-deepseek/' + context.model].includes(params.model))
      throw new Error('此执行器暂只支持当前服务器模型。');
    if (params.deliver?.length) throw new Error('当前结果通过星屿聊天交付，请将 deliver 留空。');
    if (params.skills?.some((s) => !context.skills.includes(s)))
      throw new Error('定时任务只能加载当前已启用的技能路径。');
  }
  const toggle =
    p.name === 'cron_update' &&
    params.enabled !== undefined &&
    Object.keys(params).every((k) => ['job', 'enabled'].includes(k));
  if (['cron_update', 'cron_run'].includes(p.name) && !(toggle && params.enabled === false)) {
    const target = store.findJob(store.loadJobs(), params.job);
    const scope = target && ledger.context(target.id);
    if (scope && !sameScheduleScope(scope, context))
      throw new Error('请在创建此计划的项目与模式中修改计划。');
  }
  const result = await tool.execute(p.callId, params, undefined, undefined, { cwd: context.cwd });
  if (p.name === 'cron_list') {
    const jobs = (result.details?.jobs || []).filter((j) =>
      ownsScheduleScope(ledger.context(j.id), context),
    );
    return {
      content: [{ type: 'text', text: JSON.stringify({ jobs }) }],
      details: { jobs, scheduler: status() },
    };
  }
  if ((p.name === 'cron_create' || (p.name === 'cron_update' && !toggle)) && result.details?.job)
    ledger.bind(result.details.job.id, context);
  // Do not auto-trigger between creation and the durable context binding.
  tick();
  return { ...result, details: { ...result.details, scheduler: status() } };
}
let chain = Promise.resolve();
const detach = attachJsonlLineReader(process.stdin, (line) => {
  chain = chain.then(async () => {
    let p;
    try {
      if (Buffer.byteLength(line) > 128 * 1024) throw new Error('调度请求过大。');
      p = JSON.parse(line);
      process.stdout.write(JSON.stringify({ id: p.id, result: await request(p) }) + '\n');
    } catch (e) {
      process.stdout.write(
        JSON.stringify({ id: p?.id, error: String(e.message).slice(0, 1000) }) + '\n',
      );
    }
  });
});
const timer = setInterval(tick, 1000);
tick();
process.stdout.write(JSON.stringify({ type: 'ready' }) + '\n');
function stop() {
  clearInterval(timer);
  detach();
  chain.finally(() => {
    ledger.close();
    process.exit(0);
  });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.on('end', stop);
