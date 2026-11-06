import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { documentContent, documentReadOptions } from './pdf-content.mjs';
import { attachmentMaxBytes } from './attachment-limits.mjs';

export async function readDocumentPages(bytes, options = {}, { signal, onProgress } = {}) {
  documentReadOptions(options);
  if (bytes.length > attachmentMaxBytes) return Promise.reject(Error('附件超过50 MiB。'));
  if (signal?.aborted) return Promise.reject(Error('附件读取已取消。'));
  const directory = await mkdtemp(join(tmpdir(), 'astral-document-'));
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { bytes, options: { ...options, ocrDirectory: directory } },
        resourceLimits: { maxOldGenerationSizeMb: 192 },
      });
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        void worker.terminate().finally(() => (error ? reject(error) : resolve(result)));
      };
      const cancel = () => finish(Error('附件读取已取消。'));
      const timer = setTimeout(
        () => finish(Error('本批页面解析或识别超时。可减小pageLimit分批读取，附件原件仍可访问。')),
        120000,
      );
      signal?.addEventListener('abort', cancel, { once: true });
      worker.on('message', (message) => {
        if (message.progress) onProgress?.(message.progress);
        else finish(message.error ? Error(message.error) : null, message.result);
      });
      worker.once('error', (error) => finish(error));
      worker.once('exit', () => finish(Error('文档识别进程已结束，原附件未修改。')));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (!isMainThread && workerData?.options) {
  try {
    const require = createRequire(process.env.ASTRAL_DOCUMENT_DEPS || '/extensions/package.json');
    const result = await documentContent(Buffer.from(workerData.bytes), workerData.options, {
      require,
      progress: (progress) => parentPort.postMessage({ progress }),
    });
    parentPort.postMessage({ result });
  } catch (error) {
    const message = /password|Password/.test(error.message)
      ? 'PDF已加密，需要提供解密后的文件。'
      : /Invalid PDF|PDF header|PDF structure|invalid pdf/i.test(error.message)
        ? 'PDF结构损坏或不是有效PDF，无法读取原始页面。'
        : error.message || '附件解析失败；原始文件仍存在，不能据此断言无法访问。';
    parentPort.postMessage({ error: message });
  }
}
