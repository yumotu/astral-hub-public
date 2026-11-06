import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';

export default function scheduleTools(pi) {
  if (process.env.ASTRAL_CAN_SCHEDULE !== '1' || !process.env.ASTRAL_APP_ACCESS_URL) return;
  async function call(input, callId, signal) {
    const response = await fetch(process.env.ASTRAL_APP_ACCESS_URL, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: 'Bearer ' + process.env.ASTRAL_APP_ACCESS_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'invoke', name: 'schedules.manage', input, callId }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(25000)])
        : AbortSignal.timeout(25000),
    });
    const data = await response.json();
    if (!response.ok || data.state !== 'done')
      throw Error(
        (data.error || '定时任务请求未完成。') +
          ' 原调用编号：' +
          callId +
          '，结果未知时通过app_functions status查询，不能重复创建或执行。',
      );
    return data.result;
  }
  pi.registerTool({
    name: 'schedule_manage',
    label: '管理定时任务',
    description:
      '在当前账号、项目、对话和执行位置创建/查询/修改/运行/暂停/删除定时任务。电脑离线时等待该电脑，不换到服务器。当前仅管理员可用。先list避免重复；create需要name/schedule/prompt，prompt应完整，longGoal:true表示每次持续到验收。默认Asia/Shanghai，schedule可daily 9:00、every 30m、in 2h等。不需要网页常开；执行权限不超过创建时，撤销后停用。发送消息/邮件仍等待用户确认。结果未知用app_functions status查询原callId，不重复创建。',
    parameters: Type.Object(
      {
        action: Type.Union(
          ['list', 'status', 'results', 'create', 'update', 'run', 'pause', 'resume', 'remove'].map(
            (x) => Type.Literal(x),
          ),
        ),
        job: Type.Optional(Type.String({ maxLength: 200 })),
        name: Type.Optional(Type.String({ maxLength: 100 })),
        prompt: Type.Optional(Type.String({ maxLength: 7400 })),
        schedule: Type.Optional(Type.String({ maxLength: 300 })),
        longGoal: Type.Optional(Type.Boolean()),
        tools: Type.Optional(
          Type.Union([Type.Array(Type.String({ maxLength: 128 }), { maxItems: 300 }), Type.Null()]),
        ),
        startAt: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
        endAt: Type.Optional(Type.Union([Type.String({ maxLength: 100 }), Type.Null()])),
      },
      { additionalProperties: false },
    ),
    async execute(id, p, signal) {
      const result = await call(p, id, signal);
      return {
        content: result.content || [{ type: 'text', text: JSON.stringify(result) }],
        details: result.details || {},
      };
    },
  });
  pi.registerCommand('cron', {
    description:
      '当前执行位置定时任务：list、add、show、run、pause、resume、remove、results、status',
    async handler(raw, ctx) {
      const [verb = 'list', ...rest] = raw.trim().split(/\s+/).filter(Boolean),
        job = rest.join(' ');
      let input = { action: verb === 'show' ? 'list' : verb, ...(job ? { job } : {}) };
      if (verb === 'add') {
        const name = await ctx.ui.input('计划名称', 'morning-report');
        if (!name) return;
        const schedule = await ctx.ui.input(
          '执行时间（Asia/Shanghai）',
          'daily 9:00 / every 30m / in 2h',
        );
        if (!schedule) return;
        const prompt = await ctx.ui.input('每次执行的完整任务与验收要求', '');
        if (!prompt?.trim()) return;
        const mode = await ctx.ui.select('每次如何执行', ['执行一次任务', '持续完成并验收目标']);
        if (!mode) return;
        input = {
          action: 'create',
          name,
          schedule,
          prompt,
          longGoal: mode === '持续完成并验收目标',
        };
      }
      try {
        const result = await call(input, randomUUID());
        pi.sendMessage({
          customType: 'astral-cron',
          content:
            (result.content || []).map((c) => c.text || '').join('\n') || JSON.stringify(result),
          display: true,
        });
      } catch (e) {
        ctx.ui.notify(e.message, 'error');
      }
    },
  });
}
