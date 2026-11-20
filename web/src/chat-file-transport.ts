import { validateSettings } from './data.ts';
import type { Settings } from './types.ts';
import { attachmentMaxBytes, attachmentSizeMessage } from '../../deploy/pi/attachment-limits.mjs';

export type ChatFile = {
  id: string;
  name: string;
  bytes: number;
  sha256?: string;
  createdAt?: string;
  source?: 'dsh';
};
function fileBase(conversation: string, source?: 'dsh') {
  return source === 'dsh' ? `/api/agent/remote/conversations/${conversation}/files` : `/api/pi/conversations/${conversation}/files`;
}
function headers(settings: Settings) {
  return { Authorization: 'Bearer ' + (settings.sessionToken || settings.token) };
}
export async function fetchChatFile(
  settings: Settings,
  conversation: string,
  file: ChatFile,
  signal?: AbortSignal,
) {
  validateSettings(settings);
  const response = await fetch(
    `${settings.url.replace(/\/$/, '')}${fileBase(conversation, file.source)}/${file.id}`,
    {
      headers: headers(settings),
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
        : AbortSignal.timeout(120000),
    },
  );
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `读取附件失败（HTTP ${response.status}）。`);
  }
  if (Number(response.headers.get('content-length')) > attachmentMaxBytes)
    throw new Error(attachmentSizeMessage);
  const blob = await response.blob();
  if (blob.size > attachmentMaxBytes) throw new Error(attachmentSizeMessage);
  if (blob.size !== file.bytes) throw new Error('附件下载不完整，请重新打开。');
  if (file.sha256) {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    const actual = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
    if (actual !== file.sha256) throw new Error('附件摘要校验失败，请重新打开。');
  }
  return blob;
}
export async function uploadChatFile(
  settings: Settings,
  conversation: string,
  file: File,
  options: { signal?: AbortSignal; timeout?: number; source?: 'dsh' } = {},
): Promise<ChatFile> {
  validateSettings(settings);
  if (file.size > attachmentMaxBytes) throw new Error(attachmentSizeMessage);
  const deadline = AbortSignal.timeout(options.timeout ?? 120000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const checkAbort = () => {
    if (options.signal?.aborted) throw new DOMException('已取消附件上传。', 'AbortError');
    if (deadline.aborted) throw new Error('附件上传超时，结果尚未确认。请检查网络后重新选择。');
  };
  let response: Response;
  try {
    response = await fetch(
      `${settings.url.replace(/\/$/, '')}${fileBase(conversation, options.source)}?name=${encodeURIComponent(file.name)}`,
      {
        method: 'POST',
        headers: { ...headers(settings), 'Content-Type': 'application/octet-stream' },
        body: file,
        signal,
        redirect: 'error',
      },
    );
  } catch {
    checkAbort();
    throw new Error('无法上传附件。请检查网络，或将文件保存到本机后重新选择。');
  }
  let data;
  try {
    data = await response.json();
  } catch {
    checkAbort();
    throw new Error(
      response.ok
        ? '服务器响应格式不正确，附件上传结果尚未确认。'
        : `服务器拒绝附件（HTTP ${response.status}），请检查服务器连接。`,
    );
  }
  checkAbort();
  if (!response.ok) throw new Error(data?.error || `文件上传失败（HTTP ${response.status}）。`);
  if (
    typeof data?.file?.id !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(data.file.id) ||
    typeof data.file.name !== 'string' ||
    data.file.bytes !== file.size
  )
    throw new Error('服务器响应格式不正确，附件上传结果尚未确认。');
  return data.file;
}
