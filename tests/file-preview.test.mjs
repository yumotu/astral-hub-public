import test from 'node:test';
import assert from 'node:assert/strict';
import mammoth from 'mammoth';
import readExcelFile from 'read-excel-file/universal';
import { unzipSync, zipSync } from 'fflate';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { officeContent } from '../deploy/pi/office-content.mjs';
import { readOfficeAttachment } from '../deploy/pi/document-text.mjs';
import { createProjectFiles } from '../deploy/pi/project-files.mjs';
import {
  filePreviewKind,
  previewErrorMessage,
  attachmentKind,
  attachmentBadge,
} from '../shared/file-preview.mjs';
import { decodeExportFiles } from '../server/file-exports.mjs';
import { documentFixtures, largeDocumentFixtures } from './fixtures/document-files.mjs';
test('attachment visuals distinguish file families without treating their extension as verified content', () => {
  for (const [name, kind] of [
    ['photo.PNG', 'image'],
    ['a.pdf', 'pdf'],
    ['a.docx', 'document'],
    ['old.xls', 'spreadsheet'],
    ['slides.pptx', 'presentation'],
    ['package.zip', 'archive'],
    ['main.tsx', 'code'],
    ['note.md', 'text'],
    ['sound.mp3', 'audio'],
    ['clip.mp4', 'video'],
    ['LICENSE', 'file'],
  ])
    assert.equal(attachmentKind(name), kind);
  assert.equal(attachmentBadge('report.DOCX'), 'DOCX');
  assert.equal(attachmentBadge('README'), 'FILE');
  assert.notEqual(filePreviewKind('fake.png', Buffer.from('not an image')), 'image');
});

test('five actual formats classify correctly and Office previews preserve Chinese text, sheets and stored cells', async () => {
  const fixtures = documentFixtures();
  assert.deepEqual(
    fixtures.map((file) => filePreviewKind(file.name, file.bytes)),
    ['docx', 'xlsx', 'markdown', 'pdf', 'image'],
  );
  const dependencies = { mammoth, readExcelFile, unzipSync };
  const word = await officeContent(fixtures[0].bytes, fixtures[0].name, dependencies);
  assert.match(word.text, /星屿 Word 文件验收/);
  assert.match(word.text, /Reference: 0720/);
  const excel = await officeContent(fixtures[1].bytes, fixtures[1].name, dependencies);
  assert.deepEqual(
    excel.sheets.map((sheet) => sheet.name),
    ['验收清单', '第二工作表'],
  );
  assert.equal(excel.sheets[0].rows[1][1], '42');
  assert.equal(excel.sheets[1].rows[0][0], '第二工作表预览成功');
  const bomb = zipSync({ 'word/document.xml': new Uint8Array(12 * 1024 * 1024 + 1) });
  await assert.rejects(() => officeContent(bomb, 'large.docx', dependencies), /解压后过大/);
  assert.equal(filePreviewKind('old.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0])), 'unsupported');
});

test('Pi document worker reads Word and Excel with bounded resources', async (t) => {
  const previous = process.env.ASTRAL_DOCUMENT_DEPS;
  process.env.ASTRAL_DOCUMENT_DEPS = new URL('../package.json', import.meta.url).pathname;
  t.after(() => {
    if (previous === undefined) delete process.env.ASTRAL_DOCUMENT_DEPS;
    else process.env.ASTRAL_DOCUMENT_DEPS = previous;
  });
  const [docx, xlsx] = documentFixtures();
  assert.match((await readOfficeAttachment(docx.bytes, docx.name)).text, /Astral DOCX preview OK/);
  assert.equal((await readOfficeAttachment(xlsx.bytes, xlsx.name)).sheets.length, 2);
  const [largeWord] = largeDocumentFixtures();
  assert.ok(largeWord.bytes.length>16*1024*1024);
  assert.match((await readOfficeAttachment(largeWord.bytes,largeWord.name)).text,/Astral DOCX preview OK/);
});

test('binary exports retain byte-for-byte data and reject malformed, oversized and path-based payloads', () => {
  const files = documentFixtures();
  const decoded = decodeExportFiles(
    files.map((file) => ({
      name: file.name,
      encoding: 'base64',
      data: file.bytes.toString('base64'),
    })),
  );
  assert.deepEqual(decoded, files);
  for (const invalid of [
    [{ name: 'x.pdf', encoding: 'base64', data: '@@' }],
    [{ name: '../secret.txt', content: 'x' }],
    [{ name: 'file', content: 'x', path: '/root' }],
    [
      {
        name: 'file',
        encoding: 'base64',
        data: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64'),
      },
    ],
  ])
    assert.throws(() => decodeExportFiles(invalid));
});

test('project file sending rejects protected paths, symlinks and oversized binaries', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'astral-file-export-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = createProjectFiles({
    projects: [{ id: 'workspace', root, readOnly: true }],
    backupDir: join(root, 'backups'),
  });
  const fixture = documentFixtures()[0];
  await writeFile(join(root, 'test.docx'), fixture.bytes);
  await writeFile(join(root, '.env'), 'private');
  await writeFile(join(root, 'large.pdf'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await symlink(join(root, 'test.docx'), join(root, 'link.docx'));
  assert.deepEqual(await files.exportFile('workspace', 'test.docx'), fixture.bytes);
  for (const path of ['../test.docx', '.env', 'link.docx', '/root/secret'])
    await assert.rejects(() => files.exportFile('workspace', path));
  await assert.rejects(() => files.exportFile('workspace', 'large.pdf'), { status: 413 });
  await assert.rejects(() => files.exportFile('other', 'test.docx'), { status: 404 });
});

test('malformed preview errors explain original file damage without hiding localized network and size details', () => {
  assert.match(previewErrorMessage('Invalid PDF structure'), /不会修复文件/);
  assert.match(previewErrorMessage(new Error('invalid zip data')), /内容不完整/);
  assert.equal(previewErrorMessage('无法连接服务器，请检查网络。'), '无法连接服务器，请检查网络。');
  assert.equal(previewErrorMessage('文件解压后过大'), '文件解压后过大');
});
