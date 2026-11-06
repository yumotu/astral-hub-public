import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Download,
  FileText,
  FileType,
  FileSpreadsheet,
  Presentation,
  FileArchive,
  FileCode2,
  FileAudio,
  FileVideo,
  File,
  Image as ImageIcon,
  ImageOff,
  LoaderCircle,
  X,
} from 'lucide-react';
import { attachmentKind, attachmentBadge, imageContentType } from '../../shared/file-preview.mjs';
import type { Settings } from './types';
import { ConversationDialog } from './ConversationMenu';
import { fetchChatFile, type ChatFile } from './chat-file-transport';
export { fetchChatFile, uploadChatFile } from './chat-file-transport';
export type { ChatFile } from './chat-file-transport';
const FilePreview = lazy(() => import('./FilePreview'));
class PreviewBoundary extends Component<
  { children: ReactNode; close: () => void; download: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <ConversationDialog title="无法打开预览" close={this.props.close}>
          <p>预览组件暂时无法加载。请检查连接，或刷新页面后重新打开。</p>
          <button className="secondary" onClick={this.props.download}>
            下载原文件
          </button>
        </ConversationDialog>
      );
    return this.props.children;
  }
}
function AttachmentVisual({
  file,
  settings,
  conversation,
}: {
  file: ChatFile;
  settings: Settings;
  conversation: string;
}) {
  const kind = attachmentKind(file.name);
  const target = useMemo(
    () => ({}),
    [settings.url, settings.sessionToken, settings.token, conversation, file.id, file.sha256],
  );
  const element = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [image, setImage] = useState<{ target: object; src?: string; failed?: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (kind !== 'image') return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '120px' },
    );
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, [kind, target]);
  useEffect(() => {
    if (kind !== 'image' || !visible) return;
    const controller = new AbortController();
    let src = '';
    void fetchChatFile(settings, conversation, file, controller.signal)
      .then(async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (controller.signal.aborted) return;
        const type = imageContentType(bytes);
        if (!type) throw new Error('无法识别图片格式');
        src = URL.createObjectURL(new Blob([bytes], { type }));
        setImage({ target, src });
      })
      .catch(() => {
        if (!controller.signal.aborted) setImage({ target, failed: true });
      });
    return () => {
      controller.abort();
      if (src) URL.revokeObjectURL(src);
    };
  }, [target, kind, visible]);
  if (kind === 'image') {
    const current = image?.target === target ? image : null;
    return (
      <span ref={element} className="chat-file-visual chat-file-thumbnail">
        {current?.src && !current.failed ? (
          <img
            src={current.src}
            alt={file.name}
            loading="lazy"
            decoding="async"
            onError={() => setImage({ target, failed: true })}
          />
        ) : current?.failed ? (
          <ImageOff size={22} aria-label="图片缩略图不可用" />
        ) : visible ? (
          <LoaderCircle size={19} className="spin" aria-label="正在加载图片预览" />
        ) : (
          <ImageIcon size={22} />
        )}
      </span>
    );
  }
  const Icon =
    (
      {
        pdf: FileType,
        document: FileText,
        spreadsheet: FileSpreadsheet,
        presentation: Presentation,
        archive: FileArchive,
        code: FileCode2,
        audio: FileAudio,
        video: FileVideo,
        text: FileText,
      } as Record<string, typeof File>
    )[kind] || File;
  return (
    <span className={`chat-file-visual chat-file-type kind-${kind}`} aria-hidden="true">
      <Icon size={23} />
      <b>{attachmentBadge(file.name)}</b>
    </span>
  );
}
export function ChatFiles({
  files,
  settings,
  conversation,
  remove,
}: {
  files: ChatFile[];
  settings: Settings;
  conversation: string;
  remove?: (id: string) => void;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState('');
  const [preview, setPreview] = useState<ChatFile | null>(null);
  async function download(file: ChatFile) {
    setBusy(file.id);
    setError('');
    try {
      const url = URL.createObjectURL(await fetchChatFile(settings, conversation, file)),
        link = document.createElement('a');
      link.href = url;
      link.download = file.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  if (!files.length) return null;
  return (
    <div className="chat-files">
      {files.map((file) => (
        <div className={`chat-file attachment-${attachmentKind(file.name)}`} key={file.id}>
          <button
            type="button"
            className="chat-file-preview"
            aria-label={`预览 ${file.name}`}
            onClick={() => setPreview(file)}
          >
            <AttachmentVisual file={file} settings={settings} conversation={conversation} />
            <span className="chat-file-label" title={file.name}>
              {file.name}
              <small>
                {Math.max(1, Math.ceil(file.bytes / 1024))} KiB ·{' '}
                {attachmentKind(file.name) === 'image' ? '点击放大' : '点击预览'}
              </small>
            </span>
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={`下载 ${file.name}`}
            disabled={!!busy}
            onClick={() => void download(file)}
          >
            <Download size={15} />
          </button>
          {remove && (
            <button
              type="button"
              className="icon-btn"
              aria-label={`移除 ${file.name}`}
              onClick={() => remove(file.id)}
            >
              <X size={14} />
            </button>
          )}
        </div>
      ))}
      {error && <p className="error">{error}</p>}
      {preview && (
        <PreviewBoundary
          key={`${conversation}:${preview.id}`}
          close={() => setPreview(null)}
          download={() => void download(preview)}
        >
          <Suspense fallback={<span role="status">正在打开预览…</span>}>
            <FilePreview
              key={`${conversation}:${preview.id}`}
              file={preview}
              settings={settings}
              conversation={conversation}
              close={() => setPreview(null)}
              download={() => download(preview)}
            />
          </Suspense>
        </PreviewBoundary>
      )}
    </div>
  );
}
