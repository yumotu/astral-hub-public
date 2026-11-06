// Preserve the first visible fragment and event order while avoiding thousands of
// single-character database writes and browser updates per answer.
export function createStreamWriter(send, {
  interval = 40,
  maxChars = 2048,
  now = () => performance.now(),
  schedule = setTimeout,
  unschedule = clearTimeout,
} = {}) {
  let buffered, timer, lastType, lastAt = -Infinity, closed = false;
  const emit = (event) => {
    lastAt = now();
    lastType = event.type;
    send(event);
  };
  const flush = () => {
    if (timer !== undefined) unschedule(timer);
    timer = undefined;
    if (buffered) {
      const event = buffered;
      buffered = undefined;
      emit(event);
    }
  };
  const write = (event) => {
    if (closed) return;
    if (!['text_delta', 'thinking_delta'].includes(event.type) || typeof event.delta !== 'string') {
      flush();
      emit(event);
      return;
    }
    if (!event.delta) return;
    if (buffered && buffered.type !== event.type) flush();
    if (lastType !== event.type || now() - lastAt >= interval) {
      flush();
      emit(event);
      return;
    }
    buffered = { type: event.type, delta: (buffered?.delta || '') + event.delta };
    if (buffered.delta.length >= maxChars) flush();
    else if (timer === undefined)
      timer = schedule(flush, Math.max(1, interval - (now() - lastAt)));
  };
  return { write, flush, close() { flush(); closed = true; } };
}
