import mammoth from 'mammoth';
import readExcelFile from 'read-excel-file/universal';
import { unzipSync } from 'fflate';
import { officeContent } from '../../deploy/pi/office-content.mjs';
self.onmessage = async (event: MessageEvent<{ bytes: Uint8Array; name: string }>) => {
  try {
    const result = await officeContent(event.data.bytes, event.data.name, {
      mammoth,
      readExcelFile,
      unzipSync,
    });
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: (error as Error).message || '文档无法解析，请下载原文件。' });
  }
};
