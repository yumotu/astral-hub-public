import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { completion, interpret } from '../../shared/ai.mjs';
import type { Settings, Reading, Plugin, Analysis } from './types';
import { api } from './data.ts';
import { readingSchema } from '../../shared/deck.mjs';
import { generateTarotQuestions, tarotQuestionResult } from '../../shared/tarot-questions.mjs';

// 本机模式：网页/桌面直接 fetch，安卓使用原生 HTTP；服务器模式只发送同步令牌。
export async function deviceFetch(url: string, options: RequestInit = {}): Promise<Response> {
  if (!Capacitor.isNativePlatform()) return fetch(url, options);
  const result = await CapacitorHttp.request({
    url,
    method: options.method || 'GET',
    headers: options.headers as Record<string, string>,
    ...(options.body ? { data: JSON.parse(options.body as string) } : {}),
    connectTimeout: 20000,
    readTimeout: 90000,
    disableRedirects: true,
    responseType: 'json',
  });
  return new Response(JSON.stringify(result.data), {
    status: result.status,
    headers: result.headers,
  });
}
function config(settings: Settings) {
  return {
    apiKey: settings.apiKey.trim(),
    model: settings.model.trim(),
    baseUrl: 'https://api.deepseek.com',
    fetch: deviceFetch,
  };
}
export async function interpretOnDevice(settings: Settings, reading: Reading): Promise<Reading> {
  const analysis = (await interpret(config(settings), reading)) as Analysis;
  return { ...reading, analysis, source: 'deepseek', model: settings.model.trim() };
}
export async function runPluginOnDevice(
  settings: Settings,
  plugin: Plugin,
  input: string,
): Promise<string> {
  return completion(config(settings), [
    { role: 'system', content: plugin.prompt },
    { role: 'user', content: input },
  ]);
}
export async function testLocalAI(settings: Settings): Promise<void> {
  if (!settings.apiKey.trim()) throw new Error('请先填写当前设备的 DeepSeek API Key。');
  const response = await deviceFetch('https://api.deepseek.com/models', {
    headers: { Authorization: `Bearer ${settings.apiKey.trim()}` },
    signal: AbortSignal.timeout(20000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? 'DeepSeek 密钥无效，请检查本机配置。'
        : '本机无法连接 DeepSeek，请检查网络或稍后重试。',
    );
  const result = await response.json();
  if (!Array.isArray(result.data)) throw new Error('DeepSeek 返回的模型列表格式不正确。');
}
export async function interpretReading(settings: Settings, reading: Reading): Promise<Reading> {
  if (settings.aiMode === 'local') return interpretOnDevice(settings, reading);
  return readingSchema.parse(await api(settings, '/tarot/interpret', reading)) as Reading;
}
export async function tarotQuestions(
  settings: Settings,
  previous: string[] = [],
): Promise<{ questions: string[] }> {
  if (settings.aiMode === 'local') return generateTarotQuestions(config(settings), { previous });
  return tarotQuestionResult.parse(await api(settings, '/tarot/questions', { previous }));
}
export async function runAIPlugin(
  settings: Settings,
  plugin: Plugin,
  input: string,
): Promise<string> {
  if (settings.aiMode === 'local') return runPluginOnDevice(settings, plugin, input);
  const result = await api<{ output: string }>(settings, '/plugins/run', { plugin, input });
  return result.output;
}
export async function testConfiguredAI(settings: Settings): Promise<void> {
  if (settings.aiMode === 'local') return testLocalAI(settings);
  await api(settings, '/ai/test', {});
}
