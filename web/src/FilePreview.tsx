import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Download, LoaderCircle } from 'lucide-react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import appPackage from '../../package.json';
import { ConversationDialog } from './ConversationMenu';
import { fetchChatFile, type ChatFile } from './ChatFiles';
import type { Settings } from './types';
import { PiMarkdown } from './PiMarkdown';
import {
  filePreviewKind,
  imageContentType,
  previewErrorMessage,
} from '../../shared/file-preview.mjs';

type Office =
  | { kind: 'document'; text: string; truncated: boolean }
  | {
      kind: 'spreadsheet';
      sheets: { name: string; rows: string[][]; totalRows: number; totalColumns: number }[];
      truncated: boolean;
    };
function parseOffice(bytes: Uint8Array, name: string, signal: AbortSignal): Promise<Office> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./file-preview.worker.ts', import.meta.url), {
      type: 'module',
    });
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
      signal.removeEventListener('abort', aborted);
    };
    const aborted = () => {
      finish();
      reject(new DOMException('已取消', 'AbortError'));
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error('预览解析超时，请下载原文件。'));
    }, 25000);
    worker.onmessage = ({ data }) => {
      finish();
      data.error ? reject(new Error(data.error)) : resolve(data.result);
    };
    worker.onerror = () => {
      finish();
      reject(new Error('文档无法预览，请下载原文件。'));
    };
    signal.addEventListener('abort', aborted, { once: true });
    worker.postMessage({ bytes, name }, [bytes.buffer]);
  });
}
function PdfPreview({ bytes }: { bytes: Uint8Array }) {
  const canvas = useRef<HTMLCanvasElement>(null),
    container = useRef<HTMLDivElement>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null),
    [page, setPage] = useState(1),
    [width, setWidth] = useState(600),
    [error, setError] = useState(''),
    [rendering, setRendering] = useState(true);
  useEffect(() => {
    let live = true,
      task: ReturnType<typeof import('pdfjs-dist').getDocument> | undefined;
    void import('pdfjs-dist')
      .then((pdfjs) => {
        if (!live) return;
        pdfjs.GlobalWorkerOptions.workerSrc = `${pdfWorkerUrl}?v=${appPackage.version}`;
        task = pdfjs.getDocument({
          data: bytes.slice(),
          enableXfa: false,
          cMapUrl: new URL('/pdfjs/cmaps/', location.href).href,
          cMapPacked: true,
          standardFontDataUrl: new URL('/pdfjs/standard_fonts/', location.href).href,
          wasmUrl: new URL('/pdfjs/wasm/', location.href).href,
        });
        return task.promise.then((pdf) => {
          if (live) setDocument(pdf);
        });
      })
      .catch((error) => {
        if (live) {
          setError(error.message);
          setRendering(false);
        }
      });
    return () => {
      live = false;
      void task?.destroy();
    };
  }, [bytes]);
  useEffect(() => {
    const resize = new ResizeObserver(([entry]) =>
      setWidth(Math.max(180, entry.contentRect.width - 24)),
    );
    if (container.current) resize.observe(container.current);
    return () => resize.disconnect();
  }, []);
  useEffect(() => {
    if (!document || !canvas.current) return;
    let live = true,
      render: RenderTask | undefined;
    setRendering(true);
    setError('');
    void document
      .getPage(page)
      .then((pdfPage) => {
        if (!live) return;
        const natural = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: Math.min(width / natural.width, 2) });
        const element = canvas.current!;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        element.width = Math.ceil(viewport.width * ratio);
        element.height = Math.ceil(viewport.height * ratio);
        element.style.width = `${viewport.width}px`;
        element.style.height = `${viewport.height}px`;
        render = pdfPage.render({
          canvas: element,
          viewport,
          transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
        });
        return render.promise;
      })
      .catch((error) => {
        if (live && error.name !== 'RenderingCancelledException') setError(error.message);
      })
      .finally(() => {
        if (live) setRendering(false);
      });
    return () => {
      live = false;
      render?.cancel();
    };
  }, [document, page, width]);
  return (
    <div className="pi-pdf-preview">
      <div className="pi-preview-pagination">
        <button
          className="icon-btn"
          aria-label="上一页 PDF"
          disabled={!document || page === 1}
          onClick={() => setPage((n) => n - 1)}
        >
          <ArrowLeft size={16} />
        </button>
        <span>
          {page} / {document?.numPages || '…'} 页
        </span>
        <button
          className="icon-btn"
          aria-label="下一页 PDF"
          disabled={!document || page === document.numPages}
          onClick={() => setPage((n) => n + 1)}
        >
          <ArrowRight size={16} />
        </button>
        {rendering && <LoaderCircle size={14} className="spin" />}
      </div>
      {error && (
        <div role="alert">
          <p className="error">{previewErrorMessage(error)}</p>
          {previewErrorMessage(error) !== error && (
            <details className="field-help">
              <summary>错误详情</summary>
              <pre>{error}</pre>
            </details>
          )}
        </div>
      )}
      <div className="pi-pdf-canvas" ref={container}>
        <canvas ref={canvas} aria-label={`PDF 第 ${page} 页`} />
      </div>
    </div>
  );
}
export default function FilePreview({
  file,
  settings,
  conversation,
  close,
  download,
  blob,
}: {
  file: ChatFile;
  settings: Settings;
  conversation: string;
  close: () => void;
  download: () => Promise<void>;
  blob?: Blob;
}) {
  const [kind, setKind] = useState(''),
    [bytes, setBytes] = useState<Uint8Array | null>(null),
    [text, setText] = useState(''),
    [image, setImage] = useState(''),
    [office, setOffice] = useState<Office | null>(null),
    [sheetIndex, setSheetIndex] = useState(0),
    [busy, setBusy] = useState(true),
    [error, setError] = useState(''),
    [truncated, setTruncated] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let imageUrl = '';
    void (
      blob ? Promise.resolve(blob) : fetchChatFile(settings, conversation, file, controller.signal)
    )
      .then(async (blob) => {
        const data = new Uint8Array(await blob.arrayBuffer());
        if (file.sha256 && crypto.subtle) {
          const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
            .map((n) => n.toString(16).padStart(2, '0'))
            .join('');
          if (digest !== file.sha256) throw new Error('文件校验失败，请重新上传。');
        }
        if (controller.signal.aborted) return;
        const type = filePreviewKind(file.name, data);
        setKind(type);
        if (type === 'image') {
          imageUrl = URL.createObjectURL(new Blob([data], { type: imageContentType(data)! }));
          setImage(imageUrl);
        } else if (type === 'pdf') setBytes(data);
        else if (['docx', 'xlsx'].includes(type)) {
          const parsed = await parseOffice(data, file.name, controller.signal);
          if (!controller.signal.aborted) setOffice(parsed);
        } else if (['markdown', 'text'].includes(type)) {
          const value = new TextDecoder('utf-8', { fatal: true }).decode(data);
          setText(value.slice(0, 200000));
          setTruncated(value.length > 200000);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message || '无法预览此文件。');
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => {
      controller.abort();
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    };
  }, [file.id, conversation, settings, blob]);
  const sheet = office?.kind === 'spreadsheet' ? office.sheets[sheetIndex] : null;
  return (
    <ConversationDialog title={file.name} close={close} className="pi-file-preview-dialog">
      <div className="pi-file-preview-meta">
        <span>
          {Math.max(1, Math.ceil(file.bytes / 1024))} KiB
          {kind === 'docx' ? ' · Word 文本预览' : kind === 'xlsx' ? ' · Excel 工作表预览' : ''}
        </span>
        <button className="secondary" onClick={() => void download()}>
          <Download size={15} />
          下载原文件
        </button>
      </div>
      <div className="pi-file-preview-body">
        {busy && (
          <p className="pi-file-preview-loading" role="status">
            <LoaderCircle size={18} className="spin" />
            正在读取文件…
          </p>
        )}
        {error && (
          <div role="alert">
            <p className="error">{previewErrorMessage(error)}</p>
            {previewErrorMessage(error) !== error && (
              <details className="field-help">
                <summary>错误详情</summary>
                <pre>{error}</pre>
              </details>
            )}
          </div>
        )}
        {!busy && !error && (
          <>
            {kind === 'image' && (
              <img
                className="pi-image-preview"
                src={image}
                alt={file.name}
                onError={() =>
                  setError('图片无法解析，文件可能不完整或编码不受支持。下载仅保留原文件。')
                }
              />
            )}
            {kind === 'pdf' && bytes && <PdfPreview bytes={bytes} />}
            {kind === 'markdown' && (
              <div className="pi-markdown-preview">
                <PiMarkdown text={text} />
              </div>
            )}
            {kind === 'text' && <pre className="pi-text-preview">{text}</pre>}
            {office?.kind === 'document' && (
              <>
                <p className="field-help">
                  此处展示可提取文字；图片、页眉页脚与复杂排版请下载原文件查看。
                </p>
                <pre className="pi-document-preview">
                  {office.text || '文档中没有可提取的文字。'}
                </pre>
              </>
            )}
            {office?.kind === 'spreadsheet' && (
              <>
                <div className="pi-sheet-select">
                  <label>
                    工作表
                    <select
                      aria-label="预览工作表"
                      value={sheetIndex}
                      onChange={(event) => setSheetIndex(Number(event.target.value))}
                    >
                      {office.sheets.map((s, i) => (
                        <option key={i} value={i}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span>{sheet?.totalRows || 0} 行 · 显示前 200 行、50 列</span>
                </div>
                <div className="pi-sheet-table">
                  <table>
                    <tbody>
                      {sheet?.rows.map((row, i) => (
                        <tr key={i}>
                          <th scope="row">{i + 1}</th>
                          {row.map((cell, j) => (
                            <td key={j}>{cell}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="field-help">显示已保存的单元格内容，不执行公式、宏或外部链接。</p>
              </>
            )}
            {kind === 'unsupported' && (
              <p className="field-help">
                此格式暂不支持在线预览，可下载原文件。Word / Excel 请使用 .docx / .xlsx 格式。
              </p>
            )}
            {(truncated || office?.truncated) && (
              <p className="field-help">预览内容已截断，完整内容请下载原文件。</p>
            )}
          </>
        )}
      </div>
    </ConversationDialog>
  );
}
