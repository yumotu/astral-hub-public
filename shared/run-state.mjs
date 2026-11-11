import { agentRunState } from './agent-runtime.mjs';

export function runState(status = 'done', phase = '', details = {}) {
  return agentRunState({ ...details, status, phase });
}
