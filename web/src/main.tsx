import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { DesktopWindowBar } from './DesktopWindowBar';
import { MobilePanelsProvider, useMobilePanels } from './MobilePanels';
import { PiTasksProvider } from './pi-tasks';
import { resourceScope } from './resource-cache';
import { useBackLayer } from './back-navigation';
import {
  Sparkles,
  Sparkle,
  Layers,
  BookOpen,
  Puzzle,
  Settings as SettingsIcon,
  ArrowUpRight,
  ArrowRight,
  ArrowLeft,
  RefreshCw,
  Cloud,
  Check,
  Plus,
  X,
  Download,
  Trash2,
  Wifi,
  ChevronRight,
  Menu,
  LoaderCircle,
  Sun,
  Moon,
  Shield,
  Copy,
  Search,
  GalleryVerticalEnd,
  Users,
  Bot,
  UserRound,
  Mail,
  WandSparkles,
  Pencil,
  CheckCircle2,
} from 'lucide-react';
import {
  deck,
  spreads,
  loadEntries,
  loadSettings,
  api,
  localDraw,
  mergeEntries,
  dateLabel,
  validateSettings,
  persistSettings,
  loadPlugins,
  scopedStorageKey,
  loadScopedAI,
} from './data';
import { pluginSchema } from '../../shared/deck.mjs';
import examplePlugin from '../../server/plugins/journal.example.json';
import type {
  Page,
  Reading,
  Entry,
  Settings,
  Plugin,
  Spread,
  SyncStatus,
  AuthSession,
} from './types';
import { loadSession, persistSession, accountScope, serverIdentity } from './session';
import { AccountPage } from './AccountPage';
import { SocialPage } from './SocialPage';
import { PiPage } from './PiPage';
import { MailPage } from './MailPage';
import { LearningPage } from './LearningPage';
import { interpretReading, runAIPlugin, tarotQuestions } from './ai';
import { SettingsPage } from './SettingsPage';
import { Gallery } from './Gallery';
import { CardVisual, DeckThemeContext } from './Cards';
import type { DeckTheme } from './Cards';
import './style.css';
import './theme.css';
import './assistant-deepseek.css';
import './assistant-workspace.css';
import './assistant-activity.css';
import './conversation-management.css';
import './file-preview.css';
import { ThemeProvider, useTheme } from './Theme';
import { useNotifications } from './notifications';
import { NotificationButton } from './NotificationCenter';
import { useUnread, UnreadBadge } from './unread';
import './notifications.css';
import './icons.css';
import './tarot-mobile.css';
import './chat-layout.css';
import './mail-workspace.css';
import './social-mobile.css';

