import { useSyncExternalStore } from 'react';
import { normalizeMessageMode } from '../../shared/pi-conversation.mjs';
const thinkingKey = 'astral.pi.showThinking',
  modeKey = 'astral.pi.messageMode.v2';
const changed = 'astral:assistant-preferences';
export type MessageMode = 'steer' | 'queue';
let fallbackThinking = false,
  fallbackMode: MessageMode = 'steer';
function thinking() {
  try {
    return localStorage.getItem(thinkingKey) === 'true';
  } catch {
    return fallbackThinking;
  }
}
function mode(): MessageMode {
  try {
    return normalizeMessageMode(localStorage.getItem(modeKey));
  } catch {
    return fallbackMode;
  }
}
function subscribe(notify: () => void) {
  window.addEventListener('storage', notify);
  window.addEventListener(changed, notify);
  return () => {
    window.removeEventListener('storage', notify);
    window.removeEventListener(changed, notify);
  };
}
function setShowThinking(value: boolean) {
  fallbackThinking = value;
  try {
    localStorage.setItem(thinkingKey, String(value));
  } catch {}
  window.dispatchEvent(new Event(changed));
}
function setMessageMode(value: MessageMode) {
  fallbackMode = value;
  try {
    localStorage.setItem(modeKey, value);
  } catch {}
  window.dispatchEvent(new Event(changed));
}
export function useAssistantPreferences() {
  const showThinking = useSyncExternalStore(subscribe, thinking, () => false);
  const messageMode = useSyncExternalStore(subscribe, mode, () => 'steer' as MessageMode);
  return { showThinking, setShowThinking, messageMode, setMessageMode };
}
