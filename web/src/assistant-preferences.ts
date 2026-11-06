import { useEffect, useState } from 'react';
import { normalizeMessageMode } from '../../shared/pi-conversation.mjs';

const key = 'astral.pi.showThinking';
const messageModeKey = 'astral.pi.messageMode.v2';
export type MessageMode = 'steer' | 'queue';
function load() {
  try {
    return localStorage.getItem(key) === 'true';
  } catch {
    return false;
  }
}
function loadMessageMode(): MessageMode {
  try {
    return normalizeMessageMode(localStorage.getItem(messageModeKey));
  } catch {
    return 'steer';
  }
}
export function useAssistantPreferences() {
  const [showThinking, setValue] = useState(load);
  const [messageMode, setMode] = useState<MessageMode>(loadMessageMode);
  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key === key || event.key === null) setValue(load());
      if (event.key === messageModeKey || event.key === null) setMode(loadMessageMode());
    };
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, []);
  function setShowThinking(value: boolean) {
    setValue(value);
    try {
      localStorage.setItem(key, String(value));
    } catch {}
  }
  function setMessageMode(value: MessageMode) {
    setMode(value);
    try {
      localStorage.setItem(messageModeKey, value);
    } catch {}
  }
  return { showThinking, setShowThinking, messageMode, setMessageMode };
}
