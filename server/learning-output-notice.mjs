// This intentionally misses ambiguous requests rather than flagging ordinary questions.
export function expectsLearningOutput(input) {
  if (
    /[?？“”「」『』"`]|如何|怎么|怎样|能不能|能否|是否|可否|可以吗|吗|介绍|比如|例如|假如|如果|不要|不用|无需|不必|别|不想|不能/.test(
      input,
    )
  )
    return false;
  return /(?:生成|制定|保存|创建)[^。！？!?\n]{0,30}(?:学习资料|教案|课程)/.test(input);
}

export function learningOutputNotice(input, generated) {
  if (!expectsLearningOutput(input) || generated) return {};
  return {
    learningNotice: {
      expected: true,
      generated: false,
      reason: '本轮未取得学习生成工具返回的课程编号；回复完成不代表学习资料已创建，请核对学习页。',
    },
  };
}
