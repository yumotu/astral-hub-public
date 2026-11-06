import { availableParallelism, totalmem } from 'node:os';
// Both schedulers use the host recommendation; the executor also checks its
// current memory headroom before admitting a process. Per-account quotas are gone.
export function recommendedConcurrency({
  cpus = availableParallelism(),
  memoryBytes = totalmem(),
} = {}) {
  return Math.max(
    1,
    Math.min(32, cpus * 4, Math.floor((memoryBytes - 384 * 1024 * 1024) / (160 * 1024 * 1024))),
  );
}
export function concurrencyLimits(maximum, _legacyPerUser) {
  const bounded = (value, fallback, ceiling) => {
    const n = Number(value);
    return Math.max(1, Math.min(ceiling, Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback));
  };
  const maxConcurrent = bounded(maximum, recommendedConcurrency(), 32);
  return {
    maxConcurrent,
    maxConcurrentPerUser: maxConcurrent,
  };
}
