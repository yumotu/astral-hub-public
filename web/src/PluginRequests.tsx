import { useState } from 'react';
import { LoaderCircle, MessageSquare, ShieldCheck, X } from 'lucide-react';
import { api } from './data';
import type { Settings } from './types';
import type { PiTask } from './pi-tasks';
export type PluginRequest = {
  id: string;
  method: 'input' | 'editor' | 'select' | 'confirm';
  title: string;
  message?: string;
  placeholder?: string;
  prefill?: string;
  options?: string[];
  status: 'pending' | 'responding' | 'resolved';
};
function Request({
  task,
  request,
  settings,
}: {
  task: PiTask;
  request: PluginRequest;
  settings: Settings;
}) {
  const [approval, setApproval] = useState('once');
  const [value, setValue] = useState(request.prefill || request.options?.[0] || '');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const waiting = busy || request.status === 'responding';
  const hostApproval = request.id.startsWith('access:');
  const mailApproval = request.id.startsWith('mail:');
  async function answer(response: object) {
    setBusy(true);
    setError('');
    try {
      await api(settings, `/pi/tasks/${task.id}/ui`, { id: request.id, ...response });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className="plugin-request"
      onSubmit={(e) => {
        e.preventDefault();
        void answer(
          request.method === 'confirm'
            ? { confirmed: true, ...(hostApproval ? { approval } : {}) }
            : { value },
        );
      }}
    >
      <div className="plugin-request-heading">
        {hostApproval || mailApproval ? <ShieldCheck size={16} /> : <MessageSquare size={16} />}
        <strong>{request.title}</strong>
        <button
          type="button"
          className="icon-button"
          aria-label={mailApproval ? '取消邮件操作' : '取消插件请求'}
          disabled={waiting}
          onClick={() => void answer({ cancelled: true })}
        >
          <X size={16} />
        </button>
      </div>
      {request.message && <p>{request.message}</p>}
      {request.method === 'select' ? (
        <select
          aria-label={request.title}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={waiting}
        >
          {request.options?.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : request.method === 'editor' ? (
        <textarea
          aria-label={request.title}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={5}
          maxLength={12000}
          disabled={waiting}
          autoFocus
        />
      ) : request.method === 'input' ? (
        <input
          aria-label={request.title}
          placeholder={request.placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={12000}
          disabled={waiting}
          autoFocus
        />
      ) : null}
      {hostApproval && (
        <label className="approval-choice">
          此次授权范围
          <select value={approval} onChange={(e) => setApproval(e.target.value)} disabled={waiting}>
            <option value="once">仅这一次</option>
            <option value="exact">此对话：相同目录中的原样命令</option>
            <option value="similar">此对话：同类只读检查命令</option>
            <option value="15m">此环境免审 15 分钟</option>
            <option value="60m">此环境免审 1 小时</option>
            <option value="full">此环境完全权限，直到撤销</option>
          </select>
          <small className="field-help">
            限时／完全权限允许此对话在申请的环境中执行其他命令；可在输入框下方「执行授权」撤销。
          </small>
        </label>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="plugin-request-actions">
        <button
          type="button"
          className="secondary"
          disabled={waiting}
          onClick={() =>
            void answer(request.method === 'confirm' ? { confirmed: false } : { cancelled: true })
          }
        >
          {request.method === 'confirm' ? '拒绝' : '取消'}
        </button>
        <button type="submit" disabled={waiting}>
          {waiting && <LoaderCircle size={14} className="spin" />}
          {hostApproval
            ? approval === 'once'
              ? '允许本次执行'
              : '授权并执行'
            : mailApproval
              ? '确认本次邮件操作'
              : request.method === 'confirm'
                ? '确认'
                : '继续'}
        </button>
      </div>
    </form>
  );
}
export function PluginRequests({ task, settings }: { task?: PiTask; settings: Settings }) {
  if (!task || task.status !== 'running') return null;
  return (
    <>
      {task.uiRequests
        ?.filter((r) => r.status !== 'resolved')
        .map((request) => (
          <Request
            key={`${task.id}:${request.id}`}
            task={task}
            request={request}
            settings={settings}
          />
        ))}
    </>
  );
}
