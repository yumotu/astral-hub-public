// Deterministic native-model fixture. Never include in a production Profile.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

if (process.env.ASTRAL_DSH_EXTENSION_QA !== '1') throw Error('Isolated extension QA only');
export const name = 'astral-extension-qa-provider';
export const inject = ['llm'];
class Adapter extends LlmAdapter {
  async listModels(provider) {
    return [await this.resolveModel(provider, 'synthetic')];
  }
  async resolveModel(provider, id) {
    return {
      provider,
      id,
      name: id,
      contextWindow: 32000,
      reasoning: { defaultEffort: 'off', efforts: [{ id: 'off', name: 'off' }] },
    };
  }
  async *stream(options) {
    const human = options.messages.findLast((m) => m.role === 'user' && m.source?.kind === 'user');
    const value =
      human?.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join(' ') || '';
    const skills = options.messages.filter((m) => m.source?.kind === 'skill-invocation');
    if (skills.length)
      await writeFile(
        join(process.env.ASTRAL_QA_WORKSPACE, 'skill-proof.json'),
        JSON.stringify({
          names: skills.map((m) => m.source.name),
          hasBody: skills.some((m) =>
            m.content.some((b) => b.text?.includes('ASTRAL_IMPORTED_SKILL_BODY')),
          ),
        }),
      );
    const results = options.messages
      .slice(options.messages.indexOf(human) + 1)
      .filter((m) => m.role === 'tool');
    // The application wraps ordinary prompts with its shared reply conventions.
    // Keep this synthetic-only protocol inside the actual user-content section.
    const marker = '[本次用户内容]\n';
    const textInput = value.includes(marker)
      ? value.slice(value.indexOf(marker) + marker.length)
      : value;
    const native = textInput.startsWith('astral-native-tools:');
    if (native || textInput.startsWith('astral-tool:')) {
      const plan = JSON.parse(
        textInput.slice(native ? 'astral-native-tools:'.length : 'astral-tool:'.length),
      );
      if (
        native &&
        plan.some(
          (p) =>
            !['mcp__qa-mcp__echo', 'mcp__qa-http__http_echo', 'qa_plugin_echo'].includes(p.name),
        )
      )
        throw Error('Only deterministic fixture tools are allowed in native acceptance');
      if (results.length < plan.length) {
        const step = plan[results.length];
        const tool = native ? step.name : 'app_functions';
        const args = JSON.stringify(native ? step.args || {} : step),
          id = 'extension-qa-' + results.length + '-' + human.id;
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield {
          type: 'tool-call-delta',
          index: 0,
          id,
          name: tool,
          argumentsDelta: args,
        };
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id, name: tool, arguments: args },
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
        return;
      }
    }
    const text = results.length
      ? JSON.stringify(
          results.map((m) => ({
            isError: m.isError || false,
            text: m.content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join(''),
          })),
        )
      : 'Native extension skill verified.';
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
export function apply(ctx) {
  ctx.llm.registerAdapter(['synthetic'], new Adapter());
}
