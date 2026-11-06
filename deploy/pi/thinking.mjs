// The provider exposes three distinct reasoning efforts; avoid duplicate UI levels.
export const thinkingLevels = ['off', 'low', 'high', 'max'];
export function resolveThinkingLevel(level, legacyThinking = false) {
  const resolved = level ?? (legacyThinking ? 'high' : 'off');
  if (!thinkingLevels.includes(resolved))
    throw Object.assign(new Error('思考强度不受支持。'), { status: 400 });
  return resolved;
}
export function configureThinking(model, level) {
  level = resolveThinkingLevel(level);
  const result = structuredClone(model);
  result.reasoning = true;
  result.thinkingLevelMap = {
    off: 'none',
    minimal: null,
    low: 'low',
    medium: null,
    high: 'high',
    xhigh: null,
    max: 'max',
  };
  result.samplingParams = {
    ...result.samplingParams,
    thinking: { type: level === 'off' ? 'disabled' : 'enabled' },
    reasoning_effort: level === 'off' ? 'none' : level,
  };
  result.compat = { ...result.compat, supportsReasoningEffort: true };
  return result;
}