function CardBack({ small = false }: { small?: boolean }) {
  return (
    <img
      className={`card-back-image ${small ? 'small' : ''}`}
      src="./cards/back.svg"
      alt="星屿牌背 · 星轨与月相"
      draggable={false}
    />
  );
}
function FaceCard({ card, index }: { card: Reading['cards'][number]; index: number }) {
  const info = deck.find((c) => c.id === card.id)!;
  return (
    <div className="face-wrap" style={{ animationDelay: `${index * 0.12}s` }}>
      <div className="position-label">
        0{index + 1} <span>{card.position}</span>
      </div>
      <CardVisual id={card.id} className={card.reversed ? 'is-reversed' : ''} />
      <span className="orientation">
        {card.reversed ? '逆位 · 换一个角度' : '正位 · 顺着这份能量'}
      </span>
    </div>
  );
}
function App() {
  const [connection, setConnection] = useState<Settings>(() => {
    const s = loadSettings();
    return { ...s, ...loadScopedAI(accountScope(s, loadSession(s))) };
  });
  const [session, setSession] = useState<AuthSession | null>(() => loadSession(connection));
  function changeSession(next: AuthSession | null) {
    persistSession(next);
    setSession(next);
    // 登录前可能刚保存了新的服务器地址，用队列中的最新连接配置绑定会话。
    setConnection((current) => {
      const clean = next ? { ...current, token: '', remember: false } : current;
      const scope = accountScope(clean, next);
      const scoped = scope === current.aiScope ? clean : { ...clean, ...loadScopedAI(scope) };
      persistSettings(scoped);
      return scoped;
    });
  }
  function saveConnection(s: Settings) {
    let next = { ...s, sessionToken: undefined };
    if (serverIdentity(next) !== serverIdentity(connection))
      next = { ...next, ...loadScopedAI(accountScope(next, loadSession(next))) };
    persistSettings(next);
    setConnection(next);
    if (serverIdentity(next) !== serverIdentity(connection)) setSession(loadSession(next));
  }
  const scope = accountScope(connection, session);
  return (
    <MobilePanelsProvider key={scope}>
      <PiTasksProvider
        key={resourceScope({ ...connection, sessionToken: session?.token })}
        settings={{ ...connection, sessionToken: session?.token }}
        enabled={!!session}
      >
        <Workspace
          key={scope}
          scope={scope}
          session={session}
          settings={{ ...connection, sessionToken: session?.token }}
          changeSession={changeSession}
          saveConnection={saveConnection}
        />
      </PiTasksProvider>
    </MobilePanelsProvider>
  );
}
function Workspace({
  scope,
  session,
  settings,
  changeSession,
  saveConnection,
}: {
  scope: string;
  session: AuthSession | null;
  settings: Settings;
  changeSession: (s: AuthSession | null) => void;
  saveConnection: (s: Settings) => void;
}) {
  const [page, setPage] = useState<Page>('pi');
  const pageHistory = useRef<Page[]>([]);
  const unread = useUnread(settings, !!session);
  const [mailNotice, setMailNotice] = useState<{
    id: string;
    mailbox: string;
    uid: number;
    revision: string;
    uidValidity: string;
  } | null>(null);
  const [contactNotice, setContactNotice] = useState<{ id: string; contactId?: string } | null>(
    null,
  );
  const openNotification = (notification: {
    id?: string;
    conversationId?: string | null;
    taskId?: string | null;
    target?: import('./notifications').AppNotification['target'];
  }) => {
    if (notification.target?.type === 'mail') {
      setMailNotice({ id: notification.id || crypto.randomUUID(), ...notification.target });
      setPage('mail');
      return;
    }
    if (notification.target?.type === 'contact' || notification.target?.type === 'contacts') {
      setContactNotice({
        id: notification.id || crypto.randomUUID(),
        ...(notification.target.type === 'contact'
          ? { contactId: notification.target.contactId }
          : {}),
      });
      setPage('social');
      return;
    }
    if (notification.conversationId) {
      localStorage.setItem(
        `astral.pi.last:${settings.url}:${session?.user.id || 'guest'}`,
        notification.conversationId,
      );
      window.dispatchEvent(new CustomEvent('astral-open-pi', { detail: notification }));
    }
    setPage('pi');
  };
  const notifications = useNotifications(settings, session?.user.id, openNotification);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('notification');
    if (!session || !id || !/^[a-f0-9-]{36}$/.test(id)) return;
    let active = true;
    void api<{ notification: import('./notifications').AppNotification }>(
      settings,
      '/notifications/' + id,
    )
      .then((v) => {
        if (active) openNotification(v.notification);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [session?.user.id, settings.url]);
  useEffect(() => {
    const id = new URLSearchParams(location.search).get('piConversation');
    if (session && /^[a-f0-9-]{36}$/.test(id || '')) {
      localStorage.setItem(`astral.pi.last:${settings.url}:${session.user.id}`, id!);
      window.dispatchEvent(new CustomEvent('astral-open-pi', { detail: { conversationId: id } }));
      setPage('pi');
    }
  }, [session?.user.id, settings.url]);
  const { appearance, toggle: toggleTheme } = useTheme();
  const [deckTheme, setDeckTheme] = useState<DeckTheme>(() => {
    try {
      return localStorage.getItem('astral.deckTheme') === 'modern' ? 'modern' : 'classic';
    } catch {
      return 'classic';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('astral.deckTheme', deckTheme);
    } catch {}
  }, [deckTheme]);
  const { displayPanel: mobilePanel, setPanel: setMobilePanel } = useMobilePanels();
  const mobileNav = mobilePanel === 'workspace';
  const setMobileNav = (open: boolean) => setMobilePanel(open ? 'workspace' : null);
  const [activePluginId, setActivePluginId] = useState('');
  const [entries, setEntries] = useState<Entry[]>(() => loadEntries(scope));
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [notice, setNotice] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState('');
  const [plugins, setPlugins] = useState<Plugin[]>(() => loadPlugins(scope));
  const entriesRef = useRef(entries);
  const syncLock = useRef(false);
  const history = entries
    .filter((e) => !e.deleted && e.data)
    .map((e) => e.data!)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  useEffect(() => {
    entriesRef.current = entries;
    try {
      localStorage.setItem(scopedStorageKey('entries', scope), JSON.stringify(entries));
    } catch {
      setNotice('设备存储已满，最新记录未能持久保存。请先导出记录。');
    }
  }, [entries]);
  useEffect(() => {
    if (notice) {
      const t = setTimeout(() => setNotice(''), 6500);
      return () => clearTimeout(t);
    }
  }, [notice]);
  const refresh = useCallback(async (s: Settings) => {
    const result = await api<SyncStatus>(s, '/status');
    setStatus(result);
    const p = await api<{ plugins: Plugin[] }>(s, '/plugins');
    setPlugins((current) => [
      ...new Map([...current, ...p.plugins].map((p) => [p.id, p])).values(),
    ]);
    return result;
  }, []);
  useEffect(() => {
    setStatus(null);
    if (settings.sessionToken || settings.token) refresh(settings).catch(() => setStatus(null));
  }, [settings, refresh]);
  const sync = useCallback(
    async (quiet = false) => {
      if (syncLock.current) return;
      syncLock.current = true;
      setSyncing(true);
      try {
        const snapshot = entriesRef.current;
        let remote: Entry[] = [];
        for (let i = 0; i < Math.max(snapshot.length, 1); i += 25) {
          const response = await api<{ entries: Entry[] }>(settings, '/sync', {
            entries: snapshot.slice(i, i + 25),
          });
          remote = response.entries;
        }
        setEntries((current) => mergeEntries(current, remote));
        setLastSync(new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
        if (!quiet) setNotice('记录已与个人服务器同步。');
      } catch (e) {
        if (!quiet) setNotice((e as Error).message);
      } finally {
        syncLock.current = false;
        setSyncing(false);
      }
    },
    [settings],
  );
  useEffect(() => {
    if (!settings.autoSync || !(settings.sessionToken || settings.token)) return;
    const run = () => {
      if (document.visibilityState === 'visible') void sync(true);
    };
    run();
    const timer = setInterval(run, 30000);
    window.addEventListener('online', run);
    window.addEventListener('focus', run);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', run);
      window.removeEventListener('focus', run);
    };
  }, [settings.autoSync, settings.token, sync]);
  function saveReading(r: Reading) {
    setEntries((es) =>
      es.some((e) => e.id === r.id) ? es : [...es, { id: r.id, deleted: false, data: r }],
    );
    setNotice('已存入你的占卜手记。');
  }
  useEffect(() => {
    try {
      localStorage.setItem(scopedStorageKey('plugins', scope), JSON.stringify(plugins));
    } catch {
      setNotice('插件未能保存，请检查本机存储空间。');
    }
  }, [plugins]);
  function saveSettings(s: Settings) {
    saveConnection(s);
    setNotice('本机设置已保存，AI 密钥不会同步。');
  }
  function navigate(p: Page) {
    if (p === 'mail') setMailNotice(null);
    if (p === 'social') setContactNotice(null);
    if (p !== page) pageHistory.current = [...pageHistory.current.slice(-19), page];
    setPage(p);
    setMobileNav(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  function openPlugin(id: string) {
    setActivePluginId(id);
    navigate('plugins');
  }
  useBackLayer(
    page !== 'pi',
    () => {
      if (page === 'plugins' && activePluginId) {
        setActivePluginId('');
        return;
      }
      setPage(pageHistory.current.pop() || 'pi');
      setMobilePanel(null);
      window.scrollTo({ top: 0 });
    },
    10,
  );
  const tarotActive = ['tarot', 'gallery', 'history'].includes(page);
  const pageLabel = tarotActive
    ? '塔罗'
    : page === 'plugins' && activePluginId
      ? plugins.find((p) => p.id === activePluginId)?.name || '插件'
      : (
          {
            pi: '智能助手',
            mail: '邮件',
            learning: '学习',
            social: '联系人',
            plugins: '插件管理',
            account: '我的账号',
            settings: '连接与设置',
          } as Record<string, string>
        )[page];
  const nav = [
    { id: 'pi' as Page, label: '智能助手', icon: Bot },
    { id: 'social' as Page, label: '联系人', icon: Users },
  ];
  const shellActions = (
    <div className="topbar-actions">
      <NotificationButton model={notifications} />
      <button
        className="global-theme-toggle"
        aria-label={appearance === 'dark' ? '切换为浅色主题' : '切换为深色主题'}
        onClick={toggleTheme}
      >
        {appearance === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
        <span>{appearance === 'dark' ? '浅色' : '深色'}</span>
      </button>
      <button
        className={`connection-pill ${status ? 'connected' : ''}`}
        aria-label={status ? '个人服务器已连接，打开连接设置' : '连接个人服务器'}
        onClick={() => navigate('settings')}
      >
        <span className="connection-dot" />
        <span className="connection-label">{status ? '个人服务器已连接' : '连接个人服务器'}</span>
        <ArrowUpRight size={12} />
      </button>
    </div>
  );
  return (
    <DeckThemeContext.Provider value={deckTheme}>
      <div className="shell deepseek-shell" data-mobile-panel={mobilePanel || undefined}>
        <aside className={`sidebar ${mobileNav ? 'open' : ''}`} aria-label="星屿导航">
          <button
            className="icon-btn mobile-nav-close"
            aria-label="收起星屿导航"
            onClick={() => setMobileNav(false)}
          >
            <X size={19} />
          </button>
          <a
            href="#"
            className="brand"
            onClick={(e) => {
              e.preventDefault();
              navigate('pi');
            }}
          >
            <span className="brand-symbol">
              <img src="./icon.svg?v=0.8.3" width="28" height="28" alt="" aria-hidden="true" />
            </span>
            <span>
              星屿<small>ASTRAL SPACE</small>
            </span>
          </a>
          <div className="workspace-label">工作空间</div>
          <nav aria-label="主导航">
            {nav.map((n) => (
              <button
                key={n.id}
                className={page === n.id ? 'active' : ''}
                onClick={() => navigate(n.id)}
              >
                <n.icon size={19} />
                {n.label}
                {n.id === 'social' && (
                  <UnreadBadge
                    count={(unread.social?.messages || 0) + (unread.social?.requests || 0)}
                    label="条未读消息或联系人申请"
                  />
                )}
                {n.id === 'pi' && <span className="nav-dot" />}
              </button>
            ))}
            <div className="nav-group-heading">
              <span>插件</span>
              <button
                aria-label="添加或管理插件"
                onClick={() => {
                  setActivePluginId('');
                  navigate('plugins');
                }}
              >
                <Plus size={15} />
              </button>
            </div>
            <button
              className={tarotActive ? 'active' : ''}
              aria-current={tarotActive ? 'page' : undefined}
              onClick={() => navigate('tarot')}
            >
              <Layers size={19} />
              塔罗
            </button>
            <button
              className={page === 'mail' ? 'active' : ''}
              aria-current={page === 'mail' ? 'page' : undefined}
              onClick={() => navigate('mail')}
            >
              <Mail size={19} />
              邮件
              <UnreadBadge count={unread.mail?.count ?? undefined} label="封收件箱未读邮件" />
            </button>
            <button
              className={page === 'learning' ? 'active' : ''}
              aria-current={page === 'learning' ? 'page' : undefined}
              onClick={() => navigate('learning')}
            >
              <BookOpen size={19} />
              学习
            </button>
            {plugins.map((p) => (
              <button
                key={p.id}
                title={p.name}
                className={page === 'plugins' && activePluginId === p.id ? 'active' : ''}
                onClick={() => openPlugin(p.id)}
              >
                <Puzzle size={19} />
                <span className="nav-plugin-name">{p.name}</span>
              </button>
            ))}
            <button
              className={page === 'plugins' && !activePluginId ? 'active nav-manage' : 'nav-manage'}
              onClick={() => {
                setActivePluginId('');
                navigate('plugins');
              }}
            >
              <Plus size={17} />
              管理插件
            </button>
          </nav>
          <div className="sidebar-note">
            <span>
              <Sparkles size={20} aria-hidden="true" />
            </span>
            <p>
              想法在这里，
              <br />
              慢慢变成行动。
            </p>
            <small>A SPACE TO GET THINGS DONE</small>
          </div>
          <div className="sidebar-bottom">
            <button
              className={page === 'settings' ? 'active' : ''}
              onClick={() => navigate('settings')}
            >
              <SettingsIcon size={18} />
              连接与设置
            </button>
            <button className="profile" onClick={() => navigate('account')}>
              <div className="avatar">{session?.user.displayName.slice(0, 1) || '屿'}</div>
              <span>
                {session?.user.displayName || '我的个人空间'}
                <small>{session ? '@' + session.user.username : '登录以连接朋友'}</small>
              </span>
              <span className={`presence ${status ? 'online' : ''}`} />
            </button>
          </div>
        </aside>
        <button
          className={`nav-scrim ${mobileNav ? 'is-open' : ''}`}
          tabIndex={mobileNav ? 0 : -1}
          aria-hidden={!mobileNav}
          aria-label="关闭导航"
          onClick={() => setMobileNav(false)}
        />
        <div
          className={`workspace ${page === 'pi' ? 'assistant-workspace' : ''} ${page === 'mail' ? 'mail-workspace' : ''} ${page === 'plugins' || page === 'mail' ? 'plugin-workspace' : ''}`}
        >
          {page !== 'pi' && (
            <header className="topbar">
              <div className="crumb">
                <button
                  className="mobile-menu icon-btn"
                  aria-label="打开导航"
                  onClick={() => setMobileNav(true)}
                >
                  <Menu size={22} />
                </button>
                <span>我的空间</span>
                <ChevronRight size={13} />
                <b>{pageLabel}</b>
              </div>
              {shellActions}
            </header>
          )}
          <main
            className={page === 'pi' ? 'assistant-main' : page === 'mail' ? 'mail-main' : ''}
            key={page === 'plugins' ? `${page}:${activePluginId}` : page}
          >
            {tarotActive && (
              <div className="plugin-local-nav">
                <div>
                  <Layers size={19} />
                  <b>塔罗</b>
                  <span>内置插件</span>
                </div>
                <div role="tablist" aria-label="塔罗功能">
                  {(
                    [
                      { id: 'tarot', label: '抽牌' },
                      { id: 'gallery', label: '图鉴' },
                      { id: 'history', label: '手记' },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.id}
                      role="tab"
                      aria-selected={page === t.id}
                      className={page === t.id ? 'active' : ''}
                      onClick={() => navigate(t.id)}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {page === 'tarot' ? (
              <Tarot
                aiConfigured={
                  settings.aiMode === 'local' ? !!settings.apiKey.trim() : !!status?.aiConfigured
                }
                settings={settings}
                save={saveReading}
                openSettings={() => navigate('settings')}
              />
            ) : page === 'gallery' ? (
              <Gallery theme={deckTheme} onThemeChange={setDeckTheme} />
            ) : page === 'history' ? (
              <History
                readings={history}
                remove={(id) => {
                  setEntries((es) =>
                    es.map((e) => (e.id === id ? { id, deleted: true, data: null } : e)),
                  );
                  setNotice('已删除记录；同步后其他设备也会删除。');
                }}
                start={() => navigate('tarot')}
                sync={() => sync()}
                syncing={syncing}
                lastSync={lastSync}
              />
            ) : page === 'plugins' ? (
              <Plugins
                selectedId={activePluginId}
                openPlugin={openPlugin}
                openTarot={() => navigate('tarot')}
                openLearning={() => navigate('learning')}
                plugins={plugins}
                updatePlugins={setPlugins}
                settings={settings}
                connected={!!status}
                refresh={() => refresh(settings)}
                notify={setNotice}
                openSettings={() => navigate('settings')}
              />
            ) : page === 'account' ? (
              <AccountPage
                settings={settings}
                session={session}
                changeSession={changeSession}
                saveSettings={saveSettings}
                notify={setNotice}
              />
            ) : page === 'social' ? (
              <SocialPage
                openTarget={contactNotice}
                key={`${serverIdentity(settings)}:${session?.user.id || 'guest'}`}
                settings={settings}
                session={session}
                login={() => navigate('account')}
                notify={setNotice}
              />
            ) : page === 'pi' ? (
              <PiPage
                settings={settings}
                session={session}
                login={() => navigate('account')}
                shellActions={shellActions}
                openNavigation={() => setMobileNav(true)}
              />
            ) : page === 'learning' ? (
              <LearningPage
                key={`${serverIdentity(settings)}:${session?.user.id || 'guest'}`}
                settings={settings}
                session={session}
                login={() => navigate('account')}
              />
            ) : page === 'mail' ? (
              <MailPage
                openTarget={mailNotice}
                key={`${serverIdentity(settings)}:${session?.user.id || 'guest'}`}
                settings={settings}
                session={session}
                login={() => navigate('account')}
              />
            ) : (
              <SettingsPage
                admin={session?.user.role === 'owner'}
                notifications={notifications}
                settings={settings}
                save={saveSettings}
                test={refresh}
                status={status}
                sync={() => sync()}
                syncing={syncing}
                count={history.length}
                lastSync={lastSync}
                notify={setNotice}
              />
            )}
            {page !== 'pi' && (
              <footer>
                <span>
                  <Sparkle size={12} aria-hidden="true" /> 星屿 · 你的智能工作空间
                </span>
                <span>连接助手、朋友与你的工具。</span>
              </footer>
            )}
          </main>
        </div>
        {notice && (
          <div className="toast" role="status">
            <Check size={17} />
            {notice}
            <button aria-label="关闭通知" onClick={() => setNotice('')}>
              <X size={14} />
            </button>
          </div>
        )}
      </div>
    </DeckThemeContext.Provider>
  );
}
function Tarot({
  aiConfigured,
  settings,
  save,
  openSettings,
}: {
  aiConfigured: boolean;
  settings: Settings;
  save: (r: Reading) => void;
  openSettings: () => void;
}) {
  const [spread, setSpread] = useState<Spread>('three');
  const [question, setQuestion] = useState('');
  const [reading, setReading] = useState<Reading | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [phase, setPhase] = useState<'idle' | 'drawing' | 'revealed' | 'result'>('idle');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const resultRef = useRef<HTMLDivElement>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionState, setSuggestionState] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [suggestionError, setSuggestionError] = useState('');
  const suggestionRequest = useRef(0);
  const previousSuggestions = useRef<string[]>([]);
  async function refreshSuggestions() {
    if (!aiConfigured) return;
    const request = ++suggestionRequest.current;
    setSuggestionState('loading');
    setSuggestionError('');
    try {
      const result = await tarotQuestions(settings, previousSuggestions.current);
      if (suggestionRequest.current !== request) return;
      previousSuggestions.current = result.questions;
      setSuggestions(result.questions);
      setSuggestionState('ready');
    } catch (e) {
      if (suggestionRequest.current !== request) return;
      setSuggestionState('error');
      setSuggestionError((e as Error).message);
    }
  }
  useEffect(() => {
    previousSuggestions.current = [];
    setSuggestions([]);
    if (aiConfigured) void refreshSuggestions();
    else {
      setSuggestionState('idle');
      setSuggestionError('');
    }
    return () => {
      suggestionRequest.current++;
    };
  }, [
    aiConfigured,
    settings.aiMode,
    settings.model,
    settings.aiScope,
    settings.sessionToken,
    settings.url,
    settings.apiKey,
  ]);
  const count = spreads[spread].positions.length;
  async function start() {
    if (!question.trim()) return;
    setError('');
    setBusy('shuffle');
    try {
      const r = localDraw(question.trim(), spread);
      setReading(r);
      setSelected([]);
      setPhase('drawing');
      setSaved(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  function pick(index: number) {
    if (phase !== 'drawing' || selected.includes(index) || selected.length >= count) return;
    const next = [...selected, index];
    setSelected(next);
    if (next.length === count) setPhase('revealed');
  }
  async function analyze() {
    if (!reading) return;
    setBusy('analyze');
    setError('');
    try {
      const r = await interpretReading(
        settings,
        saved ? { ...reading, id: crypto.randomUUID() } : reading,
      );
      setReading(r);
      setPhase('result');
      save(r);
      setSaved(true);
      setTimeout(
        () => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        100,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  function localResult() {
    if (!reading) return;
    setPhase('result');
    if (!saved) {
      save(reading);
      setSaved(true);
    }
    setTimeout(
      () => resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      100,
    );
  }
  function reset() {
    setPhase('idle');
    setReading(null);
    setSelected([]);
    setError('');
    setSaved(false);
    void refreshSuggestions();
  }
  return (
    <>
      <div className="page-heading">
        <div className="eyebrow">
          <span /> A LITTLE CLARITY WITHIN
        </div>
        <h1>
          向内看，<em>答案自会浮现。</em>
        </h1>
        <p>让一场小小的抽牌，成为与自己认真对话的开始。</p>
        <div className="heading-star">✧</div>
      </div>
      <div className="tarot-layout">
        <section className="ritual-panel">
          <div className="section-title">
            <span className="number-badge">01</span>
            <h2>留一个问题给自己</h2>
            <span className="small-label">THE INTENTION</span>
          </div>
          <label className="field-label" htmlFor="question">
            此刻，你想探索什么？
          </label>
          <div className="question-box">
            <textarea
              id="question"
              maxLength={1000}
              value={question}
              disabled={phase !== 'idle'}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={'关于关系、成长、未来的选择……\n也可以，只是想听听此刻的自己。'}
            />
            <span>{question.length} / 1000</span>
          </div>
          <div className="suggestion-heading">
            <span>{suggestionState === 'loading' ? '正在生成推荐问题…' : 'AI 推荐问题'}</span>
            <button
              className="text-link"
              onClick={() => void refreshSuggestions()}
              disabled={!aiConfigured || phase !== 'idle' || suggestionState === 'loading'}
            >
              <RefreshCw size={12} className={suggestionState === 'loading' ? 'spin' : ''} />
              换一组
            </button>
          </div>
          <div className="suggestions" aria-busy={suggestionState === 'loading'}>
            {suggestions.map((q) => (
              <button key={q} disabled={phase !== 'idle'} onClick={() => setQuestion(q)}>
                {q}
                <ArrowUpRight size={11} />
              </button>
            ))}
          </div>
          {(suggestionError || !aiConfigured) && (
            <p className="suggestion-hint" role="status">
              {suggestionError || '连接 AI 后自动生成推荐问题，也可以直接输入。'}
            </p>
          )}
          <div className="spread-header">
            <label className="field-label">选择你的牌阵</label>
            <span>78 张完整牌组 · 含正逆位</span>
          </div>
          <div className="spread-options">
            {(['single', 'three'] as Spread[]).map((s) => (
              <button
                key={s}
                className={`spread-choice ${spread === s ? 'chosen' : ''}`}
                disabled={phase !== 'idle'}
                onClick={() => setSpread(s)}
              >
                <span className={`spread-mini ${s}`}>
                  <i />
                  {s === 'three' && (
                    <>
                      <i />
                      <i />
                    </>
                  )}
                </span>
                <span>
                  <b>{spreads[s].name}</b>
                  <small>{s === 'three' ? '过去 · 现在 · 未来' : '一张牌，一份此刻的指引'}</small>
                </span>
                <span className="radio">{spread === s && <span />}</span>
              </button>
            ))}
          </div>
          <div className="intention-bottom">
            <span>
              <Shield size={14} />
              属于你的问题，留在你的空间
            </span>
            <button className="text-link" onClick={openSettings}>
              连接设置
              <ArrowUpRight size={13} />
            </button>
          </div>
        </section>
        <aside className="moment-panel">
          <div className="moment-top">
            <Sun size={18} />
            <span>A MOMENT FOR YOU</span>
            <span>✧</span>
          </div>
          <h3>
            先深呼吸，
            <br />
            再听见心里的声音。
          </h3>
          <p>
            不必急着找到正确答案。
            <br />
            把注意力轻轻带回自己，
            <br />
            让直觉带你走近此刻。
          </p>
          <div className="moment-art">
            <div className="moon-shape" />
            <div className="horizon h1" />
            <div className="horizon h2" />
            <span className="mstar one">✦</span>
            <span className="mstar two">✧</span>
          </div>
          <small>THE UNIVERSE WITHIN YOU</small>
        </aside>
      </div>
      <section className={`draw-panel ${phase !== 'idle' ? 'started' : ''}`}>
        <div className="draw-heading">
          <div className="section-title">
            <span className="number-badge">02</span>
            <h2>
              {phase === 'idle'
                ? '让直觉，选一张牌'
                : phase === 'drawing'
                  ? `轻触牌面，选出 ${count} 张牌`
                  : '你抽到的，是此刻的回声'}
            </h2>
          </div>
          <span className="draw-state">
            {phase === 'drawing'
              ? `${selected.length} / ${count} 张已选`
              : phase === 'idle'
                ? '静心 · 默念 · 抽牌'
                : '每一张，都有它的位置'}
          </span>
        </div>
        {phase === 'idle' || phase === 'drawing' ? (
          <>
            <div className={`card-fan ${phase === 'drawing' ? 'selectable' : ''}`}>
              {Array.from({ length: 7 }, (_, i) => (
                <button
                  key={i}
                  className={`fan-card ${selected.includes(i) ? 'picked' : ''}`}
                  style={{ '--i': i - 3 } as React.CSSProperties}
                  disabled={phase !== 'drawing' || selected.includes(i)}
                  onClick={() => pick(i)}
                  aria-label={`抽取第 ${i + 1} 张牌`}
                >
                  <CardBack />
                  {selected.includes(i) && (
                    <span className="picked-label">
                      <Check size={17} />
                    </span>
                  )}
                </button>
              ))}
            </div>
            <div className="draw-callout">
              <span className="tiny-spark">✧</span>
              <p>
                {phase === 'idle'
                  ? '把问题轻放在心里，准备好了就开始吧。'
                  : '没有标准答案，选择让你停留的那张。'}
              </p>
            </div>
            {phase === 'idle' ? (
              <button
                className="primary start-btn"
                disabled={!question.trim() || !!busy}
                onClick={start}
              >
                {busy ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}
                洗牌，开始抽取
                <ArrowRight size={17} />
              </button>
            ) : (
              <button className="text-link" onClick={reset}>
                <RefreshCw size={14} />
                重新整理思绪
              </button>
            )}
          </>
        ) : (
          <>
            <div className={`revealed-cards ${count === 1 ? 'single-card' : ''}`}>
              {reading!.cards.map((c, i) => (
                <FaceCard key={c.id} card={c} index={i} />
              ))}
            </div>
            <div className="reading-question">“ {reading!.question} ”</div>
            <div className="action-row">
              <button className="primary" disabled={!!busy || !aiConfigured} onClick={analyze}>
                {busy === 'analyze' ? (
                  <LoaderCircle size={17} className="spin" />
                ) : (
                  <Sparkles size={17} />
                )}{' '}
                {busy === 'analyze'
                  ? '正在细读你的牌阵…'
                  : saved && reading?.source === 'deepseek'
                    ? '重新生成解读'
                    : 'DeepSeek 为我解读'}
              </button>
              <button className="secondary" disabled={!!busy || saved} onClick={localResult}>
                {saved ? '已存入手记' : '查看本地牌义并保存'}
              </button>
              <button className="text-link" disabled={!!busy} onClick={reset}>
                <RefreshCw size={14} />
                新的一次抽牌
              </button>
            </div>
            {!aiConfigured && (
              <p className="inline-hint">
                {settings.aiMode === 'server'
                  ? '连接个人服务器后即可解读；API Key 由服务器保管。'
                  : '在本机填写 DeepSeek 密钥，即可直连解读。'}{' '}
                <button className="text-link" onClick={openSettings}>
                  去设置
                  <ArrowUpRight size={12} />
                </button>
              </p>
            )}
          </>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="draw-foot">
          <span>✧</span>塔罗是一面镜子，帮助你看见可能；人生的方向，始终由你掌握。
        </div>
      </section>
      {phase === 'result' && reading && (
        <div ref={resultRef}>
          <ReadingDetail reading={reading} />
        </div>
      )}
      <div className="bottom-cards">
        <div>
          <span className="soft-icon">
            <BookOpen size={20} />
          </span>
          <div>
            <b>每一次抽牌，都值得被记下</b>
            <p>在占卜手记里，回望自己的变化与成长。</p>
          </div>
        </div>
        <div>
          <span className="soft-icon">
            <Cloud size={20} />
          </span>
          <div>
            <b>灵感随行，空间由你掌握</b>
            <p>连接个人服务器，让记录在设备间相遇。</p>
          </div>
          <button className="icon-btn" aria-label="设置个人服务器" onClick={openSettings}>
            <ArrowUpRight size={20} />
          </button>
        </div>
      </div>
    </>
  );
}
function ReadingDetail({ reading }: { reading: Reading }) {
  return (
    <section className="reading-detail">
      <div className="section-title">
        <Sparkles size={19} />
        <h2>{reading.analysis ? '给你的解读' : '来自牌面的提醒'}</h2>
        <span className="tag">
          {reading.analysis ? `DeepSeek · ${reading.model || 'AI'}` : '本地牌义 · 非 AI 解读'}
        </span>
      </div>
      <p className="summary-text">
        {reading.analysis?.summary ||
          '这些是牌面的象征词，试着观察：哪些与你的现状产生共鸣？哪些让你想换个角度看待问题？'}
      </p>
      <div className="interpretations">
        {reading.cards.map((c, i) => {
          const info = deck.find((d) => d.id === c.id)!;
          return (
            <article key={c.id}>
              <span>0{i + 1}</span>
              <div>
                <h3>
                  {reading.analysis?.cards[i]?.title ||
                    `${c.position} · ${info.name}（${c.reversed ? '逆位' : '正位'}）`}
                </h3>
                <p>
                  {reading.analysis?.cards[i]?.text || (c.reversed ? info.reversed : info.upright)}
                </p>
              </div>
            </article>
          );
        })}
      </div>
      {reading.analysis && (
        <div className="advice">
          <b>把启发，变成小小的行动</b>
          <ul>
            {reading.analysis.advice.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="inline-hint">解读供娱乐与自我反思，请结合现实信息做出判断。</div>
    </section>
  );
}
function History({
  readings,
  remove,
  start,
  sync,
  syncing,
  lastSync,
}: {
  readings: Reading[];
  remove: (id: string) => void;
  start: () => void;
  sync: () => void;
  syncing: boolean;
  lastSync: string;
}) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Reading | null>(null);
  const [confirm, setConfirm] = useState('');
  useBackLayer(!!selected, () => setSelected(null), 40);
  function download() {
    const blob = new Blob(
      [JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), readings }, null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `astral-readings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (selected)
    return (
      <>
        <button className="text-link back-link" onClick={() => setSelected(null)}>
          <ArrowLeft size={16} />
          返回占卜手记
        </button>
        <div className="page-heading compact">
          <div className="eyebrow">A PAGE OF YOUR JOURNEY</div>
          <h1 className="history-title">{selected.question}</h1>
          <p>
            {dateLabel(selected.createdAt)} · {spreads[selected.spread].name}
          </p>
        </div>
        <div className="revealed-cards history-cards">
          {selected.cards.map((c, i) => (
            <FaceCard key={c.id} card={c} index={i} />
          ))}
        </div>
        <ReadingDetail reading={selected} />
      </>
    );
  return (
    <>
      <div className="page-heading compact">
        <div className="eyebrow">LITTLE NOTES, GENTLE GROWTH</div>
        <h1>
          把每次看见，<em>留给以后的自己。</em>
        </h1>
        <p>
          共 {readings.length} 篇手记 ·{' '}
          {lastSync ? `最近同步于 ${lastSync}` : '记录保存在当前设备，可同步至个人服务器'}
        </p>
      </div>
      <div className="toolbar">
        <div className="search-box">
          <Search size={17} />
          <input
            aria-label="搜索占卜手记"
            placeholder="寻找一个问题或一张牌…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button className="secondary" onClick={download} disabled={!readings.length}>
          <Download size={16} />
          导出
        </button>
        <button className="secondary" onClick={sync} disabled={syncing}>
          <RefreshCw className={syncing ? 'spin' : ''} size={16} />
          同步记录
        </button>
      </div>
      {!readings.length ? (
        <div className="empty-state">
          <BookOpen size={34} />
          <h2>你的故事，从第一张牌开始</h2>
          <p>完成抽牌并保存解读后，会在这里留下一页。</p>
          <button className="primary" onClick={start}>
            开始一次抽牌
            <ArrowRight size={16} />
          </button>
        </div>
      ) : (
        <div className="history-grid">
          {readings
            .filter((r) =>
              (
                r.question + r.cards.map((c) => deck.find((d) => d.id === c.id)?.name).join('')
              ).includes(query),
            )
            .map((r) => (
              <article className="history-item" key={r.id}>
                <div className="history-date">
                  {dateLabel(r.createdAt)}
                  <span className="tag">{r.source === 'deepseek' ? 'AI 解读' : '本地牌义'}</span>
                </div>
                <button className="history-open" onClick={() => setSelected(r)}>
                  <h2>{r.question}</h2>
                  <div className="history-card-names">
                    {r.cards.map((c) => (
                      <span key={c.id}>
                        ✧ {deck.find((d) => d.id === c.id)?.name}
                        <small>{c.reversed ? '逆' : '正'}</small>
                      </span>
                    ))}
                  </div>
                  <span className="text-link">
                    翻开这一页
                    <ArrowUpRight size={14} />
                  </span>
                </button>
                <div className="history-item-foot">
                  <span>{spreads[r.spread].name}</span>
                  {confirm === r.id ? (
                    <span className="delete-confirm">
                      删除后同步至其他设备{' '}
                      <button
                        onClick={() => {
                          remove(r.id);
                          setConfirm('');
                        }}
                      >
                        确认
                      </button>
                      <button aria-label="取消删除" onClick={() => setConfirm('')}>
                        <X size={13} />
                      </button>
                    </span>
                  ) : (
                    <button
                      className="icon-btn"
                      aria-label={`删除手记：${r.question}`}
                      onClick={() => setConfirm(r.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </div>
              </article>
            ))}
        </div>
      )}
    </>
  );
}
function Plugins({
  selectedId,
  openPlugin,
  openTarot,
  openLearning,
  plugins,
  updatePlugins,
  settings,
  connected,
  refresh,
  notify,
  openSettings,
}: {
  selectedId: string;
  openPlugin: (id: string) => void;
  openTarot: () => void;
  openLearning: () => void;
  plugins: Plugin[];
  updatePlugins: (plugins: Plugin[]) => void;
  settings: Settings;
  connected: boolean;
  refresh: () => Promise<unknown>;
  notify: (s: string) => void;
  openSettings: () => void;
}) {
  const [editor, setEditor] = useState(false);
  const [manifest, setManifest] = useState(JSON.stringify(examplePlugin, null, 2));
  const [active, setActive] = useState<Plugin | null>(
    () => plugins.find((p) => p.id === selectedId) || null,
  );
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState('');
  const [wishOpen, setWishOpen] = useState(false);
  const [wish, setWish] = useState('');
  const [wishTarget, setWishTarget] = useState<Plugin | null>(null);
  const [wishDraft, setWishDraft] = useState<Plugin | null>(null);
  const [wishBusy, setWishBusy] = useState(false);
  const [wishError, setWishError] = useState('');
  const [wishPreview, setWishPreview] = useState(false);
  async function savePlugin(p: Plugin) {
    if (connected) await api(settings, '/plugins', p);
    updatePlugins([...plugins.filter((item) => item.id !== p.id), p]);
  }
  function openWish(target: Plugin | null = null) {
    setWishTarget(target);
    setWish('');
    setWishDraft(null);
    setWishError('');
    setWishPreview(false);
    setWishOpen(true);
    setEditor(false);
    setActive(null);
  }
  async function generateWish() {
    if (!connected) {
      setWishError('许愿生成需要个人服务器的 DeepSeek。请先连接服务器，或手动接入 JSON 插件。');
      return;
    }
    if (wish.trim().length < 2) {
      setWishError('再多说一点你想要什么。');
      return;
    }
    setWishBusy(true);
    setWishError('');
    setWishDraft(null);
    try {
      const result = await api<{ plugin: Plugin }>(
        settings,
        wishTarget ? `/plugins/${encodeURIComponent(wishTarget.id)}/wish` : '/plugins/wish',
        { wish: wish.trim() },
      );
      setWishDraft(result.plugin);
    } catch (e) {
      setWishError((e as Error).message);
    } finally {
      setWishBusy(false);
    }
  }
  async function installWish() {
    if (!wishDraft) return;
    setWishError('');
    try {
      const p = pluginSchema.parse(wishDraft);
      await savePlugin(p);
      notify(wishTarget ? '插件已按愿望修改。' : '许愿插件已安装并启用。');
      setWishOpen(false);
      setWishTarget(null);
      setWishDraft(null);
      setWish('');
    } catch (e) {
      setWishError((e as Error).message);
    }
  }
  async function install() {
    setError('');
    setBusy(true);
    try {
      const p = pluginSchema.parse(JSON.parse(manifest));
      await savePlugin(p);
      setEditor(false);
      notify(connected ? '插件已保存到本机并同步配置。' : '插件已在本机启用，无需服务器即可运行。');
    } catch (e) {
      setError(
        e instanceof SyntaxError ? 'JSON 格式有误，请检查括号和引号。' : (e as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }
  async function run() {
    if (!active) return;
    setError('');
    setOutput('');
    setBusy(true);
    try {
      setOutput(await runAIPlugin(settings, active, input));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function uninstall(id: string) {
    try {
      if (connected) await api(settings, `/plugins/${id}`, undefined, 'DELETE');
      updatePlugins(plugins.filter((p) => p.id !== id));
      setDeleting('');
      notify('插件已移除。');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <div className="page-heading compact">
        <div className="eyebrow">A SPACE THAT GROWS WITH YOU</div>
        <h1>
          {active ? active.name : '让工作空间，'}
          {!active && <em>多一点可能。</em>}
        </h1>
        <p>{active ? active.description : '管理已安装的插件，每个插件也可以从左侧直接打开。'}</p>
      </div>
      {!selectedId && (
        <div className="toolbar">
          <span className="muted">{plugins.length + 1} 个插件 · 同一个 DeepSeek 连接</span>
          <div className="action-row">
            <button className="secondary" onClick={() => openWish()}>
              <WandSparkles size={16} />
              许愿接入
            </button>
            <button
              className="primary"
              onClick={() => {
                setEditor(true);
                setActive(null);
                setError('');
                setWishOpen(false);
              }}
            >
              <Plus size={16} />
              接入自定义插件
            </button>
          </div>
        </div>
      )}
      {!selectedId && (
        <div className="plugin-grid">
          <article className="plugin-item builtin">
            <div className="plugin-icon">
              <Layers size={24} />
            </div>
            <span className="tag">内置 · 已启用</span>
            <h2>塔罗占卜</h2>
            <p>78 张牌与此刻的你相遇，从牌面里寻找另一种看待生活的方式。</p>
            <div className="plugin-meta">抽牌 · 图鉴 · 手记</div>
            <button className="text-link" onClick={openTarot}>
              打开塔罗
              <ArrowUpRight size={15} />
            </button>
          </article>
          <article className="plugin-item builtin">
            <div className="plugin-icon">
              <BookOpen size={24} />
            </div>
            <span className="tag">内置 · 已启用</span>
            <h2>学习</h2>
            <p>按知识点讲解与练习，选择题精确判分、问答题智能批改，保留错题与复习记录。</p>
            <div className="plugin-meta">讲解 · 练习 · 错题本</div>
            <button className="text-link" onClick={openLearning}>
              打开学习
              <ArrowUpRight size={15} />
            </button>
          </article>
          {plugins.map((p) => (
            <article className="plugin-item" key={p.id}>
              <div className="plugin-icon">
                <BookOpen size={24} />
              </div>
              <span className="tag">自定义 · v{p.version}</span>
              <h2>{p.name}</h2>
              <p>{p.description}</p>
              <div className="plugin-actions">
                <button
                  className="text-link"
                  onClick={() => {
                    openPlugin(p.id);
                  }}
                >
                  打开插件
                  <ArrowUpRight size={15} />
                </button>
                <button className="text-link" onClick={() => openWish(p)}>
                  <Pencil size={13} />
                  许愿修改
                </button>
                {deleting === p.id ? (
                  <>
                    <button className="text-link danger" onClick={() => uninstall(p.id)}>
                      确认移除
                    </button>
                    <button
                      className="icon-btn"
                      aria-label="取消移除"
                      onClick={() => setDeleting('')}
                    >
                      <X size={14} />
                    </button>
                  </>
                ) : (
                  <button
                    className="icon-btn"
                    aria-label={`移除插件 ${p.name}`}
                    onClick={() => setDeleting(p.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </article>
          ))}
          <button
            className="plugin-add"
            onClick={() => {
              openWish();
            }}
          >
            <WandSparkles size={28} />
            <b>许愿一个新插件</b>
            <span>说清你想要什么，DeepSeek 帮你把提示词写出来。</span>
          </button>
        </div>
      )}
      {!connected && (
        <div className="info-banner">
          <Cloud size={19} />
          <span>
            {settings.aiMode === 'server'
              ? '连接个人服务器即可使用服务器 AI；也可在设置切换到本机直连。'
              : '当前选择本机直连，插件使用本机 API Key。'}
          </span>
          <button className="text-link" onClick={openSettings}>
            连接服务器
            <ArrowRight size={15} />
          </button>
        </div>
      )}
      {editor && (
        <section className="surface editor">
          <div className="section-title">
            <Puzzle size={20} />
            <h2>接入一个新插件</h2>
            <button
              className="icon-btn push-right"
              aria-label="关闭插件编辑"
              onClick={() => setEditor(false)}
            >
              <X size={18} />
            </button>
          </div>
          <p className="muted">
            填写 JSON 配置，定义输入和 AI 的工作方式。下面的「心绪手记」可以直接作为第一个插件安装。
          </p>
          <label className="field-label" htmlFor="plugin-json">
            插件配置 · JSON
          </label>
          <textarea
            id="plugin-json"
            className="code-editor"
            value={manifest}
            onChange={(e) => setManifest(e.target.value)}
            spellCheck={false}
          />
          <div className="action-row">
            <button className="primary" disabled={busy} onClick={install}>
              {busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}保存并启用
            </button>
            <label className="secondary file-button">
              导入 JSON
              <input
                type="file"
                accept=".json,application/json"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    if (f.size > 20000) {
                      setError('配置文件过大，请控制在 20 KB 内。');
                      return;
                    }
                    setManifest(await f.text());
                  }
                }}
              />
            </label>
            <button
              className="text-link"
              onClick={() => setManifest(JSON.stringify(examplePlugin, null, 2))}
            >
              恢复示例
            </button>
          </div>
          <p className="inline-hint">
            v1 支持 ai.text 能力。AI 使用设置中选择的调用方式，密钥不会包含在插件配置或同步数据中。
          </p>
        </section>
      )}
      {wishOpen && (
        <section className="surface editor wish-panel">
          <div className="section-title">
            <WandSparkles size={20} />
            <h2>{wishTarget ? `许愿修改「${wishTarget.name}」` : '许愿接入一个新插件'}</h2>
            <button
              className="icon-btn push-right"
              aria-label="关闭许愿面板"
              onClick={() => setWishOpen(false)}
            >
              <X size={18} />
            </button>
          </div>
          <p className="muted">
            用一句话说清你想要的能力、语气或输出形式。DeepSeek
            会生成一份可预览的插件配置，不会立即保存。
          </p>
          {wishTarget && (
            <div className="wish-target">
              <Pencil size={14} />
              正在修改：{wishTarget.name}
              <span>id 保持不变</span>
            </div>
          )}
          <label className="field-label" htmlFor="plugin-wish">
            你的愿望
          </label>
          <textarea
            id="plugin-wish"
            className="standard-textarea wish-input"
            value={wish}
            onChange={(e) => setWish(e.target.value)}
            maxLength={2000}
            placeholder={
              wishTarget
                ? '例如：语气再温柔一点，输出改成三小段，最后留一句给明天的提醒。'
                : '例如：我想要一个把梦境整理成象征解读的插件，语气安静，不要下结论。'
            }
          />
          <div className="wish-examples">
            {[
              '把每天最想记住的一件小事写成温柔的手记',
              '把梦境整理成象征解读，不要下确定结论',
              '把零散想法整理成三条可执行的下一步',
            ].map((example) => (
              <button className="secondary" key={example} onClick={() => setWish(example)}>
                {example}
              </button>
            ))}
          </div>
          <div className="action-row">
            <button
              className="primary"
              disabled={wishBusy || !wish.trim() || !connected}
              onClick={generateWish}
            >
              {wishBusy ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}
              生成草稿
            </button>
            {!connected && (
              <span className="inline-hint">许愿生成需要连接个人服务器的 DeepSeek。</span>
            )}
          </div>
          {wishError && (
            <div className="error" role="alert">
              {wishError}
            </div>
          )}
          {wishDraft && (
            <div className="wish-draft">
              <div className="wish-draft-head">
                <div className="plugin-icon">
                  <Sparkles size={22} />
                </div>
                <div>
                  <h3>{wishDraft.name}</h3>
                  <p>{wishDraft.description}</p>
                  <span className="tag">
                    {wishDraft.id} · {wishDraft.icon}
                  </span>
                </div>
              </div>
              <label className="field-label">输入标签</label>
              <p className="wish-input-label">{wishDraft.inputLabel}</p>
              <label className="field-label">系统提示词</label>
              <pre className="wish-prompt">{wishDraft.prompt}</pre>
              <div className="action-row">
                <button className="primary" onClick={installWish}>
                  <CheckCircle2 size={16} />
                  {wishTarget ? '保存修改' : '安装并启用'}
                </button>
                <button className="secondary" onClick={() => setWishPreview(!wishPreview)}>
                  {wishPreview ? '收起 JSON' : '查看 JSON'}
                </button>
                <button className="text-link" disabled={wishBusy} onClick={generateWish}>
                  重新生成
                </button>
              </div>
              {wishPreview && (
                <textarea
                  className="code-editor"
                  readOnly
                  value={JSON.stringify(wishDraft, null, 2)}
                />
              )}
            </div>
          )}
        </section>
      )}
      {active && (
        <section className="surface">
          <div className="section-title">
            <BookOpen size={20} />
            <h2>{active.name}</h2>
            <button
              className="icon-btn push-right"
              aria-label="关闭插件"
              onClick={() => openPlugin('')}
            >
              <X size={18} />
            </button>
          </div>
          <label className="field-label" htmlFor="plugin-input">
            {active.inputLabel}
          </label>
          <textarea
            id="plugin-input"
            className="standard-textarea"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            maxLength={5000}
            placeholder={active.inputPlaceholder}
          />
          <button className="primary" disabled={!input.trim() || busy} onClick={run}>
            {busy ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}生成内容
          </button>
          {output && (
            <div className="plugin-output">
              {output}
              <p className="inline-hint">本次插件输出仅在当前页面展示，刷新页面会清除。</p>
            </div>
          )}
        </section>
      )}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <div className="info-caption">
        <Shield size={15} />
        插件配置保存在本机，可同步到个人服务器；AI 使用设置中选择的调用方式。
      </div>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <DesktopWindowBar />
    <App />
  </ThemeProvider>,
);
