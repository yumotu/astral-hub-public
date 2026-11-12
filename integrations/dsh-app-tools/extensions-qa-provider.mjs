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
    if (value.startsWith('astral-tool:')) {
      const plan = JSON.parse(value.slice('astral-tool:'.length));
      if (results.length < plan.length) {
        const args = JSON.stringify(plan[results.length]),
          id = 'extension-qa-' + results.length + '-' + human.id;
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield {
          type: 'tool-call-delta',
          index: 0,
          id,
          name: 'app_functions',
          argumentsDelta: args,
        };
        yield {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id, name: 'app_functions', arguments: args },
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
