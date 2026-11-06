import { Paperclip, Send, Square, TerminalSquare } from 'lucide-react';
import { ThinkingControl } from './ThinkingControl';
import { VoiceInput } from './VoiceInput';
export function AssistantComposerActions({
  scope,
  thinkingLevel,
  thinkingDisabled,
  changeThinking,
  insertVoice,
  terminal,
  terminalDisabled,
  attach,
  attachmentDisabled,
  attachmentTitle,
  commands,
  commandsDisabled,
  working,
  hasContent,
  stop,
  sendDisabled,
  sendLabel,
  sendAria,
}: {
  scope: string;
  thinkingLevel: 'off' | 'low' | 'high' | 'max';
  thinkingDisabled?: boolean;
  changeThinking: (v: 'off' | 'low' | 'high' | 'max') => void;
  insertVoice: (text: string) => void;
  terminal: () => void;
  terminalDisabled?: boolean;
  attach: () => void;
  attachmentDisabled?: boolean;
  attachmentTitle?: string;
  commands: () => void;
  commandsDisabled?: boolean;
  working: boolean;
  hasContent: boolean;
  stop: () => void;
  sendDisabled?: boolean;
  sendLabel: string;
  sendAria: string;
}) {
  return (
    <div className="composer-bottom">
      <div className="thinking-options">
        <button
          type="button"
          className="command-toggle"
          aria-label="打开终端"
          title="打开当前执行位置的终端"
          disabled={terminalDisabled}
          onClick={terminal}
        >
          <TerminalSquare size={16} />
        </button>
        <ThinkingControl
          value={thinkingLevel}
          disabled={thinkingDisabled}
          onChange={changeThinking}
        />
        <VoiceInput key={scope} scope={scope} insert={insertVoice} />
        <button
          type="button"
          className="command-toggle"
          aria-label="上传文件"
          title={attachmentTitle}
          disabled={attachmentDisabled}
          onClick={attach}
        >
          <Paperclip size={16} />
        </button>
        <button
          type="button"
          className="command-toggle"
          aria-label="打开Pi命令"
          disabled={commandsDisabled}
          onClick={commands}
        >
          /
        </button>
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
          <button
            className="primary composer-primary-action"
            disabled={sendDisabled}
            aria-label={sendAria}
            title="发送消息"
          >
            <Send size={17} />
            <span>{sendLabel}</span>
          </button>
        )}
      </div>
    </div>
  );
}
