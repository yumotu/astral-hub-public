export function learningFixture(choiceCount = 1, shortCount = 1) {
  return {
    title: '哈希表的冲突处理 · 合成验收',
    explanation:
      '## 核心原理\n哈希表通过哈希函数确定存放位置。不同键映射到相同位置时会发生冲突。\n\n## 分步示例\n设桶数为5，键12与17都映射到桶2。链地址法将它们放在同一桶的链表中；开放寻址法则继续寻找空位。\n\n## 常见误区\n哈希冲突并不等于键相同，比较时仍需检查原始键。\n\n## 总结\n负载因子是元素数与桶数的比值，扩容通常能降低冲突。此内容是界面测试替身，不是实际模型输出。' +
      '\n\n合成验收补充：'.repeat(120),
    questions: [
      ...Array.from({ length: choiceCount }, (_, i) => ({
        kind: 'choice',
        prompt:
          (i ? '哈希冲突意味着两个键一定相同吗？' : '链地址法如何处理冲突？') +
          `（合成选择${i + 1}）`,
        options: i
          ? ['不一定，需要比较原始键', '一定相同']
          : ['同一桶内保存多个键', '丢弃后来的键'],
        correctIndex: 0,
        explanation: '同一桶可以保存不同键，需要比较原始键以找到对应值。',
      })),
      ...Array.from({ length: shortCount }, (_, i) => ({
        kind: 'short',
        prompt: `解释负载因子与查找性能的关系。（合成问答${i + 1}）`,
        referenceAnswer: '负载因子是元素数与桶数的比值，过高通常增加冲突。',
        rubric: ['说明比值', '解释冲突与性能'],
        explanation: '负载因子过高时可以扩容并重新散列。',
      })),
    ],
  };
}
