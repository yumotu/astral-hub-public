import { runtimeDiagnostic } from './runtime-diagnostics.mjs';

// RpcClient.start() only spawns the CLI and waits 100 ms. Native extension
// loading continues after it returns; a successful RPC is the readiness gate.
export async function startRpcSession(
  client,
  { canFallback = false, initialError, fallback, onWarning } = {},
) {
  async function ready(current) {
    await current.start();
    await current.getState();
    const d = runtimeDiagnostic(null, { stderr: current.getStderr(), phase: 'startup' });
    if (['extension_conflict', 'extension_load_failed'].includes(d.code))
      throw new Error(d.details);
  }
  try {
    if (initialError) throw initialError;
    await ready(client);
    return client;
  } catch (e) {
    const d = runtimeDiagnostic(e, { stderr: client.getStderr(), phase: 'startup' });
    if (
      !canFallback ||
      ![
        'extension_conflict',
        'extension_load_failed',
        'runtime_timeout',
        'startup_failed',
      ].includes(d.code)
    )
      throw e;
    await client.stop();
    const replacement = fallback();
    try {
      await ready(replacement);
    } catch (error) {
      throw new Error(d.details + '\n内置工具启动也失败：' + error.message);
    }
    onWarning?.({ ...d, message: '插件启动失败，本轮已回退到内置工具；现有对话上下文保留。' });
    return replacement;
  }
}
