import { useState } from 'react';
import { LoaderCircle, MessageSquare, ShieldCheck, X } from 'lucide-react';
import { api } from './data';
import type { Settings } from './types';
type DialogTask = { id: string; status: string; uiRequests?: PluginRequest[] };
export type PluginRequest = {
  id: string;
  method: 'input' | 'editor' | 'select' | 'confirm';
  title: string;
  message?: string;
  placeholder?: string;
  prefill?: string;
  options?: string[];
  source?: 'ask_user';
  questionId?: string;
  toolCallId?: string;
  status: 'pending' | 'responding' | 'resolved';
};
function Request({
  task,
  request,
  settings,
  target,
  onAnswered,
}: {
  task: DialogTask;
  request: PluginRequest;
  settings: Settings;
  target: 'server' | 'computer';
  onAnswered?: () => void;
}) {
  const [approval, setApproval] = useState('once');
  const [value, setValue] = useState(request.prefill || request.options?.[0] || '');
  const [busy, setBusy] = useState(false),
    [answered, setAnswered] = useState(false),
    [error, setError] = useState('');
  const [dismissed, setDismissed] = useState(false),
    [otherAnswer, setOtherAnswer] = useState('');
  const resuming = task.status === 'interrupted';
  const needsOtherAnswer = resuming && request.method === 'select' && value === '填写其他答案';
  const waiting = busy || answered || request.status === 'responding';
  const hostApproval = request.id.startsWith('access:');
  const mailApproval = request.id.startsWith('mail:');
  async function answer(response: object) {
    setBusy(true);
    setError('');
    try {
      await api(
        settings,
        (target === 'computer' ? `/relay/jobs/${task.id}` : `/pi/tasks/${task.id}`) +
          (resuming ? '/question-resume' : '/ui'),
        { id: request.id, ...response },
      );
      setAnswered(true);
      onAnswered?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (dismissed || (answered && resuming)) return null;
  return (
    <form
      className="plugin-request"
      onSubmit={(e) => {
        e.preventDefault();
        void answer(
          request.method === 'confirm'
            ? { confirmed: true, ...(hostApproval ? { approval } : {}) }
            : { value: needsOtherAnswer ? otherAnswer : value },
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
          onClick={() => (resuming ? setDismissed(true) : void answer({ cancelled: true }))}
        >
          <X size={16} />
        </button>
      </div>
      {request.message && <p>{request.message}</p>}
      {resuming && (
        <p className="field-help">
          任务已中断，答复后将核对保存的进度并在原位置继续。其他授权仍需单独确认。
        </p>
      )}
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
          maxLength={resuming ? 4000 : 12000}
          disabled={waiting}
          autoFocus
        />
      ) : request.method === 'input' ? (
        <input
          aria-label={request.title}
          placeholder={request.placeholder}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={resuming ? 4000 : 12000}
          disabled={waiting}
          autoFocus
        />
      ) : null}
      {needsOtherAnswer && (
        <input
          aria-label={request.title + '：其他答案'}
          placeholder="请输入你的答案"
          value={otherAnswer}
          onChange={(e) => setOtherAnswer(e.target.value)}
          maxLength={4000}
          disabled={waiting}
        />
      )}
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
            resuming
              ? setDismissed(true)
              : void answer(
                  request.method === 'confirm' ? { confirmed: false } : { cancelled: true },
                )
          }
        >
          {resuming ? '稍后回答' : request.method === 'confirm' ? '拒绝' : '取消'}
        </button>
        <button
          type="submit"
          disabled={waiting || (resuming && !(needsOtherAnswer ? otherAnswer : value).trim())}
        >
          {waiting && <LoaderCircle size={14} className="spin" />}
          {resuming
            ? '回答并继续'
            : hostApproval
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
export function PluginRequests({
  task,
  settings,
  target = 'server',
  onAnswered,
}: {
  task?: DialogTask;
  settings: Settings;
  target?: 'server' | 'computer';
  onAnswered?: () => void;
}) {
  if (!task || !['running', 'interrupted'].includes(task.status)) return null;
  return (
    <>
      {task.uiRequests
        ?.filter((r) =>
          task.status === 'running'
            ? r.status !== 'resolved'
            : r.status === 'pending' &&
              r.source === 'ask_user' &&
              !!r.questionId &&
              !!r.toolCallId &&
              ['input', 'select'].includes(r.method),
        )
        .map((request) => (
          <Request
            key={`${task.id}:${request.id}`}
            task={task}
            request={request}
            settings={settings}
            target={target}
            onAnswered={onAnswered}
          />
        ))}
    </>
  );
}
