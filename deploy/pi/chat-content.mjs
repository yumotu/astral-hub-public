import { readOfficeAttachment } from './document-text.mjs';
import { readDocumentPages } from './pdf-document.mjs';
import { imageMime } from './attachments.mjs';
import { createHash } from 'node:crypto';

// Process-local to the authorized native task/session. Callers validate the live
// attachment scope and hash before using it, and remote callers recheck the lease.
const documents = new Map();
async function documentPages(bytes, options, signal) {
  const key =
    createHash('sha256').update(bytes).digest('hex') +
    ':' +
    JSON.stringify([
      options.startPage ?? 1,
      options.pageLimit ?? 3,
      options.mode ?? 'auto',
      options.format || 'pdf',
    ]);
  for (const [id, item] of documents) if (Date.now() - item.at > 600000) documents.delete(id);
  if (signal?.aborted) throw Error('附件读取已取消。');
  const old = documents.get(key);
  if (old) {
    documents.delete(key);
    documents.set(key, old);
    return old.value;
  }
  const value = await readDocumentPages(bytes, options, { signal });
  const size = value.pages.reduce((sum, p) => sum + p.text.length, 0);
  documents.set(key, { value, size, at: Date.now() });
  let total = [...documents.values()].reduce((sum, p) => sum + p.size, 0);
  for (const [id, item] of documents) {
    if (documents.size <= 8 && total <= 4e6) break;
    documents.delete(id);
    total -= item.size;
  }
  return value;
}

export async function chatContent(bytes, file, p = {}, { signal } = {}) {
  let text, document;
  const image = imageMime(bytes);
  if (bytes.subarray(0, 5).toString() === '%PDF-' || image) {
    document = await documentPages(bytes, { ...p, ...(image ? { format: 'image' } : {}) }, signal);
    text = document.pages
      .map(
        (page) =>
          `[第${page.page}页 · ${page.method === 'ocr' ? 'OCR识别' : '文字提取'}]\n${page.text}`,
      )
      .join('\n\n');
  } else if (/\.(docx|xlsx)$/i.test(file.name)) {
    const result = await readOfficeAttachment(bytes, file.name);
    text =
      result.kind === 'document'
        ? result.text
        : result.sheets
            .map((s) => `工作表：${s.name}\n${s.rows.map((r) => r.join('\t')).join('\n')}`)
            .join('\n\n');
    if (result.truncated) text += '\n[文档预览已截断，请分批读取较小文件]';
  } else {
    try {
      if (bytes.includes(0)) throw Error();
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw Error(
        '此格式暂不能提取文字。原始附件可下载；获得项目修改权限后可用chat_save保存原件，再使用该执行位置的工具解析。不要据此断言文件不存在。',
      );
    }
  }
  const lines = text.split('\n'),
    startLine = p.startLine || 1,
    limit = p.limit || 200;
  const selected = lines.slice(startLine - 1, startLine - 1 + limit).join('\n');
  return {
    name: file.name,
    content: selected.slice(0, 24000),
    startLine,
    totalLines: lines.length,
    sha256: file.sha256,
    truncated:
      selected.length > 24000 || startLine - 1 + limit < lines.length || !!document?.nextPage,
    ...(document
      ? {
          totalPages: document.totalPages,
          nextPage: document.nextPage,
          pages: document.pages.map(({ text, ...page }) => ({
            ...page,
            characters: text.trim().length,
          })),
          ...(document.warning ? { warning: document.warning } : {}),
          ...(!document.pages.some((p) => p.text.trim())
            ? {
                status: 'no_text',
                warning:
                  '已实际读取原文件并尝试识别所选页面，没有识别出文字；原件仍可访问，不代表整份文件为空。',
              }
            : {}),
        }
      : {}),
  };
}
