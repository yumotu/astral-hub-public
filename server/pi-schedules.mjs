import { z } from 'zod';
const uuid = z.string().uuid();
export const scheduledRunSchema = z
  .object({
    id: uuid,
    ownerId: uuid,
    conversationId: uuid,
    jobId: z.string().min(1).max(200),
    jobName: z.string().min(1).max(200),
    scheduledAt: z.string().min(1).max(300),
    input: z.string().min(1).max(8000),
    projectId: z
      .string()
      .regex(/^[a-z0-9-]{1,50}$/)
      .nullable(),
    access: z.enum(['read', 'edit']),
    thinkingLevel: z.enum(['off', 'low', 'high', 'max']),
    model: z.string().max(100).optional(),
    timeZone: z.string().max(100),
    toolAllowlist: z
      .array(z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/))
      .max(300)
      .nullable(),
    skills: z.array(z.string().max(1000)).max(100),
    target: z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('server') }).strict(),
        z.object({ kind: z.literal('computer'), deviceId: uuid, execute: z.boolean() }).strict(),
      ])
      .optional(),
    status: z.string().max(30),
    createdAt: z.string(),
    updatedAt: z.string().optional(),
    output: z.string().max(48000),
    error: z.string().max(2000),
    startedAt: z.string().optional(),
    finishedAt: z.string().optional(),
  })
  .strict();

export function createPiSchedulePump({
  bridge,
  tasks,
  ownerAllowed,
  scope,
  completed,
  computer,
  interval = 1000,
}) {
  let busy = false,
    closed = false;
  async function tick() {
    if (busy || closed) return;
    busy = true;
    try {
      const result = await bridge('/schedules/pending');
      if (!Array.isArray(result.runs)) return; // Older bridges do not advertise scheduling.
      for (const raw of result.runs.slice(0, 100)) {
        const parsed = scheduledRunSchema.safeParse(raw);
        if (!parsed.success) continue;
        const run = parsed.data;
        try {
          if (!ownerAllowed(run.ownerId)) throw new Error('计划所属账号已停用或不再是管理员。');
          let task;
          if (run.target?.kind === 'computer') {
            if (!computer) throw Object.assign(Error('电脑定时任务分发不可用。'), { status: 503 });
            task = await computer(run);
            if (!task)
              throw Object.assign(Error('目标电脑队列未就绪，保持等待；不会改发服务器。'), {
                status: 503,
              });
          } else task = tasks.get(run.ownerId, run.id);
          if (!task) {
            const saved = completed(run.ownerId, run.id);
            if (saved) {
              await bridge('/schedules/ack', {
                ownerId: run.ownerId,
                id: run.id,
                status: 'done',
                output: saved.output || '',
                finishedAt: saved.created_at || new Date().toISOString(),
              });
              continue;
            }
            const bound = scope(run.ownerId, run.conversationId);
            if (bound && (bound.projectId !== run.projectId || bound.access !== run.access))
              throw new Error('目标对话的项目或权限模式已改变，请修改定时计划。');
            task = tasks.add(run.ownerId, {
              id: run.id,
              conversationId: run.conversationId,
              input: run.input,
              projectId: run.projectId,
              access: run.access,
              thinkingLevel: run.thinkingLevel,
              attachments: [],
              attachmentFiles: [],
              mode: 'queue',
              parentId: null,
              toolAllowlist: run.toolAllowlist,
              skills: run.skills,
              schedule: {
                jobId: run.jobId,
                jobName: run.jobName,
                scheduledAt: run.scheduledAt,
                timeZone: run.timeZone,
              },
            });
          }
          await bridge('/schedules/ack', {
            ownerId: run.ownerId,
            id: run.id,
            status:
              task.status === 'queued'
                ? 'accepted'
                : task.status === 'stopping'
                  ? 'running'
                  : task.status,
            ...(task.output ? { output: task.output.slice(0, 48000) } : {}),
            ...(task.error ? { error: task.error.slice(0, 2000) } : {}),
            ...(task.startedAt ? { startedAt: task.startedAt } : {}),
            ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
          });
        } catch (e) {
          if (e.status === 429) continue; // Backpressure: leave the durable submission pending.
          if (e.status && e.status >= 500) continue;
          await bridge('/schedules/ack', {
            ownerId: run.ownerId,
            id: run.id,
            status: 'error',
            error: String(e.message).slice(0, 2000),
            disablePlan: true,
            finishedAt: new Date().toISOString(),
          }).catch(() => {});
        }
      }
    } catch {
      /* A disconnected bridge keeps its submissions; retry the read, never the work. */
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(() => void tick(), interval);
  timer.unref();
  return {
    tick,
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
}
