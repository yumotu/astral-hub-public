export async function readSandboxNetwork({
  url = process.env.ASTRAL_SANDBOX_ACCESS_URL,
  token = process.env.ASTRAL_SANDBOX_ACCESS_TOKEN,
  fetchImpl = fetch,
} = {}) {
  if (!url && !token) return { enabled: false, version: 0, expiresAt: null };
  try {
    if (!url || !token) throw Error('missing scope');
    const response = await fetchImpl(url.replace(/\/$/, '') + '/network', {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    if (!response.ok) throw Error('invalid scope');
    const p = await response.json();
    if (
      typeof p.enabled !== 'boolean' ||
      !Number.isInteger(p.version) ||
      p.version < 0 ||
      (p.enabled && !Number.isFinite(p.expiresAt))
    )
      throw Error('invalid policy');
    return {
      enabled: p.enabled && p.expiresAt > Date.now(),
      version: p.version,
      expiresAt: p.expiresAt || null,
    };
  } catch {
    throw new Error('无法核验此对话的 Bash 联网授权，请检查连接后继续；命令不会自动重试。');
  }
}
