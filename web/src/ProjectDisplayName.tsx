import { useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useBackLayer } from './back-navigation';

export function ProjectNameDialog({
  name,
  save,
  close,
}: {
  name: string;
  save: (name: string | null) => Promise<void>;
  close: () => void;
}) {
  const [value, setValue] = useState(name),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useBackLayer(
    true,
    () => {
      if (!busy) close();
    },
    90,
  );
  async function submit(next: string | null) {
    setBusy(true);
    setError('');
    try {
      await save(next);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return createPortal(
    <div className="assistant-modal-backdrop">
      <form
        className="surface assistant-modal"
        role="dialog"
        aria-modal="true"
        aria-label="修改项目显示名称"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(value.trim());
        }}
      >
        <header className="section-title">
          <h2>项目显示名称</h2>
          <button
            className="icon-btn"
            type="button"
            aria-label="关闭项目显示名称"
            disabled={busy}
            onClick={close}
          >
            <X size={18} />
          </button>
        </header>
        <p className="field-help">
          只修改你在软件中看到的名称，文件夹、实际路径和已有对话保持不变。
        </p>
        <label className="field-label">
          显示名称
          <input
            className="standard-input"
            aria-label="项目显示名称"
            autoFocus
            required
            maxLength={60}
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="action-row">
          <button className="primary" disabled={busy || !value.trim()}>
            {busy ? '正在保存' : '保存显示名称'}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => void submit(null)}
          >
            恢复原名称
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
