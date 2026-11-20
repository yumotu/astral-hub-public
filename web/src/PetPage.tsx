import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Heart,
  LoaderCircle,
  MessageCircle,
  Moon,
  PawPrint,
  RefreshCw,
  Send,
  Sparkles,
  Utensils,
  Zap,
} from 'lucide-react';
import { runAIPlugin } from './ai';
import { scopedStorageKey } from './data';
import type { Plugin, Settings } from './types';
import {
  applyPetAction,
  buildPetPrompt,
  DEFAULT_PET,
  normalizePet,
  petMood,
} from '../../shared/pet.mjs';

type PetState = {
  name: string;
  mood: number;
  energy: number;
  bond: number;
  fed: number;
  lastAction: string;
  updatedAt: string;
};
type PetMessage = { id: string; role: 'pet' | 'user'; text: string; at: string };
type PetAction = 'pet' | 'feed' | 'play' | 'rest';

const PET_PLUGIN: Plugin = {
  id: 'smart-desktop-pet',
  name: '智能桌宠',
  version: '1.0.0',
  description: '一只会记得你心情的小屿，摸摸、喂食、聊天，陪你把今天过完。',
  icon: 'sparkles',
  prompt: '',
  inputLabel: '和小屿说点什么',
  inputPlaceholder: '今天过得怎么样？',
  capabilities: ['ai.text'],
};

function newId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function loadPet(key: string): { pet: PetState; messages: PetMessage[] } {
  try {
    const raw = JSON.parse(localStorage.getItem(key) || '{}');
    const pet = normalizePet(raw.pet);
    const messages = Array.isArray(raw.messages)
      ? raw.messages
          .filter(
            (m: unknown): m is PetMessage =>
              !!m &&
              typeof m === 'object' &&
              typeof (m as PetMessage).text === 'string' &&
              ((m as PetMessage).role === 'pet' || (m as PetMessage).role === 'user') &&
              typeof (m as PetMessage).id === 'string',
          )
          .slice(-40)
      : [];
    return { pet, messages };
  } catch {
    return { pet: normalizePet(DEFAULT_PET), messages: [] };
  }
}

function initialMessages(): PetMessage[] {
  return [
    {
      id: newId(),
      role: 'pet',
      text: '嗨，我是小屿。今天也在这里陪你。',
      at: new Date().toISOString(),
    },
  ];
}

