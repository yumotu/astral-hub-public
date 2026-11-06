import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fail } from './accounts.mjs';
import { validQuestionContinuation } from '../deploy/pi/question-continuation.mjs';
export const questionReplySchema = z
  .object({ id: z.string().min(1).max(200), value: z.string().trim().min(1).max(4000) })
  .strict();
export function questionContinuation(owner, task, reply) {
  if (!task) throw fail(404, '原任务不存在。');
  const request = task.uiRequests?.find((r) => r.id === reply.id);
  if (
    task.status !== 'interrupted' ||
    task.parentId ||
    task.assistance ||
    request?.source !== 'ask_user' ||
    !['input', 'select'].includes(request.method) ||
    (request.status !== 'pending' && !request.continuedAs)
  )
    throw fail(409, '只有中断任务中尚未回答的助手问题可以续接；授权确认和已停止任务不能恢复。');
  const hash = createHash('sha256')
    .update(JSON.stringify([owner, task.id, request.questionId]))
    .digest('hex');
  const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
  const answerHash = createHash('sha256').update(reply.value).digest('hex');
  if (request.continuedAs && (request.continuedAs !== id || request.answerHash !== answerHash))
    throw fail(409, '此问题已按其他答案续接，请在新任务中继续补充。');
  const resumeQuestion = {
    version: 1,
    previousTaskId: task.id,
    questionId: request.questionId,
    toolCallId: request.toolCallId,
    question: request.title,
    context: request.message || '',
    answer: reply.value,
    previousInput: task.input.slice(0, 800),
    goalId: task.longGoal?.status === 'active' ? task.longGoal.id : null,
  };
  if (!validQuestionContinuation(resumeQuestion))
    throw fail(409, '旧版问题缺少可验证的续接信息，请核对记录后发送新消息。');
  return { id, answerHash, resumeQuestion, reused: !!request.continuedAs };
}
export function continuedQuestions(requests, reply, continuation) {
  return requests.map((r) => ({
    ...r,
    status: 'resolved',
    ...(r.id === reply.id
      ? { continuedAs: continuation.id, answerHash: continuation.answerHash }
      : {}),
  }));
}
