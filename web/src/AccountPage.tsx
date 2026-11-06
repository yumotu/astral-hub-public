import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  UserRound,
  LogOut,
  UserPlus,
  KeyRound,
  Copy,
  LoaderCircle,
  ArrowRight,
} from 'lucide-react';
import { api, validateSettings } from './data';
import { serverIdentity, endSession } from './session';
import type { AuthSession, Settings, User } from './types';
export function AccountPage({
  settings,
  session,
  changeSession,
  saveSettings,
  notify,
}: {
  settings: Settings;
  session: AuthSession | null;
  changeSession: (s: AuthSession | null) => void;
  saveSettings: (s: Settings) => void;
  notify: (s: string) => void;
}) {
  const requiresServer = Capacitor.isNativePlatform() || Boolean(window.astralDesktop);
  const [mode, setMode] = useState<'login' | 'register' | 'bootstrap'>('login');
  const [url, setUrl] = useState(
      () =>
        settings.url ||
        (!Capacitor.isNativePlatform() &&
        !window.astralDesktop &&
        /^https?:$/.test(location.protocol)
          ? location.origin
          : ''),
    ),
    [initialized, setInitialized] = useState<boolean | null>(null);
  const [username, setUsername] = useState(''),
    [displayName, setDisplayName] = useState(session?.user.displayName || ''),
    [password, setPassword] = useState(''),
    [invite, setInvite] = useState('');
  const [remember, setRemember] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [inviteCode, setInviteCode] = useState('');
  const [bio, setBio] = useState(session?.user.bio || ''),
    [city, setCity] = useState(session?.user.city || ''),
    [oldPassword, setOldPassword] = useState('');
  useEffect(() => {
    if (session) {
      setDisplayName(session.user.displayName);
      setBio(session.user.bio);
      setCity(session.user.city);
    }
  }, [session?.user.id]);
  useEffect(() => {
    let alive = true;
    setInitialized(null);
    if (requiresServer && !url.trim()) return;
    api<{ initialized: boolean }>({ ...settings, url }, '/auth/status', undefined, undefined, true)
      .then((r) => {
        if (alive) {
          setInitialized(r.initialized);
          if (!r.initialized) setMode('bootstrap');
          else setMode('login');
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [url, requiresServer]);
  async function task(fn: () => Promise<void>) {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function authenticate(e: React.FormEvent) {
    e.preventDefault();
    await task(async () => {
      if (requiresServer && !url.trim())
        throw new Error('请先填写星屿服务器的 HTTPS 地址，安装版应用不能留空连接本站。');
      const connection = { ...settings, url: url.trim() };
      validateSettings(connection);
      const p =
        mode === 'login'
          ? { username, password }
          : mode === 'bootstrap'
            ? { username, password, displayName, adminToken: invite }
            : { username, password, displayName, invite };
      const result = await api<{ token: string; user: User; expiresAt: string }>(
        connection,
        `/auth/${mode}`,
        p,
        undefined,
        true,
      );
      saveSettings(connection);
      changeSession({ ...result, remember, server: serverIdentity(connection) });
      setPassword('');
      setInvite('');
      notify('已进入你的账号空间。');
    });
  }
  return (
    <>
      <div className="page-heading compact">
        <div className="eyebrow">YOUR OWN SPACE</div>
        <h1>
          相遇之前，<em>先认识你。</em>
        </h1>
        <p>用独立账号连接各台设备。你的手记与 Pi 对话只属于你。</p>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {!session ? (
        <section className="surface account-form">
          <div className="section-title">
            <UserRound size={21} />
            <h2>
              {mode === 'bootstrap'
                ? '建立管理员账号'
                : mode === 'register'
                  ? '加入星屿'
                  : '登录星屿'}
            </h2>
          </div>
          <label className="field-label" htmlFor="account-server">
            服务器地址
          </label>
          <input
            id="account-server"
            className="standard-input"
            type="url"
            placeholder={requiresServer ? 'https://你的星屿服务器地址' : '网页版留空连接本站'}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <p className="field-help">
            {requiresServer
              ? '安装版需要填写服务器 HTTPS 地址，再使用已有账号登录。127.0.0.1 仅适用于服务器或隧道所在的那台设备。'
              : '网页版可留空连接当前网站；其他设备打开相同的 HTTPS 地址即可使用同一账号。'}
          </p>
          {initialized === null && (
            <p className="field-help">填写服务器地址后即可登录；首次使用请选择建立管理员。</p>
          )}
          <div className="segmented social-tabs" aria-label="账号方式">
            <button className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
              登录
            </button>
            <button
              className={mode === 'register' ? 'active' : ''}
              onClick={() => setMode('register')}
            >
              邀请码注册
            </button>
            {initialized !== true && (
              <button
                className={mode === 'bootstrap' ? 'active' : ''}
                onClick={() => setMode('bootstrap')}
              >
                建立管理员
              </button>
            )}
          </div>
          <form onSubmit={authenticate}>
            <label className="field-label" htmlFor="account-username">
              用户名
            </label>
            <input
              id="account-username"
              className="standard-input"
              autoComplete="username"
              required
              minLength={3}
              maxLength={32}
              value={username}
              onChange={(e) => setUsername(e.target.value.toLowerCase())}
              placeholder="字母、数字、下划线，3–32 位"
            />
            {mode !== 'login' && (
              <>
                <label className="field-label" htmlFor="account-name">
                  显示名称
                </label>
                <input
                  id="account-name"
                  className="standard-input"
                  required
                  maxLength={40}
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="朋友如何称呼你"
                />
              </>
            )}
            <label className="field-label" htmlFor="account-password">
              密码
            </label>
            <input
              id="account-password"
              className="standard-input"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              required
              minLength={mode === 'login' ? 1 : 10}
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'login' ? '输入密码' : '至少 10 个字符'}
            />
            {mode !== 'login' && (
              <>
                <label className="field-label" htmlFor="account-invite">
                  {mode === 'bootstrap' ? '管理员令牌 APP_TOKEN' : '一次性邀请码'}
                </label>
                <input
                  id="account-invite"
                  className="standard-input"
                  type="password"
                  autoComplete="off"
                  required
                  value={invite}
                  onChange={(e) => setInvite(e.target.value)}
                  maxLength={256}
                />
                <p className="field-help">
                  {mode === 'bootstrap'
                    ? '仅首次建号需要。管理员会接管旧版共享手记，令牌请留在自己手中。'
                    : '向管理员索取邀请码；有效期七天，使用一次即失效。'}
                </p>
              </>
            )}
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>
                在这台设备保持登录<small>仅在自己的设备开启；密码不会保存。</small>
              </span>
            </label>
            <button className="primary" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowRight size={17} />}{' '}
              {mode === 'login' ? '登录' : mode === 'bootstrap' ? '建立管理员账号' : '注册并登录'}
            </button>
          </form>
        </section>
      ) : (
        <div className="account-grid">
          <section className="surface">
            <div className="section-title">
              <UserRound size={21} />
              <h2>个人资料</h2>
              <span className="tag">{session.user.role === 'owner' ? '管理员' : '成员'}</span>
            </div>
            <p className="account-handle">@{session.user.username}</p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void task(async () => {
                  const r = await api<{ user: User }>(settings, '/auth/profile', {
                    displayName,
                    bio,
                    city,
                  });
                  changeSession({ ...session, user: r.user });
                  notify('资料已更新。');
                });
              }}
            >
              <label className="field-label" htmlFor="profile-name">
                显示名称
              </label>
              <input
                id="profile-name"
                className="standard-input"
                required
                maxLength={40}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
              <label className="field-label" htmlFor="profile-bio">
                关于我
              </label>
              <textarea
                id="profile-bio"
                className="standard-input"
                maxLength={300}
                rows={3}
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                placeholder="与联系人分享的一点介绍"
              />
              <label className="field-label" htmlFor="profile-city">
                城市（选填）
              </label>
              <input
                id="profile-city"
                className="standard-input"
                maxLength={80}
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="可留空，不会自动读取"
              />
              <p className="field-help">
                个人介绍和城市仅向已接受的联系人展示；城市不会自动开启位置分享。
              </p>
              <button className="primary" disabled={busy}>
                保存资料
              </button>
            </form>
          </section>
          <div>
            {session.user.role === 'owner' && (
              <section className="surface">
                <div className="section-title">
                  <UserPlus size={20} />
                  <h2>邀请朋友</h2>
                </div>
                <p className="field-help">生成一次性邀请码，让朋友建立独立账号。</p>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void task(async () => {
                      const r = await api<{ code: string }>(settings, '/auth/invitations', {});
                      setInviteCode(r.code);
                    })
                  }
                >
                  生成邀请码
                </button>
                {inviteCode && (
                  <div className="invite-result">
                    <code>{inviteCode}</code>
                    <button
                      className="icon-btn"
                      aria-label="复制邀请码"
                      onClick={() =>
                        void task(async () => {
                          await navigator.clipboard.writeText(inviteCode);
                          notify('邀请码已复制。');
                        })
                      }
                    >
                      <Copy size={17} />
                    </button>
                    <small>七天内有效，使用一次后失效。</small>
                  </div>
                )}
              </section>
            )}
            <section className="surface">
              <div className="section-title">
                <KeyRound size={20} />
                <h2>账号安全</h2>
              </div>
              <details>
                <summary>修改密码</summary>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void task(async () => {
                      const result = await api<{ token: string; user: User; expiresAt: string }>(
                        settings,
                        '/auth/password',
                        { oldPassword, password },
                      );
                      changeSession({ ...session, ...result });
                      setPassword('');
                      setOldPassword('');
                      notify('密码已修改，其他设备需要重新登录。');
                    });
                  }}
                >
                  <label className="field-label" htmlFor="old-password">
                    原密码
                  </label>
                  <input
                    id="old-password"
                    className="standard-input"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                  />
                  <label className="field-label" htmlFor="new-password">
                    新密码
                  </label>
                  <input
                    id="new-password"
                    className="standard-input"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={10}
                    maxLength={128}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button className="secondary" disabled={busy}>
                    修改密码
                  </button>
                </form>
              </details>
              <p className="field-help">退出后此设备不再显示账号的缓存手记。再次登录可继续使用。</p>
              <button
                className="secondary"
                disabled={busy}
                onClick={() =>
                  void task(async () => {
                    const revoked = await endSession(
                      () => api(settings, '/auth/logout', {}),
                      () => changeSession(null),
                    );
                    notify(
                      revoked ? '已退出账号。' : '已在本机退出；服务器会话撤销未确认，可重新登录。',
                    );
                  })
                }
              >
                <LogOut size={16} />
                退出登录
              </button>
            </section>
          </div>
        </div>
      )}
    </>
  );
}
