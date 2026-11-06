import { validateSettings } from './data';
import type { Settings } from './types';
export type PiEvent = {
  type: string;
  delta?: string;
  name?: string;
  id?: string;
  path?: string;
  error?: boolean | string;
  [key: string]: unknown;
};
export async function streamPi(
  s: Settings,
  body: unknown,
  event: (e: PiEvent) => void,
  signal?: AbortSignal,
) {
  validateSettings(s);
  const authorization = s.sessionToken || s.token;
  if (!authorization) throw new Error('请先登录账号。');
  const response = await fetch(`${s.url.replace(/\/$/, '')}/api/pi/message`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authorization}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(220000)])
      : AbortSignal.timeout(220000),
  });
  if (!response.ok) {
    const p = await response.json().catch(() => ({}));
    throw new Error(p.error || 'Pi 请求失败。');
  }
  // A retried, completed request can return the stored JSON result.
  if (response.headers.get('content-type')?.includes('application/json')) {
    event({ type: 'done', ...(await response.json()) });
    return;
  }
  if (!response.body) throw new Error('当前客户端不支持流式响应。');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '',
    ended = false,
    size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024) throw new Error('回复过长。');
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        const e = JSON.parse(line);
        if (e.type === 'error') throw new Error(e.error || 'Pi 执行失败或已停止。');
        if (e.type === 'done') ended = true;
        event(e);
      }
    }
    if (!ended || buffer.trim()) throw new Error('连接中断，请刷新对话查看已保存的结果。');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
