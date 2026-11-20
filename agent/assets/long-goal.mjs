import { createJiti } from 'jiti';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
import { latestGoalPlan, parseGoalPlan, goalPlanComplete } from './goal-plan.mjs';

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
  const publish = (ctx, triggerTurn = false) => {
    const goal = latestLongGoal(ctx);
    ctx.ui.setStatus(
      'astral-long-goal',
      JSON.stringify({
        goal: goal ? { ...goal, plan: latestGoalPlan(ctx, goal.id) } : null,
        triggerTurn,
      }),
    );
  };
  const planRules =
    '持续目标必须先用goal_plan保存可执行步骤与验收标准，并随实际进度更新；完成步骤记录真实证据，验收标准逐条验证。get_goal可读取同目标的计划版本，goal_plan使用revision避免旧更新覆盖。遇到缺失信息用ask_user等待真实答案，恢复后核对同一目标/计划/已完成动作，不重做未知外部操作。普通任务不自动建目标。';
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
                    '\n' +
                    planRules +
                    '\n恢复前先核对已保存的对话、进度、文件和执行结果。已完成的操作不重复；结果未知的外部操作先检查原记录，不能擅自重放。',
                }
              : message.customType === 'pi-goal-event'
                ? { ...message, content: message.content + '\n' + planRules }
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
            promptGuidelines: [...(spec.promptGuidelines || []), planRules],
            parameters,
            async execute(...args) {
              try {
                const ctx = args[4],
                  goal = latestLongGoal(ctx),
                  plan = goal ? latestGoalPlan(ctx, goal.id) : null;
                if (spec.name === 'update_goal' && !goalPlanComplete(plan))
                  return {
                    isError: true,
                    content: [
                      {
                        type: 'text',
                        text: '尚未完成计划与逐项验收。先用goal_plan更新实际步骤和对应证据，不能仅凭最终回答标记完成。',
                      },
                    ],
                  };
                const result = await spec.execute(...args);
                if (spec.name === 'get_goal')
                  return {
                    ...result,
                    content: [...result.content, { type: 'text', text: JSON.stringify({ plan }) }],
                  };
                return result;
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
  pi.registerTool({
    name: 'goal_plan',
    label: '目标任务计划',
    description:
      '保存当前明确目标的TODO和验收证据。先get_goal读plan，首次revision=0，后续用最新版本。只有真实完成才标done并附证据；verification逐条对应criteria。与当前会话目标绑定，不启动新目标。',
    parameters: Type.Object(
      {
        revision: Type.Integer({ minimum: 0 }),
        criteria: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
          minItems: 1,
          maxItems: 20,
        }),
        items: Type.Array(
          Type.Object(
            {
              id: Type.String({ minLength: 1, maxLength: 100 }),
              text: Type.String({ minLength: 1, maxLength: 500 }),
              status: Type.Union(['pending', 'running', 'done'].map((v) => Type.Literal(v))),
              evidence: Type.Optional(Type.String({ maxLength: 2000 })),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 100 },
        ),
        verification: Type.Array(
          Type.Object(
            {
              criterion: Type.String({ minLength: 1, maxLength: 500 }),
              evidence: Type.String({ minLength: 1, maxLength: 2000 }),
            },
            { additionalProperties: false },
          ),
          { maxItems: 20 },
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, p, _signal, _update, ctx) {
      const goal = latestLongGoal(ctx);
      if (goal?.status !== 'active') throw Error('当前没有活动目标；普通任务不会自动创建目标。');
      const old = latestGoalPlan(ctx, goal.id);
      if (p.revision !== (old?.revision || 0))
        throw Error('目标计划已变化，请先get_goal读取最新版本。');
      const plan = parseGoalPlan({ ...p, goalId: goal.id, revision: p.revision + 1 });
      pi.appendEntry('astral-goal-plan', plan);
      publish(ctx);
      return {
        content: [{ type: 'text', text: JSON.stringify({ plan }) }],
        details: { plan, todos: plan.items },
      };
    },
  });
  let resumeGoalId = process.env.ASTRAL_RESUME_GOAL_ID;
  pi.on('before_agent_start', async (event, ctx) => {
    const id = resumeGoalId;
    resumeGoalId = '';
    const current = latestLongGoal(ctx);
    if (id && current?.id === id && current.status === 'paused') {
      await command.handler('resume', { ...quiet(ctx), isIdle: () => false });
      publish(ctx);
    }
    if (latestLongGoal(ctx)?.status === 'active')
      return { systemPrompt: event.systemPrompt + '\n' + planRules };
  });
}
