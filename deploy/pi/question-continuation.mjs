const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function validQuestionContinuation(p) {
  return (
    !!p &&
    p.version === 1 &&
    uuid.test(p.previousTaskId) &&
    uuid.test(p.questionId) &&
    [
      ['toolCallId', 200],
      ['question', 1000],
      ['context', 3000],
      ['answer', 4000],
      ['previousInput', 800],
    ].every(([key, max]) => typeof p[key] === 'string' && p[key].length <= max) &&
    !!p.toolCallId &&
    !!p.question &&
    !!p.answer.trim() &&
    (p.goalId === null ||
      (typeof p.goalId === 'string' && p.goalId.length > 0 && p.goalId.length <= 200)) &&
    Object.keys(p).every((key) =>
      [
        'version',
        'previousTaskId',
        'questionId',
        'toolCallId',
        'question',
        'context',
        'answer',
        'previousInput',
        'goalId',
      ].includes(key),
    )
  );
}
export function questionPrompt(input, continuation) {
  if (!continuation) return input;
  if (!validQuestionContinuation(continuation) || input !== continuation.answer)
    throw Error('问题续接信息无效。');
  return (
    '[用户已明确回答中断任务的问题，这是新续接任务]\n' +
    JSON.stringify(continuation) +
    '\n先核对原生历史、保存的进度和已执行工具的真实结果，再使用上述真实答复继续原任务。不要重发原任务、不要重复已经完成的操作，结果未知的外部操作必须先查原记录。其他未答问题仍须询问，不能猜测。此答复只提供问题信息，不替代命令、发邮件等专门授权。原有授权范围保持，不能通过恢复扩大。'
  );
}
