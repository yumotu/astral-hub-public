import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import { createBrowserSpeech, speechError } from '../../shared/speech-session.mjs';
type Callbacks = { partial: (text: string) => void; result: (text: string) => void; error: (message: string) => void; end: () => void };
type SpeechEvent = { id: string; text?: string; final?: boolean; error?: string; ended?: boolean };
const native = registerPlugin<{
  available(): Promise<{ available: boolean }>;
  start(input: { id: string; language: string }): Promise<void>;
  stop(input: { id: string; cancel: boolean }): Promise<void>;
  addListener(name: 'speech', callback: (e: SpeechEvent) => void): Promise<PluginListenerHandle>;
}>('AstralSpeech');

export async function beginSpeech(callbacks: Callbacks, signal: AbortSignal) {
  const language = navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
    if (!(await native.available()).available) throw Error(speechError('unavailable'));
    const id = crypto.randomUUID();
    let active = true, delivered = false;
    const listener = await native.addListener('speech', (e) => {
      if (!active || signal.aborted || e.id !== id) return;
      if (e.text) callbacks.partial(e.text);
      if (e.final && e.text && !delivered) { delivered = true; callbacks.result(e.text); }
      if (e.error) callbacks.error(speechError(e.error));
      if (e.ended) callbacks.end();
    });
    const abort = () => { active = false; void native.stop({ id, cancel: true }).catch(() => {}); void listener.remove(); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); throw Error('语音输入已取消。'); }
    try { await native.start({ id, language }); }
    catch (e) { abort(); signal.removeEventListener('abort', abort); throw e; }
    return { stop: () => native.stop({ id, cancel: false }), abort: () => { signal.removeEventListener('abort', abort); abort(); } };
  }
  const scope = window as typeof window & { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any };
  const Recognition = scope.SpeechRecognition || scope.webkitSpeechRecognition;
  if (!Recognition || !window.isSecureContext) throw Error(speechError('unavailable'));
  const speech = createBrowserSpeech(Recognition, { ...callbacks, lang: language });
  const abort = () => speech.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) { abort(); throw Error('语音输入已取消。'); }
  try { speech.start(); } catch (e) { signal.removeEventListener('abort', abort); abort(); throw e; }
  return { stop: async () => speech.stop(), abort: () => { signal.removeEventListener('abort', abort); abort(); } };
}
