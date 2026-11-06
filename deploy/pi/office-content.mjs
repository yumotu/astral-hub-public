// Shared by the browser preview worker and Pi's bounded document worker.
import { attachmentMaxBytes, attachmentSizeMessage } from './attachment-limits.mjs';
export async function officeContent(bytes, name, { mammoth, readExcelFile, unzipSync }) {
  if (bytes.length > attachmentMaxBytes) throw new Error(attachmentSizeMessage);
  let total = 0,
    count = 0;
  const entries = unzipSync(bytes, {
    filter: (entry) => {
      total += entry.originalSize;
      if (++count > 1500 || entry.originalSize > 12 * 1024 * 1024 || total > 32 * 1024 * 1024)
        throw new Error('文档解压后过大，无法在线预览；可下载原文件。');
      return false;
    },
  });
  void entries;
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (name.toLowerCase().endsWith('.docx')) {
    const input =
      typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes) ? { buffer: bytes } : { arrayBuffer };
    const { value } = await mammoth.extractRawText(input);
    return { kind: 'document', text: value.slice(0, 200000), truncated: value.length > 200000 };
  }
  if (!name.toLowerCase().endsWith('.xlsx')) throw new Error('仅支持 DOCX 和 XLSX 文档。');
  const workbook = await readExcelFile(arrayBuffer);
  const sheets = workbook.slice(0, 20).map((sheet) => ({
    name: sheet.sheet,
    totalRows: sheet.data.length,
    totalColumns: Math.max(0, ...sheet.data.slice(0, 200).map((row) => row.length)),
    rows: sheet.data
      .slice(0, 200)
      .map((row) =>
        row
          .slice(0, 50)
          .map((cell) =>
            cell instanceof Date
              ? cell.toISOString().slice(0, 10)
              : cell === null
                ? ''
                : String(cell).slice(0, 2000),
          ),
      ),
  }));
  return {
    kind: 'spreadsheet',
    sheets,
    truncated:
      workbook.length > 20 ||
      sheets.some((sheet) => sheet.totalRows > 200 || sheet.totalColumns > 50),
  };
}
