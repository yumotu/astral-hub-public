import { z } from 'zod';
import { dshPermissions } from './dsh-controls.mjs';

const seq = z.number().int().nonnegative();
const eventSchema = z
  .object({
    type: z.string().min(1).max(200),
    seq,
    time: z.number().finite(),
    data: z.record(z.string(), z.unknown()),
    surfaceOp: z.unknown().optional(),
  })
  .passthrough();
const text = (value, maximum = 512000) =>
  typeof value === 'string' ? value.slice(0, maximum) : '';
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const bounded = (value) => {
  if (JSON.stringify(value).length > 8 * 1024 * 1024)
    throw Error('DSH 对话窗口过大，请减少历史窗口。');
};
function content(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 1000).flatMap((block) => {
    if (!object(block)) return [];
    if (['text', 'reasoning'].includes(block.type))
      return [{ type: block.type, text: text(block.text) }];
    if (block.type === 'tool-call')
      return [
        {
          type: 'tool-call',
          id: text(block.id, 200),
          name: text(block.name, 200),
          arguments: text(block.arguments, 64000),
        },
      ];
    if (['image', 'file'].includes(block.type))
      return [
        {
          type: 'text',
          text: `[${block.type === 'image' ? '图片' : '文件'}附件：此连接暂未接入读取]`,
        },
      ];
    return [];
  });
}
function messageSource(value) {
  return object(value) && value.kind === 'user' && typeof value.rpcId === 'string'
    ? { kind: value.kind, rpcId: text(value.rpcId, 200) }
    : undefined;
}
function displayEvent(input) {
  const e = eventSchema.parse(input),
    d = e.data;
  const base = { type: e.type, seq: e.seq, time: e.time };
  // The transcript uses append-origin records. Compression replacements and
  // request headers remain model context, and must not duplicate human history.
  if (object(e.surfaceOp)) return { ...base, type: 'context/replaced', data: {} };
  const position = {
    turn: Number.isSafeInteger(d.turn) ? d.turn : undefined,
    step: Number.isSafeInteger(d.step) ? d.step : undefined,
  };
  switch (e.type) {
    case 'user/message':
      if (d.source?.kind && d.source.kind !== 'user')
        return { ...base, type: 'context/injected', data: {} };
      return {
        ...base,
        data: {
          ...position,
          content: content(d.content),
          id: text(d.id, 200),
          source: messageSource(d.source),
        },
      };
    case 'assistant/message':
      return {
        ...base,
        data: {
          ...position,
          content: content(d.message?.content),
          interrupted: d.interrupted === true,
        },
      };
    case 'tool/call':
      return {
        ...base,
        data: {
          ...position,
          callId: text(d.callId, 200),
          name: text(d.name, 200),
          arguments: text(d.arguments, 64000),
        },
      };
    case 'tool/result':
      return {
        ...base,
        data: {
          ...position,
          callId: text(d.message?.source?.callId, 200),
          isError: d.message?.isError === true,
          content: content(d.message?.content),
        },
      };
    case 'turn/start':
    case 'step/start':
    case 'step/end':
      return { ...base, data: position };
    case 'turn/end':
      return {
        ...base,
        data: {
          ...position,
          reason: {
            kind: text(d.reason?.kind, 100),
            ...(d.reason?.kind === 'error' ? { error: text(d.reason.error?.message, 16000) } : {}),
          },
        },
      };
    case 'assistant/attempt':
      return { ...base, data: { ...position } };
    default:
      return { ...base, data: {} };
  }
}
function streamBlocks(records) {
  const blocks = {};
  if (!Array.isArray(records) || records.length > 100000) throw Error('DSH 流式快照无效。');
  for (const record of records) {
    if (record.type === 'chunk') chunk(blocks, record.chunk);
    else if (['text-chunks', 'reasoning-chunks'].includes(record.type)) {
      if (!Array.isArray(record.texts)) throw Error('DSH 流式片段无效。');
      chunk(blocks, {
        type: record.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta',
        index: record.index,
        text: record.texts.map((s) => text(s)).join(''),
      });
    } else if (record.type === 'tool-call-chunks')
      chunk(blocks, {
        type: 'tool-call-delta',
        index: record.index,
        id: record.id,
        name: record.name,
        argumentsDelta: (record.args || []).join(''),
      });
  }
  return blocks;
}
function chunk(blocks, part) {
  if (!object(part) || typeof part.type !== 'string') throw Error('DSH 流式片段无效。');
  if (
    !['block-start', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end'].includes(
      part.type,
    )
  )
    return;
  const index = z.number().int().min(0).max(1000).parse(part.index);
  const previous = blocks[index];
  if (part.type === 'block-start') {
    blocks[index] = { type: part.blockType, text: '' };
  } else if (part.type === 'block-end') {
    const parsed = content([part.block])[0];
    if (parsed) blocks[index] = parsed;
  } else if (part.type === 'tool-call-delta') {
    blocks[index] = {
      type: 'tool-call',
      id: text(part.id, 200),
      name: text(part.name || previous?.name, 200),
      arguments: text((previous?.arguments || '') + text(part.argumentsDelta, 64000), 64000),
    };
  } else {
    const kind = part.type === 'reasoning-delta' ? 'reasoning' : 'text';
    if (previous && previous.type !== kind) throw Error('DSH 流式片段类型不一致。');
    blocks[index] = { type: kind, text: text((previous?.text || '') + text(part.text)) };
  }
}
const attempt = (a) => ({
  attemptId: z.string().min(1).max(200).parse(a.attemptId),
  startedAfterSeq: z.number().int().min(-1).parse(a.startedAfterSeq),
  turn: seq.parse(a.turn),
  step: seq.parse(a.step),
  nextIndex: seq.parse(a.nextIndex ?? 0),
  blocks: streamBlocks(a.stream || []),
});
export function emptyDshSession() {
  return {
    cursor: -1,
    events: [],
    assistant: null,
    hasMore: false,
    projections: {},
    projectionSeqs: {},
    interactions: [],
    connection: 'reconnecting',
    updatedAt: 0,
  };
}
function applyProjections(state, values, at) {
  if (!object(values) || !Number.isSafeInteger(at)) return;
  for (const [key, value] of Object.entries(values)) {
    if (
      ![
        'inbox',
        'userQuestions',
        'turnBoundary',
        'title',
        'modelSelection',
        'permissions',
      ].includes(key)
    )
      continue;
    if ((state.projectionSeqs[key] ?? -1) > at) continue;
    state.projectionSeqs[key] = at;
    // Questions are surfaced only through the authenticated interaction carrier.
    // Do not return unvalidated projection data or model/tool configuration.
    if (key === 'permissions') {
      const parsed = dshPermissions.safeParse(value);
      if (parsed.success) state.projections.permissions = parsed.data;
      else delete state.projections.permissions;
    } else if (key === 'title')
      state.projections.title = typeof value === 'string' ? text(value, 500) : '';
    else if (key === 'turnBoundary' && object(value))
      state.projections.turnBoundary = {
        openTurnStartSeq:
          value.openTurnStartSeq === null ? null : seq.parse(value.openTurnStartSeq),
      };
    else if (key === 'inbox' && object(value))
      state.projections.inbox = ['next-turn', 'next-step'].flatMap((kind) =>
        Array.isArray(value[kind])
          ? value[kind].slice(0, 1000).map((m) => ({
              id: text(m?.id, 200),
              rpcId: text(m?.source?.rpcId, 200),
              text: content(m?.content)
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join('\n'),
            }))
          : [],
      );
    else if (key === 'modelSelection' && object(value)) {
      const model = value.next || value.lastUsed || value;
      state.projections.modelSelection = {
        provider: text(model?.provider, 200),
        model: text(model?.model, 200),
        reasoningEffort: text(model?.reasoningEffort, 100),
      };
    }
  }
}
export function applyDshFrame(previous, frame, sessionId, now = Date.now()) {
  bounded(frame);
  let state = structuredClone(previous);
  if (frame.type === 'snapshot') {
    if (frame.header?.id !== sessionId || !Array.isArray(frame.records))
      throw Error('DSH 会话身份或快照不符。');
    state = emptyDshSession();
    state.cursor = z.number().int().min(-1).parse(frame.cursor);
    state.events = frame.records.map((r) => {
      if (r?.type !== 'event') throw Error('DSH 历史格式不受支持。');
      return displayEvent(r.event);
    });
    if (
      state.events.some(
        (e, i) => e.seq > state.cursor || (i > 0 && e.seq <= state.events[i - 1].seq),
      )
    )
      throw Error('DSH 历史顺序无效。');
    state.hasMore = frame.hasMore === true;
    state.assistant = frame.assistantStream?.activeAttempt
      ? attempt(frame.assistantStream.activeAttempt)
      : null;
    applyProjections(state, frame.projections?.values, frame.projections?.asOfSeq);
    state.connection = 'connected';
  } else if (frame.type === 'event') {
    const e = displayEvent(frame.event);
    if (e.seq <= state.cursor) return previous;
    if (e.seq !== state.cursor + 1) throw Error('DSH 进度出现间隙，需要重新读取快照。');
    state.events.push(e);
    state.cursor = e.seq;
    if (
      state.assistant &&
      e.data.turn === state.assistant.turn &&
      (e.type === 'turn/end' ||
        (['assistant/message', 'assistant/attempt'].includes(e.type) &&
          e.data.step === state.assistant.step))
    )
      state.assistant = null;
  } else if (frame.type === 'assistant-stream') {
    const f = frame.frame;
    if (f?.type === 'start') state.assistant = attempt(f);
    else if (f?.type === 'chunk') {
      const a = state.assistant;
      if (!a || f.attemptId !== a.attemptId) throw Error('DSH 实时输出缺少起点。');
      if (f.index < a.nextIndex) return previous;
      if (f.index !== a.nextIndex) throw Error('DSH 实时输出出现间隙。');
      chunk(a.blocks, f.chunk);
      a.nextIndex++;
    } else if (f?.type === 'end' && f.attemptId === state.assistant?.attemptId) {
      if (
        f.outcome?.kind === 'abandoned' ||
        (f.outcome?.kind === 'committed' && f.outcome.seq <= state.cursor)
      )
        state.assistant = null;
    }
  } else if (frame.type === 'projections') applyProjections(state, frame.values, frame.seq);
  else if (frame.type === 'interaction') {
    const value = frame.interaction;
    state.interactions = [...state.interactions.filter((r) => r.id !== value.id), value];
  } else if (frame.type === 'interaction-resolved')
    state.interactions = state.interactions.filter((r) => r.id !== frame.id);
  else if (frame.type === 'disconnected') {
    state.connection = 'reconnecting';
    state.interactions = state.interactions.map((r) => ({ ...r, answerable: false }));
  }
  // Keep a bounded display window; older messages remain on the DSH host.
  if (state.events.length > 12000) {
    state.events = state.events.slice(-12000);
    state.hasMore = true;
  }
  state.updatedAt = now;
  bounded(state);
  return state;
}
export function dshSessionView(state, { stopPending = false } = {}) {
  const messages = [],
    tools = [];
  let status = 'done',
    phase = '',
    error = '';
  const addMessage = (e, role, blocks) => {
    const output = blocks
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
    const thinking = blocks
      .filter((b) => b.type === 'reasoning')
      .map((b) => b.text)
      .join('\n');
    if (output || thinking)
      messages.push({
        id: String(e.seq),
        role,
        text: output,
        thinking,
        time: e.time,
        rpcId: e.data.source?.rpcId,
      });
  };
  for (const e of state.events) {
    if (e.type === 'user/message') addMessage(e, 'user', e.data.content);
    else if (e.type === 'assistant/message') addMessage(e, 'assistant', e.data.content);
    else if (e.type === 'tool/call')
      tools.push({
        id: e.data.callId,
        name: e.data.name,
        arguments: e.data.arguments,
        status: 'running',
        time: e.time,
      });
    else if (e.type === 'tool/result') {
      const tool = tools.findLast((t) => t.id === e.data.callId);
      if (tool)
        Object.assign(tool, {
          status: e.data.isError ? 'error' : 'done',
          output: e.data.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n'),
        });
    } else if (e.type === 'turn/start') {
      status = 'running';
      phase = '正在执行';
      error = '';
    } else if (e.type === 'turn/end') {
      const kind = e.data.reason.kind;
      status =
        kind === 'completed'
          ? 'done'
          : kind === 'aborted'
            ? 'cancelled'
            : ['error', 'max-tokens', 'blocked'].includes(kind)
              ? 'error'
              : 'interrupted';
      error = e.data.reason.error || '';
      phase = '';
    }
  }
  const turn = state.projections.turnBoundary;
  if (turn?.openTurnStartSeq != null) status = 'running';
  if (state.assistant) {
    status = 'running';
    addMessage(
      { seq: 'live:' + state.assistant.attemptId, time: state.updatedAt, data: {} },
      'assistant',
      Object.values(state.assistant.blocks),
    );
  }
  if (state.projections.inbox?.length && status !== 'running') status = 'queued';
  const uiRequests = state.interactions
    .filter((r) => r.answerable)
    .map((r) => ({ id: r.id, status: 'pending' }));
  // A late timed question may remain answerable after its foreground turn ended.
  if (uiRequests.length) {
    status = 'running';
    phase = '等待你的回复';
  }
  return {
    messages,
    tools,
    status,
    phase,
    error,
    stopPending,
    connection: state.connection,
    uiRequests,
    interactions: state.interactions,
    queue: state.projections.inbox || [],
    model: state.projections.modelSelection || null,
    permissions: state.projections.permissions || null,
    cursor: state.cursor,
    hasMore: state.hasMore,
    firstSeq: state.events[0]?.seq ?? null,
  };
}

export function prependDshPage(state, page) {
  bounded(page);
  if (!Array.isArray(page?.records)) throw Error('DSH 历史页无效。');
  const events = page.records.map((r) => {
    if (r?.type !== 'event') throw Error('DSH 历史格式不受支持。');
    return displayEvent(r.event);
  });
  if (
    events.some(
      (e, i) =>
        e.seq >= (state.events[0]?.seq ?? Infinity) || (i > 0 && e.seq <= events[i - 1].seq),
    )
  )
    throw Error('DSH 历史页与当前快照不符。');
  const next = { ...state, events: [...events, ...state.events], hasMore: page.hasMore === true };
  bounded(next);
  return next;
}
