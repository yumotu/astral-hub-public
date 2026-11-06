// A native schedule acknowledgement precedes Android's system-tray delivery.
// Observe the same notification briefly; never schedule it a second time.
export async function confirmNativeDelivery({
  read,
  id,
  active = () => true,
  timeout = 4000,
  now = Date.now,
  pause = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const deadline = now() + timeout;
  while (active()) {
    let timer, delivered;
    try {
      delivered = await Promise.race([
        read(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error('Android 通知送达确认超时，请检查通知权限。')),
            Math.max(1, deadline - now()),
          );
        }),
      ]);
    } catch (e) {
      if (!active()) return { mode: 'ignored' };
      throw e;
    } finally {
      clearTimeout(timer);
    }
    if (!active()) return { mode: 'ignored' };
    if (delivered.notifications?.some((n) => n.id === id)) return { mode: 'shown' };
    if (now() >= deadline)
      throw Error('Android 未保留这条通知。请检查星屿的通知类别、横幅权限和免打扰设置。');
    await pause(Math.min(100, Math.max(1, deadline - now())));
  }
  return { mode: 'ignored' };
}
