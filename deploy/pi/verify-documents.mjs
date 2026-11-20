// Synthetic-only acceptance. CI runs this with --network=none, without volumes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readDocumentPages } from './pdf-document.mjs';
import { scannedPdf } from './qa-scanned-pdf.mjs';
if (process.env.ASTRAL_RUNTIME_QA !== '1')
  throw Error('Document acceptance requires disposable QA mode.');
const image = await readFile(new URL('./qa-ocr.jpg', import.meta.url));
const result = await readDocumentPages(scannedPdf(image), {});
assert.equal(result.pages[0].method, 'ocr');
assert.match(result.pages[0].text, /offline OCR 889/);
assert.match(result.pages[0].text.replace(/\s/g, ''), /离线识别文件测试/);
console.log(
  JSON.stringify({
    offlinePdfOcr: true,
    languages: ['chi_sim', 'eng'],
    totalPages: result.totalPages,
    method: result.pages[0].method,
  }),
);
