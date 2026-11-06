import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { extractText } from 'unpdf';
import { readDocumentPages } from '../assets/pdf-document.mjs';
import { chatContent } from '../assets/chat-content.mjs';
import { documentFixtures } from '../../tests/fixtures/document-files.mjs';
import { scannedPdf } from '../../tests/fixtures/scanned-pdf.mjs';

test(
  'bundled OCR reads real raster PDF and image Chinese/English offline, while text PDFs retain direct extraction and page cursors',
  { timeout: 120000 },
  async (t) => {
    const previous = process.env.ASTRAL_DOCUMENT_DEPS;
    process.env.ASTRAL_DOCUMENT_DEPS = fileURLToPath(new URL('../package.json', import.meta.url));
    t.after(() =>
      previous === undefined
        ? delete process.env.ASTRAL_DOCUMENT_DEPS
        : (process.env.ASTRAL_DOCUMENT_DEPS = previous),
    );
    const image = await readFile(new URL('../../tests/fixtures/ocr-text.jpg', import.meta.url));
    const scan = scannedPdf(image);
    assert.equal(
      (await extractText(new Uint8Array(scan), { mergePages: true })).text.trim(),
      '',
      'fixture must reproduce the previous empty text path',
    );
    const before = new Set(
      (await readdir(tmpdir())).filter((x) => x.startsWith('astral-document-')),
    );
    const result = await chatContent(
      scan,
      { name: 'synthetic-scan.pdf', sha256: 'synthetic-only' },
      {},
    );
    assert.equal(result.pages[0].method, 'ocr');
    assert.match(result.content, /offline OCR 889/);
    assert.match(result.content.replace(/\s/g, ''), /离线识别文件测试/);
    assert.match(result.warning, /OCR/);
    assert.equal(result.nextPage, null);
    const recognized = await readDocumentPages(image, { format: 'image' });
    assert.match(recognized.pages[0].text, /2026/);
    const regular = documentFixtures().find((f) => f.name.endsWith('.pdf')).bytes;
    assert.equal(regular.includes(Buffer.from('/ToUnicode')), false);
    const first = await chatContent(regular, { name: 'text.pdf' }, { pageLimit: 1 });
    assert.equal(first.pages[0].method, 'text');
    assert.equal(first.nextPage, 2);
    assert.equal(first.truncated, true);
    assert.match(first.content, /page 1/);
    const second = await readDocumentPages(regular, { startPage: 2, pageLimit: 1 });
    assert.equal(second.nextPage, null);
    assert.match(second.pages[0].text, /page 2/);
    await assert.rejects(readDocumentPages(regular, { startPage: 3 }), /共2页/);
    await assert.rejects(readDocumentPages(Buffer.from('%PDF-damaged'), {}), /结构|有效PDF/);
    const controller = new AbortController();
    const cancelled = readDocumentPages(
      scan,
      {},
      {
        signal: controller.signal,
        onProgress: (p) => {
          if (p.phase === '正在加载离线中英文识别') controller.abort();
        },
      },
    );
    await assert.rejects(cancelled, /取消/);
    const after = (await readdir(tmpdir())).filter(
      (x) => x.startsWith('astral-document-') && !before.has(x),
    );
    assert.deepEqual(after, [], 'cancelled recognition leaked language files');
  },
);
