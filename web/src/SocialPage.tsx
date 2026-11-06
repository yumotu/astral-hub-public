import { useBackLayer } from './back-navigation';
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  Users,
  MessageCircle,
  MapPin,
  UserPlus,
  ArrowRight,
  Send,
  Check,
  X,
  LoaderCircle,
  RefreshCw,
  Shield,
  Map as MapIcon,
  ChevronLeft,
} from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { api, dateLabel } from './data';
import { UnreadBadge } from './unread';
import type { AuthSession, Settings, SocialOverview, DirectMessage } from './types';
const ContactMap = lazy(() => import('./ContactMap').then((m) => ({ default: m.ContactMap })));
export function SocialPage({
  settings,
  session,
  login,
  notify,
}: {
  settings: Settings;
  session: AuthSession | null;
  login: () => void;
  notify: (s: string) => void;
}) {
  const [tab, setTab] = useState<'chat' | 'contacts' | 'map'>('chat'),
    [overview, setOverview] = useState<SocialOverview | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState('');
  const [username, setUsername] = useState(''),
    [selected, setSelected] = useState(''),
    [messages, setMessages] = useState<DirectMessage[]>([]),
    [draft, setDraft] = useState('');
  const [loadMap, setLoadMap] = useState(false),
    [duration, setDuration] = useState<15 | 60>(15),
    [older, setOlder] = useState(false);
  const selectedRef = useRef(selected),
    scroll = useRef<HTMLDivElement>(null),
    pendingId = useRef<string | null>(null);
  selectedRef.current = selected;
  useBackLayer(!!selected, () => setSelected(''), 40);
  useBackLayer(tab !== 'chat', () => setTab('chat'), 30);
  const refresh = useCallback(async () => {
    const next = await api<SocialOverview>(settings, '/social/overview');
    setOverview(next);
    setError('');
  }, [settings]);
  useEffect(() => {
    if (!session) return;
    let alive = true;
    const run = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const next = await api<SocialOverview>(settings, '/social/overview');
        if (alive) {
          setOverview(next);
          setError('');
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void run();
    const timer = setInterval(run, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [session, settings]);
  useEffect(() => {
    setMessages([]);
    setOlder(false);
    setDraft('');
    pendingId.current = null;
    if (!session || !selected) return;
    let alive = true,
      inFlight = false;
    const run = async () => {
      if (inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const r = await api<{ messages: DirectMessage[] }>(
          settings,
          `/social/messages/${selected}`,
        );
        if (alive)
          setMessages((old) => {
            const ids = new Set(r.messages.map((m) => m.id));
            return [...old.filter((m) => !ids.has(m.id)), ...r.messages].sort(
              (a, b) => a.seq - b.seq,
            );
          });
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        inFlight = false;
      }
    };
    void run();
    const timer = setInterval(run, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [selected, session, settings]);
  useEffect(() => {
    if (!older) scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' });
  }, [messages.at(-1)?.seq, selected]);
  useEffect(() => {
    const through = messages.at(-1)?.seq;
    if (!session || !selected || !through || older) return;
    let live = true;
    const mark = async () => {
      if (document.visibilityState === 'hidden' || !document.hasFocus()) return;
      try {
        const result = await api<{ unread: number }>(
          settings,
          `/social/messages/${selected}/read`,
          { through },
        );
        if (live) {
          setOverview((old) =>
            old
              ? {
                  ...old,
                  contacts: old.contacts.map((c) =>
                    c.id === selected ? { ...c, unread: result.unread } : c,
                  ),
                }
              : old,
          );
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void mark();
    document.addEventListener('visibilitychange', mark);
    window.addEventListener('focus', mark);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', mark);
      window.removeEventListener('focus', mark);
    };
  }, [selected, messages.at(-1)?.seq, older, settings, session]);
  useEffect(() => {
    if (selected && overview && !overview.contacts.some((u) => u.id === selected)) {
      setSelected('');
      setMessages([]);
    }
  }, [overview, selected]);
  async function task(name: string, fn: () => Promise<void>) {
    setError('');
    setBusy(name);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function share() {
    await task('location', async () => {
      // 仅由“分享此刻位置”按钮触发一次权限请求，不启动后台追踪。
      let coords: { latitude: number; longitude: number; accuracy: number };
      try {
        if (Capacitor.isNativePlatform()) {
          await Geolocation.requestPermissions({ permissions: ['coarseLocation'] });
          coords = (
            await Geolocation.getCurrentPosition({
              enableHighAccuracy: false,
              timeout: 15000,
              maximumAge: 60000,
            })
          ).coords;
        } else {
          if (!window.isSecureContext || !navigator.geolocation) throw new Error('unavailable');
          coords = (
            await new Promise<GeolocationPosition>((resolve, reject) =>
              navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: false,
                timeout: 15000,
                maximumAge: 60000,
              }),
            )
          ).coords;
        }
      } catch {
        throw new Error(
          '未能获取位置。请允许本次定位并开启系统定位；网页需使用 HTTPS 或 localhost。',
        );
      }
      await api(settings, '/social/location', {
        latitude: coords.latitude,
        longitude: coords.longitude,
        accuracy: coords.accuracy,
        ttlMinutes: duration,
      });
      await refresh();
      notify('已分享此刻的近似位置，到期自动停止。');
    });
  }
  if (!session)
    return (
      <>
        <div className="page-heading compact">
          <div className="eyebrow">A LITTLE CLOSER</div>
          <h1>
            让相遇，<em>有一处安放。</em>
          </h1>
          <p>与朋友聊天，在地图上分享此刻。</p>
        </div>
        <section className="surface signed-out">
          <Users size={34} />
          <h2>先登录你的账号</h2>
          <p>聊天和位置仅向双方接受的联系人开放。</p>
          <button className="primary" onClick={login}>
            登录或注册
          </button>
        </section>
      </>
    );
  const contact = overview?.contacts.find((u) => u.id === selected),
    liveLocations = (overview?.locations || []).filter((p) => Date.parse(p.expiresAt) > Date.now()),
    own = liveLocations.find((p) => p.userId === session.user.id);
  const names = Object.fromEntries([
    ...(overview?.contacts || []).map((u) => [u.id, u.displayName]),
    [session.user.id, '我'],
  ]);
  return (
    <div className="social-page">
      <div className="page-heading compact">
        <div className="eyebrow">A LITTLE CLOSER</div>
        <h1>
          把日常，<em>分享给在意的人。</em>
        </h1>
        <p>联系人之间的私聊，以及由你决定的位置分享。</p>
      </div>
      <div className="community-toolbar">
        <div className="segmented social-tabs">
          <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
            <MessageCircle size={16} />
            聊天
          </button>
          <button className={tab === 'contacts' ? 'active' : ''} onClick={() => setTab('contacts')}>
            <Users size={16} />
            联系人 <UnreadBadge count={overview?.incoming.length} label="个联系人申请" />
          </button>
          <button className={tab === 'map' ? 'active' : ''} onClick={() => setTab('map')}>
            <MapPin size={16} />
            地图
          </button>
        </div>
        <button
          className="icon-btn"
          aria-label="刷新联系人"
          disabled={!!busy}
          onClick={() => void task('refresh', refresh)}
        >
          <RefreshCw size={18} />
        </button>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {tab === 'contacts' ? (
        <div className="account-grid">
          <section className="surface">
            <div className="section-title">
              <UserPlus size={21} />
              <h2>添加联系人</h2>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void task('add', async () => {
                  await api(settings, '/social/contacts', { username });
                  setUsername('');
                  await refresh();
                  notify('联系人申请已发送。');
                });
              }}
            >
              <label className="field-label" htmlFor="contact-username">
                对方的完整用户名
              </label>
              <input
                id="contact-username"
                className="standard-input"
                required
                minLength={3}
                maxLength={32}
                placeholder="例如 astral_friend"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
              />
              <button className="primary" disabled={!!busy}>
                发送申请
              </button>
            </form>
            <p className="field-help">
              把你的用户名 @{session.user.username} 告诉朋友。对方接受申请后，就能聊天。
            </p>
          </section>
          <section className="surface">
            <h2>联系人申请</h2>
            {!overview?.incoming.length && !overview?.outgoing.length && (
              <p className="field-help">暂时没有待处理的申请。</p>
            )}
            {overview?.incoming.map((u) => (
              <div className="person-row" key={u.id}>
                <div className="avatar">{u.displayName.slice(0, 1)}</div>
                <span>
                  <b>{u.displayName}</b>
                  <small>@{u.username} · 希望添加你</small>
                </span>
                <button
                  className="icon-btn"
                  aria-label={`接受 ${u.displayName} 的申请`}
                  disabled={!!busy}
                  onClick={() =>
                    void task('accept', async () => {
                      await api(settings, `/social/contacts/${u.id}`, { accept: true });
                      await refresh();
                    })
                  }
                >
                  <Check size={18} />
                </button>
                <button
                  className="icon-btn"
                  aria-label={`拒绝 ${u.displayName} 的申请`}
                  disabled={!!busy}
                  onClick={() =>
                    void task('reject', async () => {
                      await api(settings, `/social/contacts/${u.id}`, { accept: false });
                      await refresh();
                    })
                  }
                >
                  <X size={18} />
                </button>
              </div>
            ))}
            {overview?.outgoing.map((u) => (
              <div className="person-row" key={u.id}>
                <span>
                  <b>{u.displayName}</b>
                  <small>@{u.username} · 等待接受</small>
                </span>
                <button
                  className="text-link"
                  disabled={!!busy}
                  onClick={() =>
                    void task('cancel', async () => {
                      await api(settings, `/social/contacts/${u.id}`, undefined, 'DELETE');
                      await refresh();
                    })
                  }
                >
                  撤回
                </button>
              </div>
            ))}
          </section>
          <section className="surface full-width">
            <h2>我的联系人 · {overview?.contacts.length || 0}</h2>
            {overview?.contacts.map((u) => (
              <div className="person-row" key={u.id}>
                <div className="avatar">{u.displayName.slice(0, 1)}</div>
                <span>
                  <b>{u.displayName}</b>
                  <small>
                    @{u.username}
                    {u.city ? ` · ${u.city}` : ''}
                    {u.bio ? ` · ${u.bio}` : ''}
                  </small>
                </span>
                <button
                  className="secondary"
                  onClick={() => {
                    setSelected(u.id);
                    setTab('chat');
                  }}
                >
                  聊天
                </button>
                <details className="contact-remove">
                  <summary>更多</summary>
                  <p>移除后双方无法继续聊天和查看共享位置。</p>
                  <button
                    className="text-link danger"
                    disabled={!!busy}
                    onClick={() =>
                      void task('remove', async () => {
                        await api(settings, `/social/contacts/${u.id}`, undefined, 'DELETE');
                        await refresh();
                      })
                    }
                  >
                    确认移除联系人
                  </button>
                </details>
              </div>
            ))}
            {!overview?.contacts.length && (
              <p className="field-help">先添加一位朋友，开始新的对话。</p>
            )}
          </section>
        </div>
      ) : tab === 'chat' && !overview ? (
        <section className="surface social-empty" role="status">
          <LoaderCircle className="spin" size={24} />
          <p>正在读取联系人…</p>
        </section>
      ) : tab === 'chat' && !overview?.contacts.length ? (
        <section className="surface social-empty">
          <Users size={32} />
          <h2>还没有联系人</h2>
          <p>添加一位朋友，开始跨设备同步的聊天。</p>
          <button className="primary" onClick={() => setTab('contacts')}>
            <UserPlus size={16} />
            添加朋友
          </button>
        </section>
      ) : tab === 'chat' ? (
        <div className={`chat-layout social-chat-layout${contact ? ' has-selection' : ''}`}>
          <aside className="surface contact-list">
            <h2>对话</h2>
            {overview?.contacts.map((u) => (
              <button
                className={`contact-choice ${selected === u.id ? 'selected' : ''}`}
                key={u.id}
                onClick={() => setSelected(u.id)}
                disabled={!!busy}
              >
                <div className="avatar">{u.displayName.slice(0, 1)}</div>
                <span>
                  <b>{u.displayName}</b>
                  <small>{u.latest?.content || '说声你好吧'}</small>
                </span>
                {!!u.unread && (
                  <span className="unread-count" aria-label={`${u.unread} 条未读消息`}>
                    {u.unread > 99 ? '99+' : u.unread}
                  </span>
                )}
              </button>
            ))}
            {!overview?.contacts.length && (
              <div className="small-empty">
                <Users size={28} />
                <p>还没有联系人</p>
                <button className="text-link" onClick={() => setTab('contacts')}>
                  添加朋友 <ArrowRight size={14} aria-hidden="true" />
                </button>
              </div>
            )}
          </aside>
          <section className="surface chat-panel">
            {contact ? (
              <>
                <div className="chat-heading">
                  <button
                    className="icon-btn social-back"
                    aria-label="返回联系人列表"
                    onClick={() => setSelected('')}
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <div>
                    <h2>{contact.displayName}</h2>
                    <small>
                      @{contact.username}
                      {contact.city ? ` · ${contact.city}` : ''}
                    </small>
                  </div>
                  <span className="tag">联系人私聊</span>
                </div>
                <div className="message-scroll" ref={scroll}>
                  {messages.length >= 100 && (
                    <button
                      className="text-link"
                      disabled={!!busy}
                      onClick={() =>
                        void task('older', async () => {
                          const peer = selected;
                          const r = await api<{ messages: DirectMessage[] }>(
                            settings,
                            `/social/messages/${peer}?before=${messages[0].seq}`,
                          );
                          if (selectedRef.current === peer) {
                            setOlder(true);
                            setMessages((old) => [...r.messages, ...old]);
                            if (!r.messages.length) notify('已到最早的消息。');
                          }
                        })
                      }
                    >
                      加载更早消息
                    </button>
                  )}
                  {!messages.length && (
                    <div className="small-empty">
                      <MessageCircle size={30} />
                      <p>从一句问候开始。</p>
                    </div>
                  )}
                  {messages.map((m) => (
                    <div
                      className={`message ${m.senderId === session.user.id ? 'mine' : ''}`}
                      key={m.seq}
                    >
                      <small>
                        {m.senderId === session.user.id ? '我' : contact.displayName} ·{' '}
                        {dateLabel(m.createdAt)}
                      </small>
                      <p>{m.content}</p>
                    </div>
                  ))}
                </div>
                <form
                  className="message-composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!draft.trim() || busy) return;
                    const peer = selected,
                      input = draft;
                    pendingId.current ||= crypto.randomUUID();
                    const id = pendingId.current;
                    void task('send', async () => {
                      const r = await api<{ messages: DirectMessage[] }>(
                        settings,
                        `/social/messages/${peer}`,
                        { id, content: input },
                      );
                      if (selectedRef.current === peer) {
                        setMessages((old) => {
                          const ids = new Set(r.messages.map((m) => m.id));
                          return [...old.filter((m) => !ids.has(m.id)), ...r.messages].sort(
                            (a, b) => a.seq - b.seq,
                          );
                        });
                        setDraft('');
                        pendingId.current = null;
                        setOlder(false);
                      }
                    });
                  }}
                >
                  <textarea
                    aria-label="聊天消息"
                    rows={2}
                    maxLength={5000}
                    placeholder={`给 ${contact.displayName} 发消息…`}
                    value={draft}
                    disabled={!!busy}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      pendingId.current = null;
                    }}
                  />
                  <button
                    className="primary"
                    aria-label="发送消息"
                    disabled={!!busy || !draft.trim()}
                  >
                    {busy === 'send' ? (
                      <LoaderCircle className="spin" size={18} />
                    ) : (
                      <Send size={18} />
                    )}
                  </button>
                </form>
              </>
            ) : (
              <div className="small-empty">
                <MessageCircle size={36} />
                <h2>选一位朋友，聊聊此刻。</h2>
                <p>消息会同步到你已登录的设备。</p>
              </div>
            )}
          </section>
        </div>
      ) : (
        <>
          <section className="surface location-controls">
            <div>
              <div className="section-title">
                <Shield size={20} />
                <h2>{own ? '你正在分享位置' : '位置分享已关闭'}</h2>
                <span className="tag">{own ? '近似位置' : '默认关闭'}</span>
              </div>
              <p className="field-help">
                点击后获取一次近似位置，仅对已接受的联系人可见；不会持续追踪或保存路线。坐标约化到
                100 米量级，实际精度可能更低。
              </p>
              {own && (
                <p className="field-help">
                  本次有效至 {dateLabel(own.expiresAt)}。停止后，联系人下一次刷新即移除。
                </p>
              )}
            </div>
            <div className="action-row">
              <label className="sr-only" htmlFor="share-duration">
                分享有效期
              </label>
              <select
                id="share-duration"
                className="standard-input"
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value) as 15 | 60)}
              >
                <option value={15}>有效 15 分钟</option>
                <option value={60}>有效 1 小时</option>
              </select>
              <button className="primary" disabled={!!busy} onClick={() => void share()}>
                {busy === 'location' ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <MapPin size={17} />
                )}{' '}
                {own ? '更新此刻位置' : '分享此刻位置'}
              </button>
              {own && (
                <button
                  className="secondary"
                  disabled={!!busy}
                  onClick={() =>
                    void task('stop', async () => {
                      await api(settings, '/social/location', undefined, 'DELETE');
                      await refresh();
                      notify('位置分享已停止。');
                    })
                  }
                >
                  停止分享
                </button>
              )}
            </div>
          </section>
          <section className="surface map-surface">
            {loadMap ? (
              <Suspense fallback={<div className="small-empty">正在准备地图…</div>}>
                <ContactMap locations={liveLocations} names={names} />
              </Suspense>
            ) : (
              <div className="map-placeholder">
                <MapIcon size={42} />
                <h2>看看朋友分享的位置</h2>
                <p>
                  地图由 OpenStreetMap
                  提供。加载后会向地图服务请求当前视野的底图，分享位置无需先加载地图。
                </p>
                <button className="secondary" onClick={() => setLoadMap(true)}>
                  加载地图
                </button>
              </div>
            )}
          </section>
          <section className="surface">
            <h2>正在分享 · {liveLocations.length}</h2>
            {!liveLocations.length && (
              <p className="field-help">现在还没有人分享位置。朋友主动分享后会出现在这里。</p>
            )}
            {liveLocations.map((p) => (
              <div className="person-row" key={p.userId}>
                <MapPin size={20} />
                <span>
                  <b>{names[p.userId] || '联系人'}</b>
                  <small>
                    {p.latitude.toFixed(3)}, {p.longitude.toFixed(3)} · 约 {Math.round(p.accuracy)}{' '}
                    米范围 · {dateLabel(p.updatedAt)} 更新 · {dateLabel(p.expiresAt)} 失效
                  </small>
                </span>
              </div>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
