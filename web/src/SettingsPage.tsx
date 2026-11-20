import { useState } from 'react';
import {
  Cloud,
  Wifi,
  RefreshCw,
  LoaderCircle,
  KeyRound,
  ArrowUpRight,
  ArrowRight,
  Check,
  Shield,
  Copy,
  Bot,
} from 'lucide-react';
import { testConfiguredAI } from './ai';
import { validateSettings } from './data';
import type { Settings, SyncStatus } from './types';
import { useAssistantPreferences } from './assistant-preferences';
import { NotificationSettings } from './NotificationCenter';
import { AppUpdates } from './AppUpdates';
import type { NotificationModel } from './notifications';
import { MobileNavigationSettings } from './MobilePanels';
import { ThemeSettings } from './Theme';
import { UsagePanel } from './UsagePanel';
import { AdminPermissions } from './AdminPermissions';
import { MemorySettings } from './MemorySettings';
export function SettingsPage({
  settings,
  save,
  test,
  status,
  sync,
  syncing,
  count,
  lastSync,
  notify,
  notifications,
  admin = false,
}: {
  settings: Settings;
  save: (s: Settings) => void;
  test: (s: Settings) => Promise<SyncStatus>;
  status: SyncStatus | null;
  sync: () => void;
  syncing: boolean;
  count: number;
  lastSync: string;
  notify: (s: string) => void;
  notifications: NotificationModel;
  admin?: boolean;
}) {
  const [draft, setDraft] = useState(settings);
  const { showThinking, setShowThinking, messageMode, setMessageMode } = useAssistantPreferences();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [success, setSuccess] = useState('');
  function field(key: keyof Settings, value: string | boolean) {
    setDraft((s) => ({ ...s, [key]: value }));
    setError('');
    setSuccess('');
  }
  function persist() {
    try {
      save(draft);
      setSuccess('本机配置已保存。');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function testAI() {
    setBusy('ai');
    setError('');
    setSuccess('');
    try {
      validateSettings(draft);
      await testConfiguredAI(draft);
      if (draft.aiMode === 'server') await test(draft);
      save(draft);
      setSuccess(
        draft.aiMode === 'server'
          ? '服务器已连接 DeepSeek，设备无需填写 API Key。'
          : '本机已直接连接 DeepSeek，密钥有效。',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  async function connect() {
    setBusy('sync');
    setError('');
    setSuccess('');
    try {
      validateSettings(draft);
      await test(draft);
      save(draft);
      setSuccess(
        draft.aiMode === 'server'
          ? '服务器连接成功，可使用服务器 AI 与数据同步。'
          : '同步服务连接成功。AI 请求由本机直连。',
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }
  return (
    <>
      <div className="page-heading compact">
        <div className="eyebrow">LOCAL INTELLIGENCE, SHARED MEMORIES</div>
        <h1>
          选择调用方式，<em>记录随你同行。</em>
        </h1>
        <p>默认由个人服务器调用 DeepSeek，也可切换到本机直连。</p>
      </div>
      <div className="connection-principle">
        <span>
          <KeyRound size={17} />
          {draft.aiMode === 'server' ? '个人服务器密钥' : '本机密钥'}
        </span>
        <ArrowRight size={15} aria-hidden="true" />
        <span>DeepSeek 官方 API</span>
        <i />
        <span>
          <Cloud size={17} />
          个人服务器
        </span>
        <ArrowRight size={15} aria-hidden="true" />
        <span>手记与聊天消息同步</span>
      </div>
      <div className="settings-layout">
        <div className="settings-main">
          <ThemeSettings />
          <section className="surface" aria-label="智能助手设置">
            <div className="section-title">
              <Bot size={21} />
              <h2>智能助手偏好</h2>
              <span className="tag">当前设备 · 立即生效</span>
            </div>
            <label className="check-line">
              <input
                type="checkbox"
                checked={showThinking}
                onChange={(event) => setShowThinking(event.target.checked)}
              />
              <span>
                显示思考过程
                <small>展开查看模型实际返回的思考内容。思考强度在聊天输入区调节。</small>
              </span>
            </label>
            <label className="field-label" htmlFor="pi-message-mode">
              连续发送
            </label>
            <select
              id="pi-message-mode"
              className="standard-input"
              value={messageMode}
              aria-describedby="pi-message-mode-help"
              onChange={(event) => setMessageMode(event.target.value as 'steer' | 'queue')}
            >
              <option value="steer">补充当前任务（默认）</option>
              <option value="queue">等待下一条</option>
            </select>
            <p className="field-help" id="pi-message-mode-help">
              {messageMode === 'steer'
                ? '点击即向当前 Agent 发送补充，在当前工具步骤结束后的下一次模型调用读取，无需等待整个任务完成。'
                : '新指令排入队列，等待当前任务完成后再执行；排队消息可编辑或撤回。'}
            </p>
          </section>
          <MobileNavigationSettings />
          <MemorySettings settings={settings} />
          {admin && <AdminPermissions settings={settings} />}
          <NotificationSettings model={notifications} />
          <AppUpdates settings={settings} />
          <UsagePanel settings={settings} />
          <section className="surface">
            <div className="section-title">
              <KeyRound size={21} />
              <h2>DeepSeek 调用方式</h2>
              <span className="tag">{draft.aiMode === 'server' ? '服务器调用' : '本机直连'}</span>
            </div>
            <label className="field-label" htmlFor="ai-mode">
              调用方式
            </label>
            <select
              id="ai-mode"
              className="standard-input"
              value={draft.aiMode}
              onChange={(e) => field('aiMode', e.target.value)}
            >
              <option value="server">服务器调用（推荐）</option>
              <option value="local">本机直连</option>
            </select>
            {draft.aiMode === 'server' ? (
              <>
                <p className="field-help">
                  API Key 仅保存在个人服务器。设备使用下方访问令牌发起解读，密钥不会下发到设备。
                </p>
                <p className="inline-hint">
                  {status?.aiConfigured
                    ? `服务器已配置模型：${status.model}`
                    : '先填写下方服务器地址与访问令牌，再测试连接。'}
                </p>
                <div className="action-row">
                  <button
                    className="primary"
                    disabled={!!busy || !(draft.sessionToken || draft.token)}
                    onClick={testAI}
                  >
                    {busy === 'ai' ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <Wifi size={16} />
                    )}
                    测试服务器 AI
                  </button>
                  <button className="secondary" onClick={persist}>
                    保存调用方式
                  </button>
                </div>
                <p className="inline-hint">
                  测试读取模型列表，不生成解读。先完成下方服务器连接设置。
                </p>
              </>
            ) : (
              <>
                <label className="field-label" htmlFor="local-api-key">
                  DeepSeek API Key
                </label>
                <input
                  id="local-api-key"
                  className="standard-input"
                  type="password"
                  autoComplete="off"
                  value={draft.apiKey}
                  onChange={(e) => field('apiKey', e.target.value)}
                  placeholder="sk-… 只在当前设备使用"
                />
                <p className="field-help">
                  发送至 api.deepseek.com，不经过你的同步服务器，也不加入跨设备同步。
                </p>
                <label className="field-label" htmlFor="local-model">
                  模型名称
                </label>
                <input
                  id="local-model"
                  className="standard-input"
                  value={draft.model}
                  onChange={(e) => field('model', e.target.value)}
                  placeholder="deepseek-flash"
                  list="deepseek-models"
                />
                <datalist id="deepseek-models">
                  <option value="deepseek-flash" />
                  <option value="deepseek-v4-pro" />
                </datalist>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={draft.rememberKey}
                    onChange={(e) => field('rememberKey', e.target.checked)}
                  />
                  <span>
                    在此设备保存 API Key
                    <small>
                      默认仅在当前会话使用。勾选后保存到本机浏览器／应用存储，其他设备需分别填写。
                    </small>
                  </span>
                </label>
                <div className="action-row">
                  <button
                    className="primary"
                    disabled={!!busy || !draft.apiKey.trim()}
                    onClick={testAI}
                  >
                    {busy === 'ai' ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <Wifi size={16} />
                    )}
                    测试本机直连
                  </button>
                  <button className="secondary" onClick={persist}>
                    保存本机配置
                  </button>
                  <a
                    className="text-link"
                    href="https://platform.deepseek.com/api_keys"
                    target="_blank"
                    rel="noreferrer"
                  >
                    获取密钥
                    <ArrowUpRight size={13} />
                  </a>
                </div>
                <p className="inline-hint">
                  测试仅读取模型列表，不生成解读。无需同步服务器也能抽牌、解读和运行插件。
                </p>
              </>
            )}
          </section>
          <section className="surface">
            <div className="section-title">
              <Cloud size={21} />
              <h2>个人服务器</h2>
              <span className="tag">{status ? '已连接' : '可选'}</span>
            </div>
            <label className="field-label" htmlFor="server-url">
              同步服务器地址
            </label>
            <input
              id="server-url"
              type="url"
              className="standard-input"
              value={draft.url}
              onChange={(e) => field('url', e.target.value)}
              placeholder="https://astral.example.com"
            />
            <p className="field-help">
              网页版留空可连接本站；桌面、安卓填写 HTTPS 地址。SSH 隧道可填
              http://127.0.0.1:8789。服务器模式下也使用此地址请求 AI。
            </p>
            <p className="field-help">
              推荐先在左侧「我的账号」登录。账号按用户隔离手记、插件与 Pi
              对话，普通成员无需获得管理员令牌。
            </p>
            <details>
              <summary>旧版设备令牌连接</summary>
              <label className="field-label" htmlFor="server-token">
                管理员设备令牌（兼容旧版，可留空）
              </label>
              <input
                id="server-token"
                className="standard-input"
                type="password"
                autoComplete="off"
                value={draft.token}
                onChange={(e) => field('token', e.target.value)}
                placeholder="已登录账号无需填写；管理员可使用 APP_TOKEN"
              />
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={draft.remember}
                  onChange={(e) => field('remember', e.target.checked)}
                />
                <span>
                  在此设备记住管理员令牌
                  <small>用于数据同步和服务器 AI，与 DeepSeek API Key 相互独立。</small>
                </span>
              </label>
            </details>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={draft.autoSync}
                onChange={(e) => field('autoSync', e.target.checked)}
              />
              <span>
                自动同步占卜手记
                <small>
                  前台每 30 秒检查一次。同步包含问题、牌阵与已生成解读，不包含 API Key。
                </small>
              </span>
            </label>
            <div className="action-row">
              <button
                className="primary"
                disabled={!!busy || !(draft.sessionToken || draft.token)}
                onClick={connect}
              >
                {busy === 'sync' ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Cloud size={16} />
                )}
                测试并保存同步连接
              </button>
              <button className="secondary" onClick={persist}>
                保存设置
              </button>
            </div>
          </section>
        </div>
        <div>
          <section className="surface sync-card">
            <Cloud size={26} />
            <h2>记忆，跨过设备的边界</h2>
            <p>
              当前设备有 <b>{count}</b> 篇手记
            </p>
            <p>{lastSync ? `最近同步 ${lastSync}` : '尚未同步'}</p>
            <button
              className="secondary"
              disabled={syncing || !(settings.sessionToken || settings.token)}
              onClick={sync}
            >
              <RefreshCw className={syncing ? 'spin' : ''} size={16} />
              立即同步
            </button>
          </section>
          <section className="surface device-card">
            <h2>各自负责，连接自由</h2>
            <div>
              <span>当前设备</span>
              <b>抽牌、记录与模式选择</b>
            </div>
            <div>
              <span>DeepSeek</span>
              <b>{draft.aiMode === 'server' ? '由个人服务器请求' : '由设备直接请求'}</b>
            </div>
            <div>
              <span>个人服务器</span>
              <b>同步与可选 AI 服务</b>
            </div>
            <div>
              <span>社交功能</span>
              <b>联系人私聊与地图</b>
            </div>
            <p className="field-help">
              通过「我的账号」登录后，可在「联系人与地图」私聊或主动分享位置，也可使用 Pi 智能助手。
            </p>
          </section>
          <section className="surface">
            <div className="section-title">
              <Shield size={18} />
              <h2>密钥按模式保存</h2>
            </div>
            <p className="field-help">
              服务器模式的 Key 由服务器保管，不下发给设备。本机模式的 Key
              仅在当前设备使用，不加入同步。
            </p>
          </section>
        </div>
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="success">
          <Check size={16} />
          {success}
        </div>
      )}
      <section className="surface setup-guide">
        <h2>部署同步服务</h2>
        <ol>
          <li>
            运行 <code>npm run init</code>，在服务器生成 <code>APP_TOKEN</code>。
          </li>
          <li>部署服务并配置 HTTPS 或 SSH 隧道。服务器模式需在服务器配置 DeepSeek 密钥。</li>
          <li>
            各设备连接同一服务器并登录自己的账号；朋友使用管理员生成的邀请码注册。本机模式另外填写
            API Key。
          </li>
        </ol>
        <button
          className="text-link"
          onClick={() =>
            navigator.clipboard
              ?.writeText('npm ci\nnpm run init\nnpm run build\nnpm start')
              .then(() => notify('启动命令已复制。'))
              .catch(() => notify('请查看项目 README。'))
          }
        >
          <Copy size={14} />
          复制启动命令
        </button>
      </section>
    </>
  );
}
