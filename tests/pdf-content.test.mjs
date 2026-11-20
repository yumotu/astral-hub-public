import test from 'node:test';
import assert from 'node:assert/strict';
import { needsOcr, documentReadOptions } from '../deploy/pi/pdf-content.mjs';

test('PDF reading bounds batches without limiting total pages and only diagnoses observed poor text', () => {
  assert.deepEqual(documentReadOptions(), { startPage: 1, pageLimit: 3, mode: 'auto' });
  assert.deepEqual(documentReadOptions({ startPage: 99, pageLimit: 8, mode: 'ocr' }), {
    startPage: 99,
    pageLimit: 8,
    mode: 'ocr',
  });
  for (const p of [
    { startPage: 0 },
    { startPage: 1.2 },
    { pageLimit: 0 },
    { pageLimit: 9 },
    { mode: 'guess' },
  ])
    assert.throws(() => documentReadOptions(p));
  assert.equal(needsOcr(''), true);
  assert.equal(needsOcr('Some \ufffd\ufffd\ufffd garbled text'), true);
  assert.equal(needsOcr('Normal text is perfectly readable without ToUnicode.'), false);
  assert.equal(needsOcr('这是一段可正常读取的中文内容，不应反复运行识别。'), false);
});
