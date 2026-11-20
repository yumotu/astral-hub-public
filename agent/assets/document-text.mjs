import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { officeContent } from './office-content.mjs';

export function readOfficeAttachment(bytes, name, { depsFile } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { bytes, name },
      env: { ASTRAL_DOCUMENT_DEPS: depsFile || process.env.ASTRAL_DOCUMENT_DEPS || '/extensions/package.json' },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    const timer = setTimeout(() => {
      reject(new Error('文档解析超时，请缩小文件后重试。'));
      void worker.terminate();
    }, 25000);
    let settled = false;
    worker.once('message', ({ result, error }) => {
      settled = true;
      clearTimeout(timer);
      error ? reject(new Error(error)) : resolve(result);
      void worker.terminate();
    });
    worker.once('error', (error) => {
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    worker.once('exit', () => {
      clearTimeout(timer);
      if (!settled) reject(new Error('文档解析进程已结束。'));
    });
  });
}
if (!isMainThread) {
  try {
    const require = createRequire(process.env.ASTRAL_DOCUMENT_DEPS || '/extensions/package.json');
    const result = await officeContent(Buffer.from(workerData.bytes), workerData.name, {
      mammoth: require('mammoth'),
      readExcelFile: require('read-excel-file/universal').default,
      unzipSync: require('fflate').unzipSync,
    });
    parentPort.postMessage({ result });
  } catch (error) {
    parentPort.postMessage({ error: error.message || '文档解析失败。' });
  }
}
