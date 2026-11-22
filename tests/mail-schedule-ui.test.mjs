import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('workbench reads account data instead of synthetic fixtures', async () => {
  const page = await readFile(new URL('../web/src/MailSchedulePage.tsx', import.meta.url), 'utf8');
  const main = await readFile(new URL('../web/src/main.tsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('../web/src/mail-schedule.css', import.meta.url), 'utf8');

  assert.match(page, /当前账号数据/);
  assert.match(page, /不会生成合成任务/);
  assert.match(page, /\/pi\/tasks/);
  assert.match(page, /\/pi\/conversations/);
  assert.match(page, /\/superagent\/tasks/);
  assert.match(page, /\/goals/);
  assert.match(page, /\/investment\/holdings/);
  assert.match(page, /\/investment\/dashboard/);
  assert.match(page, /\/investment\/schedules/);
  assert.match(page, /\/mail\/messages/);
  assert.match(page, /今日时间轴/);
  assert.match(page, /未来 7 天/);
  assert.match(page, /邮件事项/);
  assert.match(page, /对话中的任务/);
  assert.match(page, /长期任务/);
  assert.match(page, /定时任务/);
  assert.match(page, /资产提醒/);
  assert.doesNotMatch(page, /createSyntheticWorkbenchSnapshot/);
  assert.doesNotMatch(page, /DPH 仿真执行器/);
  assert.doesNotMatch(page, /P3 TOOL ROUTER/);
  assert.match(main, /<MailSchedulePage/);
  assert.match(main, /settings=\{settings\}/);
  assert.match(css, /\.mail-schedule-live-banner/);
  assert.match(css, /@media \(max-width: 800px\)/);
});
