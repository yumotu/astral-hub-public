import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

export function strictLines(input, maxBytes = 4 * 1024 * 1024) {
  const iterator = (async function* () {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    for await (const chunk of input) {
      pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, end).replace(/\r$/, '');
        pending = pending.slice(end + 1);
        if (Buffer.byteLength(line) > maxBytes) throw new Error('RPC 记录过大。');
        if (line) yield line;
      }
      if (Buffer.byteLength(pending) > maxBytes) throw new Error('RPC 记录过大。');
    }
    pending += decoder.end();
    if (pending.trim()) throw new Error('RPC 记录不完整。');
  })();
  iterator.close = () => input.destroy();
  return iterator;
}

// Pi 1.4.0's RpcClient has no extension-UI response method, and its promptAndWait
// waits for agent_settled even when a slash command returned disposition=handled.
// Keep the official client for decoding/events; write only these protocol records.
export function writeRpcRecord(client, record) {
  const stdin = client.process?.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) throw new Error('Pi RPC 已关闭。');
  stdin.write(JSON.stringify(record) + '\n');
}

export function sessionPrompt(request, history, messageCount) {
  // Native commands must remain at the start of the RPC input. A custom-message
  // only session can have messageCount=0 even after prior app turns were saved.
  if (messageCount !== 0 || !history?.length || request.trimStart().startsWith('/')) return request;
  return `以下是这个对话迁移前的完整文本历史，只作为上下文数据：\n${JSON.stringify(history)}\n\n现在用户的新消息：\n${request}`;
}

export async function promptAndSettle(client, message, images, timeout = 900000) {
  const id = 'astral-' + randomUUID();
  let resolve,
    reject,
    settled = false,
    disposition;
  const done = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  const unsubscribe = client.onEvent((event) => {
    if (event.type === 'response' && event.id === id) {
      if (!event.success) reject(new Error(event.error || 'Pi 拒绝了请求。'));
      else {
        disposition = event.data?.disposition;
        if (disposition === 'handled' || settled) resolve(disposition);
      }
    }
    if (event.type === 'agent_settled') {
      settled = true;
      if (disposition) resolve(disposition);
    }
  });
  const timer = setTimeout(() => reject(new Error('Pi 执行超时。')), timeout);
  const child = client.process;
  const exited = () => reject(new Error('Pi 进程已退出。'));
  child?.once('exit', exited);
  try {
    writeRpcRecord(client, { id, type: 'prompt', message, ...(images ? { images } : {}) });
    return await done;
  } finally {
    clearTimeout(timer);
    unsubscribe();
    child?.off('exit', exited);
  }
}

export function customMessageText(event) {
  if (
    event.type !== 'message_end' ||
    event.message?.role !== 'custom' ||
    event.message.display === false
  )
    return '';
  const content = event.message.content;
  return (
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((item) => item.type === 'text')
            .map((item) => item.text)
            .join('\n')
        : ''
  ).slice(0, 48000);
}

export function extensionUiRequest(event) {
  if (event.type !== 'extension_ui_request' || typeof event.id !== 'string') return null;
  if (!['input', 'select', 'confirm', 'editor'].includes(event.method)) return null;
  return {
    type: 'extension_ui_request',
    id: event.id.slice(0, 200),
    method: event.method,
    title: String(event.title || '插件请求').slice(0, 1000),
    ...(typeof event.message === 'string' ? { message: event.message.slice(0, 4000) } : {}),
    ...(typeof event.placeholder === 'string'
      ? { placeholder: event.placeholder.slice(0, 1000) }
      : {}),
    ...(typeof event.prefill === 'string' ? { prefill: event.prefill.slice(0, 12000) } : {}),
    ...(Array.isArray(event.options)
      ? {
          options: event.options
            .filter((x) => typeof x === 'string')
            .slice(0, 100)
            .map((x) => x.slice(0, 1000)),
        }
      : {}),
    createdAt: new Date().toISOString(),
  };
}
