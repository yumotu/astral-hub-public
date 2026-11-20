import { useState } from 'react';
import { X } from 'lucide-react';
import { api } from './data';
import { useBackLayer } from './back-navigation';
import type { MailCacheSettings as Preferences } from './mail-cache';
import type { Settings } from './types';

export type MailCacheInfo = { settings: Preferences; usage: { entries: number; bytes: number } };
export function MailCacheSettings({
  settings,
  info,
  onSave,
  onClose,
  storageError,
}: {
  settings: Settings;
  info: MailCacheInfo;
  onSave: (value: MailCacheInfo) => void;
  onClose: () => void;
  storageError: string;
}) {
  const [value, setValue] = useState(info.settings),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useBackLayer(true, onClose, 80);
  return (
    <form
      className="mail-cache-settings"
      aria-label="邮件缓存设置"
      onSubmit={(event) => {
        event.preventDefault();
        setBusy(true);
        setError('');
        void api<MailCacheInfo>(settings, '/mail/cache', value)
          .then(onSave)
          .catch((e) => setError(e.message))
          .finally(() => setBusy(false));
      }}
    >
      <header>
        <h2>长期邮件与缓存</h2>
        <button type="button" className="icon-btn" aria-label="关闭缓存设置" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      <div className="mail-cache-fields">
        <label>
          缓存容量（MB）
          <input
            aria-label="邮件缓存容量"
            type="number"
            min="16"
            max="1024"
            required
            value={value.cacheMB}
            onChange={(e) => setValue({ ...value, cacheMB: e.target.valueAsNumber })}
          />
        </label>
        <label>
          保留天数（0 为不限）
          <input
            aria-label="邮件缓存保留天数"
            type="number"
            min="0"
            max="3650"
            required
            value={value.retentionDays}
            onChange={(e) => setValue({ ...value, retentionDays: e.target.valueAsNumber })}
          />
        </label>
        <label>
          每页邮件数量
          <input
            aria-label="每页邮件数量"
            type="number"
            min="20"
            max="100"
            required
            value={value.pageSize}
            onChange={(e) => setValue({ ...value, pageSize: e.target.valueAsNumber })}
          />
        </label>
      </div>
      <p className="inline-hint">
        服务器缓存 {(info.usage.bytes / 1048576).toFixed(1)} MB · {info.usage.entries}{' '}
        项。设置同步到其他设备；此设备可用空间也会影响缓存。历史邮件可按日期持续加载，浏览范围不受保留天数限制。
      </p>
      {(error || storageError) && (
        <p className="error" role="alert">
          {error || storageError}
        </p>
      )}
      <button className="secondary" disabled={busy}>
        {busy ? '保存中…' : '保存设置'}
      </button>
    </form>
  );
}
