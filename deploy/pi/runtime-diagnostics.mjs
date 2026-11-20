import { redact } from './project-files.mjs';

export function cleanDiagnostic(value, env = process.env) {
  let text = String(value || '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  for (const [key, secret] of Object.entries(env))
    if (/(?:KEY|TOKEN|PASSWORD|SECRET|AUTHORIZATION)$/.test(key) && secret?.length >= 6)
      text = text.replaceAll(secret, '[凭据已隐藏]');
  return redact(text)
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [凭据已隐藏]')
    .replace(/((?:password|api[_-]?key|token|secret)\s*[=:]\s*)[^\s,"']+/gi, '$1[凭据已隐藏]')
    .replace(/:\/\/([^\s/@:]+):([^\s/@]+)@/g, '://[凭据已隐藏]@')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

export function runtimeDiagnostic(error, { stderr = '', exitCode, phase = 'run' } = {}) {
  const text = cleanDiagnostic(
    [error?.stack || error?.message || error, stderr].filter(Boolean).join('\n'),
  );
  const tools = [
    ...new Set([...text.matchAll(/Tool ["']([^"']+)["'] conflicts/g)].map((m) => m[1])),
  ];
  let code = 'execution_failed',
    message = 'Pi 执行失败，请展开错误详情。';
  if (/stopReason: length|模型达到单次输出上限/.test(text)) {
    code = 'output_limit';
    message = '模型达到单次输出上限，回复被截断；可继续对话或降低思考强度。';
  } else if (tools.length) {
    code = 'extension_conflict';
    message = `Pi 插件工具重复：${tools.join('、').slice(0, 250)}。`;
  } else if (
    /Failed to load extension|Error loading extension|Extension.*(?:error|failed)|SyntaxError|Cannot find (?:module|package)/i.test(
      text,
    )
  ) {
    code = 'extension_load_failed';
    message = 'Pi 插件加载失败，请展开错误详情。';
  } else if (/timed?\s*out|timeout|超时/i.test(text)) {
    code = 'runtime_timeout';
    message = 'Pi 响应超时，请展开错误详情。';
  } else if (phase === 'startup') {
    code = 'startup_failed';
    message = 'Pi 启动失败，请展开错误详情。';
  }
  // Keep the useful first error and final exit context even for a noisy plugin.
  const details =
    text.length > 12000 ? text.slice(0, 6000) + '\n[中间日志已截断]\n' + text.slice(-5950) : text;
  return { code, message, details, phase, ...(Number.isInteger(exitCode) ? { exitCode } : {}) };
}
