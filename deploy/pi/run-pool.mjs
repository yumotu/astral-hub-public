import { timingSafeEqual } from 'node:crypto';
import { concurrencyLimits } from './concurrency.mjs';

// One native session per conversation; tokens and controls never cross lanes.
export function createRunPool(
  capacity,
  perUser,
  { availableMemory = () => process.availableMemory?.() || Infinity } = {},
) {
  const runs = new Map();
  const { maxConcurrent: maximum, maxConcurrentPerUser } = concurrencyLimits(capacity, perUser);
  const memoryReady = () => availableMemory() >= 160 * 1024 * 1024;
  let maintenance = null;
  return {
    maximum,
    maxConcurrentPerUser,
    memoryReady,
    get size() {
      return runs.size;
    },
    get: (key) => runs.get(key),
    values: () => runs.values(),
    canRun: (key, owner = key) =>
      !maintenance && !runs.has(key) && runs.size < maximum && memoryReady(),
    acquire(key, value) {
      if (maintenance || runs.has(key) || runs.size >= maximum || !memoryReady())
        throw Object.assign(new Error('此对话正在执行或并发名额已满。'), { status: 429 });
      runs.set(key, value);
      return value;
    },
    release(key, value) {
      if (runs.get(key) !== value) return;
      runs.delete(key);
      if (maintenance === key) maintenance = null;
    },
    byToken(token) {
      const supplied = Buffer.from(token || '');
      return [...runs.values()].find((r) => {
        const expected = Buffer.from(r.pluginToken);
        return supplied.length === expected.length && timingSafeEqual(supplied, expected);
      });
    },
    maintenance(key, acquire) {
      if (!acquire) {
        if (maintenance === key) maintenance = null;
        return;
      }
      if (!runs.has(key) || runs.size !== 1 || (maintenance && maintenance !== key))
        throw Object.assign(new Error('其他对话仍在运行；插件变更需等待其结束后再执行。'), {
          status: 409,
        });
      maintenance = key;
    },
  };
}
