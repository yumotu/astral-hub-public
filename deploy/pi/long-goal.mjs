import { createJiti } from 'jiti';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export function latestLongGoal(ctx) {
  const entries = ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i--)
    if (entries[i].type === 'custom' && entries[i].customType === 'pi-goal')
      return entries[i].data?.goal ?? null;
  return null;
}

// Keep upstream sources intact. This adapter only supplies the Pi 1.4 package
// alias, distinct command name, RPC status and interruption/restart semantics.
export default async function longGoal(pi) {
  if (process.env.ASTRAL_LONG_GOAL_ALLOWED === '0') return;
  let command,
    failed = false;
  const quiet = (ctx) => ({ ...ctx, ui: { ...ctx.ui, notify() {} } });
  const publish = (ctx, triggerTurn = false) =>
    ctx.ui.setStatus(
      'astral-long-goal',
      JSON.stringify({ goal: latestLongGoal(ctx), triggerTurn }),
    );
  const pause = async (ctx) => {
    if (latestLongGoal(ctx)?.status === 'active') await command.handler('pause', quiet(ctx));
  };
  const adapter = new Proxy(pi, {
    get(target, property) {
      if (property === 'sendMessage')
        return (message, options) =>
          pi.sendMessage(
            message.customType === 'pi-goal-event' && message.details?.kind === 'resumed'
              ? {
                  ...message,
                  content:
                    message.content +
                    '\n恢复前先核对已保存的对话、进度、文件和执行结果。已完成的操作不重复；结果未知的外部操作先检查原记录，不能擅自重放。',
                }
              : message,
            options,
          );
      if (property === 'registerCommand')
        return (name, spec) => {
          if (name !== 'goal') return pi.registerCommand(name, spec);
          command = spec;
          pi.registerCommand('long-goal', {
            ...spec,
            description: '持续目标：设置目标直到验收，status/pause/resume/clear；仅明确要求时启动',
            async handler(args, ctx) {
              await spec.handler(args, ctx);
              const launch =
                latestLongGoal(ctx)?.status === 'active' &&
                !/^(?:$|status(?:bar)?(?:\s|$)|pause$|clear$)/.test(args.trim());
              publish(ctx, launch);
            },
          });
        };
      if (property === 'registerTool')
        return (spec) => {
          const parameters = structuredClone(spec.parameters);
          if (spec.name === 'create_goal') {
            parameters.properties.objective.maxLength = 10000;
            parameters.properties.objective.minLength = 1;
            parameters.properties.tokenBudget.maximum = Number.MAX_SAFE_INTEGER;
          }
          pi.registerTool({
            ...spec,
            parameters,
            async execute(...args) {
              try {
                return await spec.execute(...args);
              } finally {
                publish(args[4]);
              }
            },
          });
        };
      if (property === 'on')
        return (event, handler) =>
          pi.on(event, async (e, ctx) => {
            if (event === 'session_start') {
              await handler(e, quiet(ctx));
              // A newly started worker must never restart a cancelled/crashed goal
              // merely because an unrelated user prompt followed it.
              await pause(ctx);
              publish(ctx);
              return;
            }
            if (event === 'turn_end')
              failed ||= ['error', 'aborted'].includes(e.message?.stopReason);
            if (event === 'agent_end' && failed) {
              await pause(ctx);
              failed = false;
            } else await handler(e, ctx);
            if (['turn_end', 'agent_end'].includes(event)) publish(ctx);
          });
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const load = createJiti(import.meta.url, {
    interopDefault: true,
    fsCache: false,
    alias: { '@mariozechner/pi-tui': require.resolve('@earendil-works/pi-tui') },
  });
  const upstream = await load.import(
    fileURLToPath(new URL('./vendor/pi-goal/index.ts', import.meta.url)),
  );
  await (upstream.default ?? upstream)(adapter);
  let resumeGoalId = process.env.ASTRAL_RESUME_GOAL_ID;
  pi.on('before_agent_start', async (_event, ctx) => {
    const id = resumeGoalId;
    resumeGoalId = '';
    const current = latestLongGoal(ctx);
    if (id && current?.id === id && current.status === 'paused') {
      await command.handler('resume', { ...quiet(ctx), isIdle: () => false });
      publish(ctx);
    }
  });
}
