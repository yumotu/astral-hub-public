// Narrow native window actions. No renderer-selected window, path or JS command.
function createWindowControls(window, platform = process.platform) {
  let revision = 0,
    pending = false;
  const status = () => ({
    platform,
    fullScreen: !window.isDestroyed() && window.isFullScreen(),
    revision,
  });
  const changed = () => {
    revision++;
    if (!window.isDestroyed()) window.webContents.send('astral:window:changed', status());
  };
  for (const event of ['enter-full-screen', 'leave-full-screen']) window.on(event, changed);
  const dispose = () => {
    for (const event of ['enter-full-screen', 'leave-full-screen'])
      window.removeListener(event, changed);
  };
  window.once('closed', dispose);
  async function leave() {
    if (!window.isFullScreen()) return;
    await new Promise((resolve, reject) => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        window.removeListener('leave-full-screen', done);
        resolve();
      };
      window.once('leave-full-screen', done);
      timer = setTimeout(() => {
        window.removeListener('leave-full-screen', done);
        window.isFullScreen() ? reject(Error('窗口仍在全屏切换中，请稍后重试。')) : resolve();
      }, 5000);
      window.setFullScreen(false);
    });
  }
  return {
    status,
    async action(action) {
      if (platform !== 'darwin' || !['exit-fullscreen', 'minimize', 'close'].includes(action))
        throw Error('不支持此窗口操作。');
      if (window.isDestroyed() || pending) throw Error('窗口已关闭或正在切换。');
      pending = true;
      try {
        if (action === 'close') window.close();
        else {
          await leave();
          if (action === 'minimize' && !window.isDestroyed()) window.minimize();
        }
        return status();
      } finally {
        pending = false;
      }
    },
    dispose,
  };
}
function registerWindowControls(ipcMain, { current, trusted }) {
  ipcMain.handle('astral:window:status', (event) => (trusted(event) ? current()?.status() : null));
  ipcMain.handle('astral:window:action', (event, action) => {
    const controller = current();
    if (!trusted(event) || !controller) throw Error('窗口操作不可用。');
    return controller.action(action);
  });
}
module.exports = { createWindowControls, registerWindowControls };
