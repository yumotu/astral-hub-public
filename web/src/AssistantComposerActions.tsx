import { Paperclip, Send, Square, TerminalSquare } from 'lucide-react';
import { ThinkingControl } from './ThinkingControl';
import { VoiceInput } from './VoiceInput';
import { useState } from 'react';
import { AvailabilityButton } from './AvailabilityButton';
import './assistant-controls.css';
export function AssistantComposerActions({
  scope,
  thinkingLevel,
  thinkingDisabled,
  thinkingDisabledReason,
  changeThinking,
  insertVoice,
  terminal,
  terminalDisabled,
  terminalDisabledReason,
  attach,
  attachmentDisabled,
  attachmentTitle,
  attachmentDisabledReason,
  commands,
  commandsDisabled,
  commandsDisabledReason,
  working,
  hasContent,
  stop,
  sendDisabled,
  sendDisabledReason,
  sendLabel,
  sendAria,
}: {
  scope: string;
  thinkingLevel: 'off' | 'low' | 'high' | 'max';
  thinkingDisabled?: boolean;
  thinkingDisabledReason?: string;
  changeThinking: (v: 'off' | 'low' | 'high' | 'max') => void;
  insertVoice: (text: string) => void;
  terminal: () => void;
  terminalDisabled?: boolean;
  terminalDisabledReason?: string;
  attach: () => void;
  attachmentDisabled?: boolean;
  attachmentTitle?: string;
  attachmentDisabledReason?: string;
  commands: () => void;
  commandsDisabled?: boolean;
  commandsDisabledReason?: string;
  working: boolean;
  hasContent: boolean;
  stop: () => void;
  sendDisabled?: boolean;
  sendDisabledReason?: string;
  sendLabel: string;
  sendAria: string;
}) {
  const reasons = {
    thinking: thinkingDisabled ? thinkingDisabledReason || '当前操作完成后可调整思考强度。' : '',
    terminal: terminalDisabled ? terminalDisabledReason || '当前账号或项目未授权使用终端。' : '',
    attachment: attachmentDisabled
      ? attachmentDisabledReason || '请等待上传完成，或移除超出数量的附件后重试。'
      : '',
    commands: commandsDisabled ? commandsDisabledReason || '正在处理命令，请等待完成后重试。' : '',
    send: sendDisabled ? sendDisabledReason || '请输入消息或添加附件，并等待当前操作完成。' : '',
  };
  const [help, explain] = useState('');
  const visibleHelp = Object.values(reasons).includes(help) ? help : '';
  return (
    <>
      <div className="composer-bottom">
        <div className="thinking-options">
          <AvailabilityButton
            type="button"
            className="command-toggle"
            aria-label="打开终端"
            title="打开当前执行位置的终端"
            reason={reasons.terminal}
            explain={explain}
            onClick={terminal}
          >
            <TerminalSquare size={16} />
          </AvailabilityButton>
          <ThinkingControl
            value={thinkingLevel}
            disabled={thinkingDisabled}
            onUnavailable={() => explain(reasons.thinking)}
            disabledReason={reasons.thinking}
            onChange={changeThinking}
          />
          <VoiceInput key={scope} scope={scope} insert={insertVoice} />
          <AvailabilityButton
            type="button"
            className="command-toggle"
            aria-label="上传文件"
            title={attachmentTitle}
            reason={reasons.attachment}
            explain={explain}
            onClick={attach}
          >
            <Paperclip size={16} />
          </AvailabilityButton>
          <AvailabilityButton
            type="button"
            className="command-toggle"
            aria-label="打开Pi命令"
            reason={reasons.commands}
            explain={explain}
            onClick={commands}
          >
            /
          </AvailabilityButton>
        </div>
        <div className="composer-send-actions">
          {working && !hasContent ? (
            <button
              type="button"
              className="primary composer-primary-action stop-task"
              aria-label="停止当前任务"
              title="停止当前任务"
              onClick={stop}
            >
              <Square size={15} />
              <span>停止</span>
            </button>
          ) : (
            <AvailabilityButton
              className="primary composer-primary-action"
              reason={reasons.send}
              explain={explain}
              aria-label={sendAria}
              title="发送消息"
            >
              <Send size={17} />
              <span>{sendLabel}</span>
            </AvailabilityButton>
          )}
        </div>
      </div>
      {visibleHelp && (
        <p className="composer-unavailable-reason" role="status">
          {visibleHelp}
          <button type="button" className="text-link" onClick={() => explain('')}>
            收起
          </button>
        </p>
      )}
    </>
  );
}
