import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('SuperAgent caretaker is a persistent conversational leader for subagent tasks', async () => {
  const main = await readFile(new URL('../web/src/main.tsx', import.meta.url), 'utf8');
  const component = await readFile(new URL('../web/src/SuperAgentCaretaker.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../web/src/superagent-caretaker.css', import.meta.url), 'utf8');

  assert.match(main, /<SuperAgentCaretaker connected=\{!!status\}/);
  assert.match(main, /page === 'superagent'/);
  assert.match(component, /SuperAgent 智能体助手管家/);
  assert.match(component, /智能管家/);
  assert.match(component, /subagent/);
  assert.match(component, /Leader 不直接执行/);
  assert.match(component, /\/superagent\/tasks/);
  assert.match(component, /astral\.superagent\.chat/);
  assert.match(component, /任务状态会在这里持续更新/);
  assert.match(component, /打开工作台/);
  assert.match(component, /data-conversation-swipe/);
  assert.doesNotMatch(component, /ziagent/);
  assert.doesNotMatch(component, /Activity/);
  assert.match(css, /\.superagent-chat-bubble/);
  assert.match(css, /\.superagent-chat-row/);
  assert.match(css, /\.superagent-chat-header/);
  assert.match(css, /\.is-page-panel/);
  assert.match(css, /\.superagent-caretaker-trigger \{[\s\S]*box-shadow: none;/);
  assert.match(css, /\.sidebar > \.superagent-caretaker \{[\s\S]*margin-top: 22px;/);
});
