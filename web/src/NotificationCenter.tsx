import { Bell, CheckCheck, ChevronRight, LoaderCircle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { NotificationModel } from './notifications';
export function NotificationButton({ model }: { model: NotificationModel }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  if (!model.signedIn) return null;
  return (
    <details className="notification-center" ref={ref}>
      <summary
        aria-label={`通知中心，${model.unread} 条未读`}
        title="通知中心"
        onClick={() => void model.refresh()}
      >
        <Bell size={16} />
        {model.unread > 0 && (
          <span className="notification-badge">{model.unread > 99 ? '99+' : model.unread}</span>
        )}
      </summary>
      <div className="notification-list">
        <div className="notification-list-heading">
          <strong>通知</strong>
          <span>{model.unread} 条未读</span>
          <button
            type="button"
            className="notification-read-all"
            aria-label="全部通知标为已读"
            disabled={!model.unread || model.readingAll}
            onClick={() => void model.readAll()}
          >
            {model.readingAll ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <CheckCheck size={14} />
            )}
            全部已读
          </button>
        </div>
        {model.error && (
          <p className="notification-empty" role="status">
            {model.error}
          </p>
        )}
        {!model.items.length && (
          <p className="notification-empty">新邮件、联系人消息、需要回复和插件通知会保存在这里。</p>
        )}
        {model.items.map((n) => (
          <button
            type="button"
            key={n.id}
            className={n.readAt ? '' : 'is-unread'}
            onClick={() => {
              if (ref.current) ref.current.open = false;
              void model.open(n);
            }}
          >
            <span className="notification-item-title">
              {n.title}
              {n.readAt ? <CheckCheck size={12} /> : <span className="unread-dot" />}
            </span>
            <span className="notification-item-body">{n.body}</span>
            <small>
              {new Date(n.createdAt).toLocaleString('zh-CN', {
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
              <ChevronRight size={12} />
            </small>
          </button>
        ))}
      </div>
    </details>
  );
}
export function NotificationSettings({ model }: { model: NotificationModel }) {
  const device = model.server?.devices.find((d) => d.id === model.prefs.deviceId);
  return (
    <section className="surface notification-settings" aria-label="通知设置">
      <div className="section-title">
        <Bell size={21} />
        <h2>通知</h2>
        <span className="tag">当前设备</span>
      </div>
      <p className="field-help">
        新邮件、联系人消息、好友申请、执行失败、等待回复和 Pi
        插件消息进入通知中心。任务完成不提醒；系统通知需在每台设备分别开启。
      </p>
      {!model.signedIn ? (
        <p className="inline-hint">登录独立账号后可启用通知。</p>
      ) : (
        <>
          <div className="notification-status-line">
            <span>系统权限</span>
            <strong>
              {{
                unknown: '检查中',
                unsupported: '当前环境不支持',
                default: '尚未授权',
                prompt: '尚未授权',
                denied: '已拒绝',
                granted: '已允许',
                system: '由桌面系统管理',
              }[model.systemPermission] || model.systemPermission}
            </strong>
          </div>
          <div className="notification-status-line">
            <span>通知通道</span>
            <strong>
              {!model.prefs.enabled
                ? '未开启'
                : model.platform === 'android'
                  ? 'Android 系统通知'
                  : model.platform === 'desktop'
                    ? '桌面系统通知'
                    : device?.remote
                      ? 'Web Push + 连接期间通知'
                      : '连接期间通知'}
            </strong>
          </div>
          <div className="notification-setting-actions">
            {model.prefs.enabled ? (
              <>
                <button
                  type="button"
                  className="secondary"
                  disabled={model.busy}
                  onClick={() => void model.update({ enabled: false })}
                >
                  关闭本机系统通知
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={model.busy}
                  onClick={() => void model.enable()}
                >
                  <Bell size={15} />
                  开启或修复通知
                </button>
              </>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={model.busy}
                onClick={() => void model.enable()}
              >
                {model.busy ? <LoaderCircle className="spin" size={15} /> : <Bell size={15} />}
                {model.busy ? '等待系统授权…' : '开启或修复通知'}
              </button>
            )}
            <button
              type="button"
              className="secondary"
              disabled={model.busy}
              onClick={() => void model.test()}
            >
              发送测试通知
            </button>
            {model.platform === 'android' && (
              <button
                type="button"
                className="secondary"
                onClick={() => void model.openSystemSettings()}
              >
                系统通知设置
              </button>
            )}
          </div>
          <label className="check-line">
            <input
              type="checkbox"
              checked={model.prefs.onlyBackground}
              onChange={(e) => void model.update({ onlyBackground: e.target.checked })}
            />
            <span>
              仅窗口在后台时通知<small>/notify 和测试消息始终尝试展示。</small>
            </span>
          </label>
          <label className="check-line">
            <input
              type="checkbox"
              checked={model.prefs.preview}
              onChange={(e) => void model.update({ preview: e.target.checked })}
            />
            <span>
              在系统通知中显示内容预览<small>默认只显示通用提示，避免在锁屏展示任务内容。</small>
            </span>
          </label>
          {model.platform === 'web' && (
            <p className="field-help">
              网页打开时无需 Web Push
              订阅也可展示通知。关闭网页后的推送依赖浏览器及推送服务网络。Mac 还需在「系统设置 →
              通知」允许当前浏览器通知，并检查专注模式。
            </p>
          )}
          {model.delivery && (
            <p className="field-help" role="status">
              {model.delivery}
            </p>
          )}
          {model.platform === 'android' && (
            <p className="field-help">
              当前支持应用连接期间的原生通知。关闭应用后的远程推送尚未配置 Firebase。
            </p>
          )}
          {model.platform === 'desktop' && (
            <p className="field-help">
              桌面应用需保持运行；macOS 系统通知还受应用签名与系统设置控制。
            </p>
          )}
          {(model.pushWarning || device?.error) && (
            <p className="inline-hint">
              后台推送：{model.pushWarning || device?.error} 网页连接期间的测试结果单独显示在上方。
            </p>
          )}
          {model.error && (
            <p className="form-error" role="alert">
              {model.error}
            </p>
          )}
        </>
      )}
    </section>
  );
}
