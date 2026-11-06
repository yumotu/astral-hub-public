import type { ReactNode } from 'react';
import { ChatFiles, type ChatFile } from './ChatFiles';
import { CopyButton } from './CopyButton';
import { dateLabel } from './data';
import type { Settings } from './types';

export function AssistantUserMessage({
  input,
  at,
  label = '我',
  files = [],
  settings,
  conversation,
  children,
}: {
  input: string;
  at: string;
  label?: string;
  files?: ChatFile[];
  settings: Settings;
  conversation: string;
  children?: ReactNode;
}) {
  return (
    <div className="message mine">
      <small>
        {label} · {dateLabel(at)}
      </small>
      <p>{input}</p>
      <ChatFiles files={files} settings={settings} conversation={conversation} />
      <div className="message-actions">
        <CopyButton text={input} label="复制我的消息" />
        {children}
      </div>
    </div>
  );
}
