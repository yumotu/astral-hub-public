import test from 'node:test';
import assert from 'node:assert/strict';
import { pastedFiles, insertPastedText } from '../web/src/composer-paste.ts';

test('paste accepts original images and files once even when both clipboard collections contain them', async () => {
  const image = new File([Uint8Array.of(137, 80, 78, 71)], 'screenshot.png', { type: 'image/png' });
  const pdf = new File(['%PDF-1.7'], 'notes.pdf', { type: 'application/pdf' });
  const files = pastedFiles({
    files: [image, pdf],
    items: [image, pdf].map((f) => ({ kind: 'file', getAsFile: () => f })),
  });
  assert.deepEqual(files, [image, pdf]);
  assert.equal(files[0], image);
  assert.deepEqual(
    new Uint8Array(await files[1].arrayBuffer()),
    new Uint8Array(await pdf.arrayBuffer()),
  );
});
test('paste handles clipboard items fallback and gives unnamed images a previewable filename', async () => {
  const unnamed = new File(['unchanged bytes'], '', { type: 'image/png' });
  const files = pastedFiles(
    {
      files: [],
      items: [
        {
          kind: 'string',
          getAsFile: () => {
            throw new Error('do not interpret text as files');
          },
        },
        { kind: 'file', getAsFile: () => null },
        { kind: 'file', getAsFile: () => unnamed },
      ],
    },
    12345,
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].name, '粘贴图片-12345-1.png');
  assert.equal(files[0].type, 'image/png');
  assert.equal(await files[0].text(), 'unchanged bytes');
});
test('ordinary text, links and rich HTML without actual files stay on the normal paste path', () => {
  assert.deepEqual(pastedFiles({ files: [], items: [{ kind: 'string' }] }), []);
  assert.deepEqual(pastedFiles({ files: [], items: [] }), []);
});
test('mixed text/file paste replaces the selection, restores the caret and obeys the text limit', () => {
  assert.deepEqual(insertPastedText('前文占位后文', '文字和图片', 2, 4), {
    value: '前文文字和图片后文',
    cursor: 7,
  });
  assert.deepEqual(insertPastedText('abcdefgh', '123456', 2, 5, 8), {
    value: 'ab123fgh',
    cursor: 5,
  });
  assert.deepEqual(insertPastedText('abcdef', '12', 6, 6, 6), { value: 'abcdef', cursor: 6 });
});
