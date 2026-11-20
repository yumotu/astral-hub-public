import { z } from 'zod';
const job = z.string().trim().min(1).max(200),
  tools = z
    .array(z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/))
    .max(300)
    .nullable();
const fields = {
  name: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(7400),
  schedule: z.string().trim().min(1).max(300),
  longGoal: z.boolean(),
  tools,
  startAt: z.string().max(100).nullable(),
  endAt: z.string().max(100).nullable(),
};
export const scheduleActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), job: job.optional() }).strict(),
  z.object({ action: z.literal('status') }).strict(),
  z.object({ action: z.literal('results'), job: job.optional() }).strict(),
  z
    .object({
      action: z.literal('create'),
      ...fields,
      longGoal: fields.longGoal.default(false),
      tools: tools.optional(),
      startAt: fields.startAt.optional(),
      endAt: fields.endAt.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('update'),
      job,
      ...Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.optional()])),
    })
    .strict(),
  ...['run', 'pause', 'resume', 'remove'].map((action) =>
    z.object({ action: z.literal(action), job }).strict(),
  ),
]);
export function cronAction(input, callId) {
  const p = scheduleActionSchema.parse(input),
    { action, longGoal, ...params } = p;
  if (longGoal !== undefined) {
    if (!params.prompt && action === 'update') throw Error('更改持续模式时需要提供完整任务说明。');
    if (params.prompt && longGoal && !params.prompt.startsWith('/long-goal '))
      params.prompt = '/long-goal ' + params.prompt;
    if (params.prompt && !longGoal) params.prompt = params.prompt.replace(/^\/long-goal\s+/, '');
  }
  if (['create', 'update'].includes(action)) params.deliver = [];
  if (action === 'pause' || action === 'resume') params.enabled = action === 'resume';
  const names = {
    list: 'cron_list',
    create: 'cron_create',
    update: 'cron_update',
    run: 'cron_run',
    pause: 'cron_update',
    resume: 'cron_update',
    remove: 'cron_delete',
    results: 'cron_results',
  };
  return action === 'status'
    ? { action: 'status' }
    : { action: 'tool', name: names[action], params, callId };
}
