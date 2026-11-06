import { Type } from 'typebox';
import { randomUUID } from 'node:crypto';
import { askUserTitle } from './rpc-prompt.mjs';
export default function askUser(pi) {
  pi.registerTool({
    name: 'ask_user',
    label: '询问用户',
    description:
      '缺少必须的信息、用户偏好或决定时提出清楚的问题，暂停等待用户真实答复后继续当前任务。不要猜测答案或自动选择。不得用此工具替代命令、邮件等专门的授权预览。',
    parameters: Type.Object(
      {
        question: Type.String({ minLength: 1, maxLength: 1000 }),
        context: Type.Optional(Type.String({ maxLength: 3000 })),
        options: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
            minItems: 2,
            maxItems: 8,
            uniqueItems: true,
          }),
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, p, signal, _update, ctx) {
      if (!ctx.hasUI) throw Error('当前运行环境不能等待交互答复，请在结果中说明所缺信息。');
      const questionId = randomUUID();
      const record = {
        questionId,
        toolCallId: _id,
        question: p.question,
        context: p.context || '',
      };
      const title = askUserTitle(record);
      pi.appendEntry('astral-question', { ...record, status: 'pending' });
      let answer;
      try {
        if (p.options?.length) {
          const other = '填写其他答案';
          answer = await ctx.ui.select(title, [...p.options.filter((x) => x !== other), other], {
            signal,
          });
          if (answer === other) answer = await ctx.ui.input(title, '请输入你的答案', { signal });
        } else answer = await ctx.ui.input(title, '请输入你的答案', { signal });
      } finally {
        pi.appendEntry('astral-question', {
          ...record,
          status: answer === undefined ? 'cancelled' : 'resolved',
        });
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              answer === undefined
                ? {
                    cancelled: true,
                    instruction: '用户未提供答案，不得假定已同意或继续依赖该答案的步骤。',
                  }
                : { answer },
            ),
          },
        ],
        details: { summary: answer === undefined ? '用户取消了问题' : '已收到用户答复' },
      };
    },
  });
}
