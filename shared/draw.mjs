import { deck, spreads } from './deck.mjs';
function secureInt(max) {
  const limit = 0x100000000 - (0x100000000 % max);
  let n;
  do {
    n = crypto.getRandomValues(new Uint32Array(1))[0];
  } while (n >= limit);
  return n % max;
}
export function drawReading(question, spread) {
  const pool = [...deck];
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    question,
    spread,
    cards: spreads[spread].positions.map((position) => ({
      id: pool.splice(secureInt(pool.length), 1)[0].id,
      reversed: !!secureInt(2),
      position,
    })),
    analysis: null,
    source: 'local',
  };
}
