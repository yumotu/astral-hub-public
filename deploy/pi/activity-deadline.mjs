// Bound silence rather than total useful work. Human decisions never time out.
export function activityDeadline(milliseconds, expired) {
  let timer,
    closed = false;
  const waiting = new Set();
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const touch = () => {
    clear();
    if (!closed && !waiting.size)
      timer = setTimeout(() => {
        closed = true;
        expired();
      }, milliseconds);
  };
  touch();
  return {
    touch,
    wait(id) {
      waiting.add(id);
      clear();
    },
    resume(id) {
      waiting.delete(id);
      touch();
    },
    close() {
      closed = true;
      clear();
      waiting.clear();
    },
  };
}
