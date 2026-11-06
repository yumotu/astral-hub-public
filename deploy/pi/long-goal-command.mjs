// These are native runtime controls, never a new model prompt or queued work.
export function longGoalControl(input) {
  const value = typeof input === 'string' ? input.trim() : '';
  return /^\/long-goal(?:\s+(?:pause|clear|status))?$/.test(value) ? value : null;
}
