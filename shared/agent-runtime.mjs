import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/);
export const agentRuntimeSchema = z
  .object({
    version: z.literal(1),
    backend: z.enum(['pi', 'dsh']),
    transport: z.enum(['server', 'astral-relay', 'dsh-remote']),
    location: z.enum(['server', 'computer']),
    deviceId: id.nullable(),
    // Saved connection profile ID, not an ephemeral Remote wire connection.
    connectionId: z.string().uuid().nullable(),
    projectId: id.nullable(),
    // Existing Pi routing key; does not claim to be the native transcript UUID.
    sessionKey: id,
  })
  .strict()
  .superRefine((value, ctx) => {
    const valid =
      value.transport === 'server'
        ? value.location === 'server' && value.deviceId === null && value.connectionId === null
        : value.transport === 'astral-relay'
          ? value.location === 'computer' &&
            z.string().uuid().safeParse(value.deviceId).success &&
            value.connectionId === null
          : value.backend === 'dsh' && value.deviceId !== null && value.connectionId !== null;
    if (!valid) ctx.addIssue({ code: 'custom', message: 'Agent 后端与执行位置不匹配。' });
  });

export const agentCapabilityNames = Object.freeze([
  'streaming',
  'thinking',
  'steer',
  'attachments',
  'questions',
  'stop',
  'terminal',
  'goal',
  'compact',
  'appFunctions',
]);
export const agentOrigin = (runtime) =>
  runtime.transport === 'dsh-remote' ? 'remote' : runtime.location;

// Availability is a report of a concrete adapter/host, never a file or command grant.
export function agentCapabilities(supported = {}, unavailable = '') {
  return Object.fromEntries(
    agentCapabilityNames.map((name) => {
      const enabled = !unavailable && supported[name] === true;
      return [
        name,
        {
          supported: enabled,
          reason: enabled ? '' : unavailable || '当前后端尚未提供或确认这项能力。',
        },
      ];
    }),
  );
}

export function agentRunState({
  status = 'done',
  phase = '',
  stopPending = false,
  uiRequests,
  connection = 'connected',
} = {}) {
  const stopping = status === 'stopping' || stopPending;
  const busy =
    stopping || ['queued', 'running', 'delivering', 'accepted', 'applied'].includes(status);
  const waitingPhase = /^等待你的|^等待用户/.test(phase);
  const waiting =
    status === 'running' &&
    !stopping &&
    (Array.isArray(uiRequests)
      ? uiRequests.some((r) => ['pending', 'responding'].includes(r.status))
      : waitingPhase);
  const disconnected = busy && !stopping && connection !== 'connected';
  const state = stopping
    ? 'stopping'
    : disconnected
      ? 'disconnected'
      : status === 'running'
        ? waiting
          ? 'waiting'
          : 'executing'
        : status === 'done'
          ? 'complete'
          : status === 'cancelled'
            ? 'stopped'
            : status === 'error'
              ? 'failed'
              : busy
                ? 'queued'
                : 'unknown';
  const label =
    {
      stopping: '正在停止',
      disconnected: '连接中断，正在补回进度',
      waiting: '等待你的回复',
      complete: '已完成',
      stopped: '已停止',
      failed: '执行失败',
      unknown: '已中断，结果待核对',
    }[state] ||
    (state === 'executing'
      ? !phase || waitingPhase || /已完成|已停止|已中断|执行失败/.test(phase)
        ? '正在执行'
        : phase
      : phase || '等待执行');
  return { state, busy, waiting, label, spinning: state === 'executing' || stopping };
}
