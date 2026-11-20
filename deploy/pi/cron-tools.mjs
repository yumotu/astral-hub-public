import { loadCron } from './native-cron.mjs';

export default async function (pi) {
  const { createCronTools } = await loadCron('src/tools.ts');
  async function call(data, signal) {
    const response = await fetch(process.env.ASTRAL_PLUGIN_ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: 'Bearer ' + process.env.ASTRAL_PLUGIN_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ...data, toolNames: pi.getAllTools().map((t) => t.name) }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '常驻插件宿主不可用。');
    return result;
  }
  for (const tool of Object.values(createCronTools(pi))) {
    pi.registerTool({
      ...tool,
      description: tool.description.replace(
        /Jobs are kept across restarts but only run while pi is open; slots missed while pi was closed run once at the next start\./,
        '星屿服务器常驻调度，无需保持网页或对话打开；结果回到创建计划的对话。',
      ),
      async execute(id, params, signal) {
        return call({ action: 'tool', name: tool.name, params, callId: id }, signal);
      },
    });
  }
  const show = (content) =>
    pi.sendMessage({ customType: 'astral-cron', content, display: true, details: {} });
  pi.registerCommand('cron', {
    description: '服务器定时任务：list、add、show、run、pause、resume、remove、results、status',
    async handler(raw, ctx) {
      const [action = 'list', ...parts] = raw.trim().split(/\s+/).filter(Boolean),
        job = parts.join(' ');
      const execute = (name, params) =>
        call({
          action: 'tool',
          name,
          params,
          callId: process.env.ASTRAL_REQUEST_ID + ':' + action,
        });
      try {
        if (action === 'status') {
          const status = await call({ action: 'status' });
          show(
            `服务器调度器：${status.active ? '运行中' : '未启动'}\n时区：${status.timeZone}\n计划：${status.jobs} · 待处理执行：${status.pending}\n${status.next ? '下一次触发：' + status.next : '暂无下一次触发'}${status.error ? '\n错误：' + status.error : ''}`,
          );
          return;
        }
        let result;
        if (action === 'list') result = await execute('cron_list', {});
        else if (action === 'show') result = await execute('cron_list', { job });
        else if (action === 'results') result = await execute('cron_results', job ? { job } : {});
        else if (action === 'run') result = await execute('cron_run', { job });
        else if (['pause', 'resume'].includes(action))
          result = await execute('cron_update', { job, enabled: action === 'resume' });
        else if (['remove', 'delete'].includes(action)) {
          if (!job) throw new Error('请提供计划名称。');
          if (
            !(await ctx.ui.confirm('删除定时计划？', job + '。已经开始的执行请在聊天中单独停止。'))
          ) {
            show('已取消删除。');
            return;
          }
          result = await execute('cron_delete', { job });
        } else if (action === 'add') {
          const name = await ctx.ui.input('计划名称', 'morning-report');
          if (!name) {
            show('已取消创建。');
            return;
          }
          const schedule = await ctx.ui.input(
            '执行时间（Asia/Shanghai）',
            'daily 9:00 / every 30m / in 2h',
          );
          if (!schedule) {
            show('已取消创建。');
            return;
          }
          const prompt = await ctx.ui.editor('每次执行的完整任务要求', '');
          if (!prompt?.trim()) {
            show('已取消创建。');
            return;
          }
          result = await execute('cron_create', { name, schedule, prompt, deliver: [] });
        } else
          throw new Error('支持：list、add、show、run、pause、resume、remove、results、status。');
        show(
          result.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n'),
        );
      } catch (e) {
        ctx.ui.notify(e.message, 'error');
      }
    },
  });
}
