import { z } from 'zod';
const majors = [
  ['愚者', 'The Fool', '新的开始、自由、信任', '冲动、准备不足、犹豫'],
  ['魔术师', 'The Magician', '行动、创造、整合资源', '分心、资源闲置、意图不清'],
  ['女祭司', 'The High Priestess', '直觉、沉静、内在智慧', '忽视直觉、信息不全、过度猜测'],
  ['皇后', 'The Empress', '滋养、丰盛、创造力', '过度付出、依赖、忽视自己'],
  ['皇帝', 'The Emperor', '结构、责任、稳定', '控制欲、僵化、边界失衡'],
  ['教皇', 'The Hierophant', '学习、传统、共同价值', '质疑惯例、独立探索、价值冲突'],
  ['恋人', 'The Lovers', '联结、选择、价值一致', '沟通分歧、犹豫、价值偏离'],
  ['战车', 'The Chariot', '方向、意志、自律', '方向不清、内耗、操之过急'],
  ['力量', 'Strength', '耐心、勇气、温柔的坚持', '自我怀疑、疲惫、压抑感受'],
  ['隐者', 'The Hermit', '独处、反思、寻找指引', '封闭、孤立、逃避交流'],
  ['命运之轮', 'Wheel of Fortune', '变化、周期、机会', '抵抗变化、失控感、重复模式'],
  ['正义', 'Justice', '公平、事实、承担责任', '偏见、失衡、回避后果'],
  ['倒吊人', 'The Hanged Man', '暂停、换位思考、放下', '停滞、无谓牺牲、难以放手'],
  ['死神', 'Death', '结束、转变、更新', '留恋过去、抗拒告别、拖延转变'],
  ['节制', 'Temperance', '平衡、调和、循序渐进', '失衡、急躁、节奏混乱'],
  ['恶魔', 'The Devil', '觉察束缚、欲望、依赖模式', '松绑、重建选择、面对依赖'],
  ['高塔', 'The Tower', '旧结构瓦解、真相、重建', '畏惧变化、回避现实、内部震荡'],
  ['星星', 'The Star', '希望、修复、信念', '失去信心、疲倦、需要滋养'],
  ['月亮', 'The Moon', '情绪、潜意识、不确定', '澄清误会、辨认恐惧、迷雾渐散'],
  ['太阳', 'The Sun', '清晰、喜悦、生命力', '短暂低落、期待过高、忽略小确幸'],
  ['审判', 'Judgement', '觉醒、回顾、回应召唤', '自我苛责、逃避复盘、迟疑'],
  ['世界', 'The World', '完成、整合、迈入新阶段', '未完成之事、缺少收尾、停留原处'],
];
const suits = [
  ['wands', '权杖', 'Wands', '行动、热情与创造', '急躁、耗竭或行动受阻', '✦'],
  ['cups', '圣杯', 'Cups', '情感、关系与感受', '情感堵塞、依赖或沟通偏差', '☾'],
  ['swords', '宝剑', 'Swords', '思考、沟通与判断', '过度思考、冲突或误解', '✧'],
  ['pentacles', '星币', 'Pentacles', '资源、生活与积累', '资源失衡、急于求成或忽略基础', '✷'],
];
const ranks = [
  ['王牌', 'Ace', '新机会与起点'],
  ['二', 'Two', '选择与平衡'],
  ['三', 'Three', '合作与成长'],
  ['四', 'Four', '稳定与休整'],
  ['五', 'Five', '冲突与调整'],
  ['六', 'Six', '交流与恢复'],
  ['七', 'Seven', '检视与坚持'],
  ['八', 'Eight', '练习与推进'],
  ['九', 'Nine', '积累与独立'],
  ['十', 'Ten', '阶段成果与负担'],
  ['侍从', 'Page', '学习与好奇'],
  ['骑士', 'Knight', '探索与投入'],
  ['王后', 'Queen', '成熟的照顾与理解'],
  ['国王', 'King', '负责的引领与管理'],
];
export const deck = [
  ...majors.map(([name, en, upright, reversed], i) => ({
    id: `major-${i}`,
    number: i,
    name,
    en,
    upright,
    reversed,
    suit: 'major',
    symbol: [
      '☀',
      '✦',
      '☾',
      '❀',
      '♜',
      '✧',
      '♡',
      '➶',
      '∞',
      '✧',
      '☸',
      '⚖',
      '☽',
      '✿',
      '☯',
      '♢',
      'ϟ',
      '✦',
      '☾',
      '☀',
      '♧',
      '◎',
    ][i],
  })),
  ...suits.flatMap(([suit, name, en, up, rev, symbol]) =>
    ranks.map(([rank, rankEn, meaning], i) => ({
      id: `${suit}-${i + 1}`,
      number: i + 1,
      name: `${name}${rank}`,
      en: `${rankEn} of ${en}`,
      upright: `${meaning}；${up}`,
      reversed: `${meaning}的课题；${rev}`,
      suit,
      symbol,
    })),
  ),
];
export const spreads = {
  single: { name: '一日指引', subtitle: '给此刻的自己，一点灵感', positions: ['此刻的指引'] },
  three: {
    name: '时间之流',
    subtitle: '从过去，看见下一步',
    positions: ['过去的回响', '当下的能量', '未来的方向'],
  },
};
export const drawSchema = z
  .object({ question: z.string().trim().min(1).max(1000), spread: z.enum(['single', 'three']) })
  .strict();
export const cardSchema = z
  .object({
    id: z.string().refine((id) => deck.some((c) => c.id === id)),
    reversed: z.boolean(),
    position: z.string().max(50),
  })
  .strict();
export const interpretationSchema = z.object({
  summary: z.string().min(1).max(6000),
  cards: z
    .array(z.object({ title: z.string().min(1).max(200), text: z.string().min(1).max(5000) }))
    .min(1)
    .max(3),
  advice: z.array(z.string().min(1).max(1000)).min(1).max(5),
});
export const readingSchema = z
  .object({
    id: z.string().uuid(),
    createdAt: z.string().datetime(),
    question: z.string().min(1).max(1000),
    spread: z.enum(['single', 'three']),
    cards: z.array(cardSchema).min(1).max(3),
    analysis: interpretationSchema.nullable(),
    source: z.enum(['local', 'deepseek']),
    model: z.string().max(100).optional(),
  })
  .strict()
  .superRefine((r, ctx) => {
    const expected = spreads[r.spread].positions;
    if (
      r.cards.length !== expected.length ||
      new Set(r.cards.map((c) => c.id)).size !== r.cards.length ||
      r.cards.some((c, i) => c.position !== expected[i])
    )
      ctx.addIssue({ code: 'custom', message: '牌阵数量、位置或唯一性不正确' });
    if (r.analysis && r.analysis.cards.length !== r.cards.length)
      ctx.addIssue({ code: 'custom', message: '解读数量与牌阵不匹配' });
    if (r.source === 'deepseek' && !r.analysis)
      ctx.addIssue({ code: 'custom', message: 'DeepSeek 记录必须包含解读' });
  });
export const pluginSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/),
    name: z.string().min(1).max(40),
    version: z.literal('1.0.0'),
    description: z.string().min(1).max(300),
    icon: z.enum(['sparkles', 'book', 'moon']).default('sparkles'),
    prompt: z.string().min(20).max(8000),
    inputLabel: z.string().min(1).max(80),
    inputPlaceholder: z.string().max(200),
    capabilities: z.array(z.literal('ai.text')).length(1),
  })
  .strict();
