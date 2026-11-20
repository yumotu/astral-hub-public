// Acknowledgement is separate from task execution. Only fresh user submissions auto-send.
/** @param {{initial?:any[],send:(payload:any,signal:AbortSignal)=>Promise<any>,lookup:(id:string)=>Promise<any>,persist?:(rows:any[])=>void,maxConcurrent?:number}} options */
export function createMessageOutbox({
  initial = [],
  send,
  lookup,
  persist = () => {},
  maxConcurrent = 4,
}) {
  let closed = false,
    rows = initial
      .filter((r) => r?.payload?.id && r?.payload?.conversationId)
      .map((r) => ({
        ...r,
        status: r.status === 'accepted' ? 'accepted' : 'unknown',
        error: r.status === 'accepted' ? '' : '页面曾断开，请查询送达状态或使用原编号重试。',
      }));
  const listeners = new Set(),
    active = new Map(),
    controllers = new Map();
  const publish = (next, { required = false } = {}) => {
    try {
      persist(next);
    } catch (e) {
      if (required) throw Error('无法保存待发送内容，请先释放浏览器存储空间。');
    }
    rows = next;
    for (const fn of listeners) fn();
  };
  const update = (id, patch) =>
    publish(rows.map((r) => (r.payload.id === id ? { ...r, ...patch } : r)));
  function pump() {
    if (closed) return;
    for (const row of rows) {
      if (active.size >= maxConcurrent) break;
      if (row.status !== 'queued' || active.has(row.payload.conversationId)) continue;
      const previous = rows
        .slice(0, rows.indexOf(row))
        .some(
          (r) =>
            r.payload.conversationId === row.payload.conversationId &&
            ['queued', 'sending', 'unknown'].includes(r.status),
        );
      if (previous) continue;
      const id = row.payload.id,
        conversation = row.payload.conversationId;
      try {
        publish(
          rows.map((r) => (r.payload.id === id ? { ...r, status: 'sending', error: '' } : r)),
          { required: true },
        );
      } catch (e) {
        update(id, { status: 'unknown', error: e.message });
        continue;
      }
      active.set(conversation, id);
      const controller = new AbortController();
      controllers.set(id, controller);
      Promise.resolve()
        .then(() => send(row.payload, controller.signal))
        .then(
          (result) => {
            if (!closed) update(id, { status: 'accepted', error: '', receipt: result });
          },
          (e) => {
            if (!closed)
              update(id, {
                status: e.status >= 400 && e.status < 500 ? 'rejected' : 'unknown',
                error: e.message || '未确认送达，请查询后使用原编号重试。',
              });
          },
        )
        .finally(() => {
          if (active.get(conversation) === id) active.delete(conversation);
          controllers.delete(id);
          pump();
        });
    }
  }
  return {
    snapshot: () => rows,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    add(payload, files = []) {
      if (closed) throw Error('账号已切换，请重新打开对话。');
      if (rows.some((r) => r.payload.id === payload.id)) throw Error('这个请求已在待发送列表中。');
      const next = [
        ...rows,
        {
          payload: structuredClone(payload),
          files: structuredClone(files),
          status: 'queued',
          error: '',
          createdAt: new Date().toISOString(),
        },
      ];
      if (next.length > 500 || JSON.stringify(next).length > 1000000)
        throw Error('本机待确认消息较多，请先处理发送列表。');
      publish(next, { required: true });
      queueMicrotask(pump);
    },
    retry(id) {
      const r = rows.find((r) => r.payload.id === id);
      if (!r || !['unknown', 'rejected'].includes(r.status)) return;
      update(id, { status: 'queued', error: '' });
      pump();
    },
    async reconcile(id) {
      const r = rows.find((r) => r.payload.id === id);
      if (!r || closed) return;
      try {
        const receipt = await lookup(id);
        if (closed) return;
        if (receipt) {
          update(id, { status: 'accepted', error: '', receipt });
          pump();
        } else
          update(id, {
            error: '服务器暂无此请求的确认。可继续查询，或用原编号重试；不会自动生成新编号。',
          });
      } catch (e) {
        if (!closed) update(id, { error: e.message });
      }
    },
    edit(id, input) {
      const r = rows.find((r) => r.payload.id === id);
      if (!r || r.status !== 'queued') throw Error('只有尚未投递的消息可以修改。');
      publish(
        rows.map((r) => (r.payload.id === id ? { ...r, payload: { ...r.payload, input } } : r)),
        { required: true },
      );
    },
    remove(id) {
      const r = rows.find((r) => r.payload.id === id);
      if (r && !['queued', 'rejected'].includes(r.status))
        throw Error('这条消息可能已送达，请先核对。');
      publish(rows.filter((r) => r.payload.id !== id));
    },
    confirm(ids) {
      const accepted = new Set(ids);
      const next = rows.filter((r) => !accepted.has(r.payload.id));
      for (const [conversation, id] of active) if (accepted.has(id)) active.delete(conversation);
      if (next.length !== rows.length) publish(next);
      pump();
    },
    close() {
      closed = true;
      for (const c of controllers.values()) c.abort();
      publish([]);
      listeners.clear();
    },
  };
}
