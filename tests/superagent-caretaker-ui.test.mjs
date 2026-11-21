import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('SuperAgent caretaker is the top-level assistant entry with unified workbench links', async () => {
  const main = await readFile(new URL('../web/src/main.tsx', import.meta.url), 'utf8');
  const component = await readFile(new URL('../web/src/SuperAgentCaretaker.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../web/src/superagent-caretaker.css', import.meta.url), 'utf8');

  assert.match(main, /<SuperAgentCaretaker connected=\{!!status\}/);
  assert.match(component, /SuperAgent 智能体助手管家/);
  assert.match(component, /仅委派执行/);
  assert.match(component, /subagent/);
  assert.doesNotMatch(component, /ziagent/);
  assert.match(component, /Leader/);
  assert.match(component, /Activity/);
  assert.match(component, /\/superagent\/tasks/);
  assert.match(component, /settings: Settings/);
  assert.match(component, /进行中/);
  assert.match(component, /待决定/);
  assert.match(component, /已完成/);
  assert.match(component, /工作台/);
  assert.match(component, /onNavigate\('workspace'\)/);
  assert.doesNotMatch(component, /直接对话/);
  assert.match(component, /astral\.superagent\.caretaker/);
  assert.match(css, /\.superagent-caretaker-panel/);
  assert.match(css, /\.superagent-caretaker-messages/);
  assert.match(css, /\.superagent-caretaker-activities/);
  assert.match(css, /position: fixed/);
  assert.match(component, /关闭 SuperAgent 对话窗口/);
});
