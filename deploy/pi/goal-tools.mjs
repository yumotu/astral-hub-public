import { Type } from 'typebox';
import { createHash, randomUUID } from 'node:crypto';
export default function (pi) {
  if (!process.env.ASTRAL_GOAL_URL || !process.env.ASTRAL_GOAL_TOKEN) return;
  pi.registerTool({
    name: 'goal_manage',
    label: '目标与计划',
    description:
      '管理当前账号跨对话、跨设备保存的目标。list 查看，inspect 读取完整目标和 revision，create 创建目标和步骤，update 必须提供当前 revision，可修改目标、步骤状态或归档。只有确实完成并验收后才标记 completed/done。目标不会自动执行，定时请使用已有 cron。',
    parameters: Type.Object(
      {
        action: Type.Union(['list', 'inspect', 'create', 'update'].map((x) => Type.Literal(x))),
        id: Type.Optional(Type.String()),
        revision: Type.Optional(Type.Integer({ minimum: 1 })),
        title: Type.Optional(Type.String({ maxLength: 200 })),
        description: Type.Optional(Type.String({ maxLength: 10000 })),
        status: Type.Optional(
          Type.Union(['active', 'paused', 'completed', 'archived'].map((x) => Type.Literal(x))),
        ),
        steps: Type.Optional(
          Type.Array(
            Type.Object(
              {
                id: Type.Optional(Type.String()),
                title: Type.String({ maxLength: 300 }),
                status: Type.Optional(
                  Type.Union(['pending', 'active', 'done'].map((x) => Type.Literal(x))),
                ),
              },
              { additionalProperties: false },
            ),
            { maxItems: 60 },
          ),
        ),
        archived: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    async execute(call, p, signal) {
      const h = createHash('sha256')
        .update(process.env.ASTRAL_REQUEST_ID + ':' + call)
        .digest('hex');
      const id =
        p.id ||
        `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
      const value = {
        ...Object.fromEntries(
          ['title', 'description', 'status']
            .filter((k) => p[k] !== undefined)
            .map((k) => [k, p[k]]),
        ),
        ...(p.steps ? { steps: p.steps.map((s) => ({ ...s, id: s.id || randomUUID() })) } : {}),
      };
      const body =
        p.action === 'create'
          ? { action: 'create', goal: { id, ...value } }
          : p.action === 'update'
            ? { action: 'update', id, patch: { revision: p.revision, ...value } }
            : p.action === 'inspect'
              ? { action: 'inspect', id }
              : { action: 'list', ...(p.archived !== undefined ? { archived: p.archived } : {}) };
      const r = await fetch(process.env.ASTRAL_GOAL_URL, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + process.env.ASTRAL_GOAL_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          signal || new AbortController().signal,
          AbortSignal.timeout(15000),
        ]),
        redirect: 'error',
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || '目标操作失败。');
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        details: {
          summary:
            p.action === 'list'
              ? '查看目标与计划'
              : p.action === 'create'
                ? '创建目标'
                : p.action === 'update'
                  ? '更新目标与计划'
                  : '查看目标',
        },
      };
    },
  });
}