export function PetPage({
  settings,
  aiConfigured,
  scope,
  openSettings,
}: {
  settings: Settings;
  aiConfigured: boolean;
  scope: string;
  openSettings: () => void;
}) {
  const storageKey = useMemo(() => scopedStorageKey('pet', scope), [scope]);
  const loaded = useMemo(() => loadPet(storageKey), [storageKey]);
  const [pet, setPet] = useState<PetState>(() =>
    normalizePet(loaded.messages.length ? loaded.pet : DEFAULT_PET),
  );
  const [messages, setMessages] = useState<PetMessage[]>(() =>
    loaded.messages.length ? loaded.messages : initialMessages(),
  );
  const [speech, setSpeech] = useState('今天也在这里。');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [bouncing, setBouncing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const chatRef = useRef<HTMLDivElement>(null);
  const mood = petMood(pet);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ pet, messages }));
    } catch {
      // 桌宠状态是本地陪伴数据，存储失败不应阻断当前页面。
    }
  }, [messages, pet, storageKey]);

  useEffect(() => {
    const node = chatRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, busy]);

  function addMessage(role: PetMessage['role'], text: string) {
    setMessages((current) => [
      ...current.slice(-39),
      { id: newId(), role, text, at: new Date().toISOString() },
    ]);
  }

  function bump(message: string) {
    setSpeech(message);
    setBouncing(true);
    window.setTimeout(() => setBouncing(false), 700);
  }

  function interact(action: PetAction) {
    const result = applyPetAction(pet, action);
    setPet(result.pet);
    bump(result.message);
    addMessage('pet', result.message);
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    if (!aiConfigured) {
      setError('桌宠聊天需要连接个人服务器，或在设置里配置本机 DeepSeek Key。');
      return;
    }
    setError('');
    setInput('');
    addMessage('user', text);
    setBusy(true);
    try {
      const recent = messages
        .slice(-6)
        .map((m) => `${m.role === 'pet' ? '小屿' : '我'}：${m.text}`);
      const reply = await runAIPlugin(
        settings,
        { ...PET_PLUGIN, prompt: buildPetPrompt(pet, recent) },
        text,
      );
      addMessage('pet', reply.trim());
      bump('我在听。');
      setPet((current) => ({
        ...normalizePet(current),
        mood: Math.min(100, current.mood + 2),
        bond: Math.min(100, current.bond + 1),
        updatedAt: new Date().toISOString(),
      }));
    } catch (e) {
      setError((e as Error).message);
      bump('唔，我刚刚走神了。');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    if (!resetting) {
      setResetting(true);
      return;
    }
    setPet(normalizePet(DEFAULT_PET));
    setMessages(initialMessages());
    setSpeech('我们重新认识一下吧。');
    setResetting(false);
    setError('');
  }

  const bars = [
    { label: '心情', value: pet.mood, icon: Heart, tone: 'mood' },
    { label: '精力', value: pet.energy, icon: Zap, tone: 'energy' },
    { label: '亲密度', value: pet.bond, icon: PawPrint, tone: 'bond' },
  ];

  return (
    <section className="pet-page" aria-label="智能桌宠">
      <div className={`pet-hero pet-tone-${mood.tone}`}>
        <div className="pet-stage" aria-hidden="true">
          <div className="pet-stars">
            <span />
            <span />
            <span />
            <span />
          </div>
          <div className={`pet-avatar ${bouncing ? 'is-bouncing' : ''}`} data-mood={mood.tone}>
            <div className="pet-tail" />
            <div className="pet-ear left" />
            <div className="pet-ear right" />
            <div className="pet-body">
              <div className="pet-eye left" />
              <div className="pet-eye right" />
              <div className="pet-blush left" />
              <div className="pet-blush right" />
              <div className="pet-mouth" />
            </div>
          </div>
          <div className="pet-shadow" />
        </div>
        <div className="pet-copy">
          <span className="eyebrow">YOUR LITTLE COMPANION</span>
          <h1>{pet.name}</h1>
          <p className="pet-status-line">
            今天心情 <b>{mood.label}</b>，亲密度 <b>{pet.bond}</b>
          </p>
          <div className="pet-speech" aria-live="polite">
            <MessageCircle size={16} />
            <span>{speech}</span>
          </div>
          <div className="pet-stats">
            {bars.map((bar) => (
              <div className="pet-stat" key={bar.label}>
                <div className="pet-stat-head">
                  <span>
                    <bar.icon size={13} /> {bar.label}
                  </span>
                  <b>{bar.value}</b>
                </div>
                <div className={`pet-bar pet-bar-${bar.tone}`}>
                  <span style={{ width: `${bar.value}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="pet-actions" role="group" aria-label="照顾桌宠">
        <button className="pet-action" onClick={() => interact('pet')}>
          <span className="pet-action-icon mood">
            <Heart size={19} />
          </span>
          <b>摸摸头</b>
          <small>心情 +6</small>
        </button>
        <button className="pet-action" onClick={() => interact('feed')}>
          <span className="pet-action-icon energy">
            <Utensils size={19} />
          </span>
          <b>喂点东西</b>
          <small>精力 +18</small>
        </button>
        <button className="pet-action" onClick={() => interact('play')}>
          <span className="pet-action-icon play">
            <Sparkles size={19} />
          </span>
          <b>一起玩</b>
          <small>心情 +10</small>
        </button>
        <button className="pet-action" onClick={() => interact('rest')}>
          <span className="pet-action-icon rest">
            <Moon size={19} />
          </span>
          <b>让它休息</b>
          <small>精力 +22</small>
        </button>
      </div>

      <section className="pet-chat surface">
        <div className="section-title">
          <MessageCircle size={20} />
          <h2>和小屿聊聊</h2>
          <button
            className="text-link push-right pet-reset"
            onClick={reset}
            onBlur={() => setResetting(false)}
          >
            <RefreshCw size={13} />
            {resetting ? '确认重置' : '重新认识'}
          </button>
        </div>
        <p className="muted">
          摸摸、喂食会记住状态；聊天由当前选择的 DeepSeek 连接生成，不会执行现实操作。
        </p>
        <div className="pet-chat-log" ref={chatRef} aria-live="polite">
          {messages.map((message) => (
            <div className={`pet-message ${message.role}`} key={message.id}>
              <span className="pet-message-author">{message.role === 'pet' ? pet.name : '我'}</span>
              <p>{message.text}</p>
            </div>
          ))}
          {busy && (
            <div className="pet-message pet">
              <span className="pet-message-author">{pet.name}</span>
              <p className="pet-typing">
                <LoaderCircle className="spin" size={14} /> 正在想怎么回答…
              </p>
            </div>
          )}
        </div>
        {!aiConfigured && (
          <div className="info-banner pet-ai-banner">
            <Sparkles size={18} />
            <span>连接个人服务器或配置本机 DeepSeek Key 后，小屿就能和你聊天。</span>
            <button className="text-link" onClick={openSettings}>
              去设置 <ArrowRight size={14} />
            </button>
          </div>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="pet-compose">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            maxLength={2000}
            rows={2}
            placeholder="今天过得怎么样？"
            aria-label="和桌宠聊天"
          />
          <button
            className="primary pet-send"
            disabled={!input.trim() || busy}
            onClick={() => void send()}
            aria-label="发送"
          >
            {busy ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />}
          </button>
        </div>
      </section>
    </section>
  );
}
