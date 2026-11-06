const { app, BrowserWindow, protocol, net, shell, ipcMain, Notification, dialog } = require('electron');
const { resolve, extname } = require('node:path');
const { pathToFileURL } = require('node:url');
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'astral',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);
let window;
let updater;
let computer;
for (const method of ['status', 'pair', 'start', 'stop', 'grant'])
  ipcMain.handle('astral:computer:' + method, (event, value) => {
    if (!trusted(event) || !computer) throw new Error('本机电脑连接不可用。');
    return computer[method](value);
  });
ipcMain.handle('astral:mail:open-link', async (event, value) => {
  const url = require('./mail-links.cjs').mailLink(value);
  if (!trusted(event) || !url) throw new Error('不支持此邮件链接。');
  await shell.openExternal(url);
  return { opened: true };
});
ipcMain.handle('astral:updates:status', (event) =>
  trusted(event) ? updater?.status() || { state: 'idle', received: 0, total: 0 } : null,
);
ipcMain.handle('astral:updates:platform', (event) =>
  trusted(event) ? `${process.platform === 'darwin' ? 'mac' : 'win'}-${process.arch}` : null,
);
ipcMain.handle('astral:updates:download', async (event, value) => {
  if (!trusted(event) || !app.isPackaged) throw new Error('请在已安装的星屿桌面应用中更新。');
  updater ||= require('./updates.cjs').createInstallerUpdater({
    directory: resolve(app.getPath('userData'), 'updates'),
    platform: `${process.platform === 'darwin' ? 'mac' : 'win'}-${process.arch}`,
    open: (path) => shell.openPath(path),
    progress: (value) => {
      if (window && !window.isDestroyed())
        window.webContents.send('astral:updates:progress', value);
    },
  });
  return updater.download(value);
});
ipcMain.handle('astral:updates:cancel', (event) => {
  if (trusted(event)) updater?.cancel();
});
ipcMain.handle('astral:updates:install', (event) => {
  if (!trusted(event) || !updater) throw new Error('请先下载更新。');
  return updater.install();
});
const shown = new Map();
function trusted(event) {
  return event.sender === window?.webContents && event.senderFrame?.url.startsWith('astral://app/');
}
app.setAppUserModelId('app.astral.hub');
ipcMain.handle(
  'astral:notifications:supported',
  (event) => trusted(event) && Notification.isSupported(),
);
ipcMain.handle('astral:notifications:show', async (event, value) => {
  if (!trusted(event)) throw new Error('Invalid sender');
  if (
    !value ||
    !/^[a-f0-9-]{36}$/.test(value.id || '') ||
    !/^[a-f0-9-]{36}$/.test(value.scope || '') ||
    typeof value.title !== 'string' ||
    value.title.length > 120 ||
    typeof value.body !== 'string' ||
    value.body.length > 1200
  )
    return { ok: false, error: '通知格式不正确。' };
  const key = value.scope + ':' + value.id;
  if (shown.has(key)) return { ok: true };
  if (!Notification.isSupported()) return { ok: false, error: '当前系统不支持桌面通知。' };
  return new Promise((resolve) => {
    const notification = new Notification({
      title: value.title,
      body: value.body,
      icon: resolve(__dirname, 'web/icon-192.png'),
    });
    shown.set(key, notification);
    if (shown.size > 200) shown.delete(shown.keys().next().value);
    const timer = setTimeout(
      () => resolve({ ok: false, error: '系统未确认展示通知，请检查权限和应用签名。' }),
      5000,
    );
    notification.once('show', () => {
      clearTimeout(timer);
      resolve({ ok: true });
    });
    notification.once('failed', () => {
      clearTimeout(timer);
      shown.delete(key);
      resolve({ ok: false, error: '系统通知失败，请检查权限和应用签名。' });
    });
    notification.on('click', () => {
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        window.webContents.send('astral:notification:click', {
          scope: value.scope,
          conversationId: value.conversationId,
          taskId: value.taskId,
        });
      }
    });
    notification.show();
  });
});
async function createWindow() {
  window = new BrowserWindow({
    width: 1380,
    height: 950,
    minWidth: 380,
    minHeight: 620,
    title: '星屿 · 你的灵感空间',
    icon: resolve(__dirname, 'web/icon-512.png'),
    backgroundColor: '#f7f8f4',
    webPreferences: {
      preload: resolve(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (
        target.protocol === 'https:' &&
        [
          'commons.wikimedia.org',
          'platform.deepseek.com',
          'api-docs.deepseek.com',
          'www.openstreetmap.org',
          'pi.dev',
        ].includes(target.hostname)
      )
        void shell.openExternal(url);
    } catch {}
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (e, url) => {
    const target = new URL(url);
    if (target.protocol !== 'astral:' || target.host !== 'app') e.preventDefault();
  });
  await window.loadURL('astral://app/');
}
app.whenReady().then(async () => {
  computer = require('./local-computer.cjs').createLocalComputer({
    directory: resolve(app.getPath('userData'), 'computer-agent'),
    bundle: app.isPackaged
      ? resolve(process.resourcesPath, 'computer-agent')
      : resolve(__dirname, 'runtime', process.arch),
    chooseDirectory: async () => {
      const result = await dialog.showOpenDialog(window, {
        title: '选择允许星屿访问的本机项目',
        properties: ['openDirectory'],
      });
      return result.canceled ? null : result.filePaths[0];
    },
  });
  await computer.restore().catch(() => {});
  const web = resolve(__dirname, 'web');
  protocol.handle('astral', async (request) => {
    const u = new URL(request.url);
    if (u.host !== 'app') return new Response('Forbidden', { status: 403 });
    let file;
    try {
      file = resolve(web, '.' + decodeURIComponent(u.pathname));
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    if (file !== web && !file.startsWith(web + require('node:path').sep))
      return new Response('Forbidden', { status: 403 });
    if (u.pathname === '/' || !extname(file)) file = resolve(web, 'index.html');
    const response = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(response.headers);
    if (extname(file) === '.mjs') headers.set('Content-Type', 'application/javascript');
    if (extname(file) === '.wasm') headers.set('Content-Type', 'application/wasm');
    headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    return new Response(response.body, { status: response.status, headers });
  });
  await createWindow();
  app.on('activate', () => {
    if (!BrowserWindow.getAllWindows().length) void createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting || !computer) return;
  event.preventDefault();
  quitting = true;
  void computer.close().finally(() => app.quit());
});
