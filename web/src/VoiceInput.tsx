import { useEffect, useRef, useState } from 'react';
import { Mic, Square, X, LoaderCircle } from 'lucide-react';
import { beginSpeech } from './speech-input';
import { useBackLayer } from './back-navigation';
import './voice-input.css';
export function VoiceInput({ scope, insert }: { scope: string; insert: (text: string) => void }) {
  const [state, setState] = useState<'idle' | 'starting' | 'listening' | 'stopping'>('idle'),
    [text, setText] = useState(''), [error, setError] = useState('');
  const running = state !== 'idle',
    controller = useRef<AbortController | null>(null),
    speech = useRef<Awaited<ReturnType<typeof beginSpeech>> | null>(null),
    insertRef = useRef(insert), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  insertRef.current = insert;
  function cancel() {
    controller.current?.abort();
    speech.current?.abort();
    speech.current = null;
    clearTimeout(timer.current);
    setState('idle'); setText('');
  }
  useEffect(() => {
    const hidden = () => { if (document.visibilityState === 'hidden') cancel(); };
    document.addEventListener('visibilitychange', hidden);
    return () => { document.removeEventListener('visibilitychange', hidden); controller.current?.abort(); speech.current?.abort(); clearTimeout(timer.current); };
  }, [scope]);
  useBackLayer(running, cancel, 110);
  async function start() {
    if (running) return;
    setError(''); setText(''); setState('starting');
    const current = new AbortController();
    let ended = false;
    controller.current = current;
    const live = () => !current.signal.aborted && controller.current === current;
    try {
      speech.current = await beginSpeech({
        partial: (value) => { if (live()) setText(value); },
        result: (value) => {
          if (!live()) return;
          insertRef.current(value);
          setText('');
        },
        error: (message) => { if (live()) setError(message); },
        end: () => { ended = true; if (live()) { setState('idle'); clearTimeout(timer.current); speech.current?.abort(); } },
      }, current.signal);
      if (!live() || ended) { speech.current.abort(); return; }
      setState('listening');
      timer.current = setTimeout(() => { if (live()) void stop(); }, 60000);
    } catch (e) {
      if (live()) { setError((e as Error).message); setState('idle'); }
    }
  }
  async function stop() {
    setState('stopping');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { cancel(); setError('语音服务未返回结果，现有草稿保持不变。'); }, 10000);
    try { await speech.current?.stop(); }
    catch (e) { setError((e as Error).message); cancel(); }
  }
  return <div className="voice-input">
    <button type="button" className={'icon-btn voice-button' + (running ? ' listening' : '')}
      aria-label={running ? '停止语音并识别' : '语音输入'}
      title="语音由设备或浏览器的语音服务识别；文字可编辑后再发送。"
      disabled={state === 'starting' || state === 'stopping'} onClick={() => void (running ? stop() : start())}>
      {state === 'starting' || state === 'stopping' ? <LoaderCircle size={17} className="spin" /> : running ? <Square size={16} /> : <Mic size={18} />}
    </button>
    {(running || error) && <div className="voice-status" role={error ? 'alert' : 'status'}>
      <div><strong>{error ? '语音输入' : state === 'starting' ? '正在启动语音服务…' : state === 'stopping' ? '正在识别…' : '正在聆听…'}</strong>
        <button type="button" className="icon-btn" aria-label="关闭语音输入提示" onClick={() => { cancel(); setError(''); }}><X size={15} /></button></div>
      <p>{error || text || '识别文字将加入草稿，可编辑后发送。'}</p>
      {!error && <small>设备或浏览器的语音服务可能联网处理声音；切换对话或进入后台会停止。</small>}
    </div>}
  </div>;
}
