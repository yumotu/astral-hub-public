import test from 'node:test';
import assert from 'node:assert/strict';
import { commandMenu, completeCommand } from '../web/src/pi-commands.ts';

const skills = [
  { name: 'review', description: '整理代码审查要点', enabled: true },
  { name: 'web-search', description: '搜索联网资料', enabled: true },
  { name: 'private', description: '停用技能', enabled: false },
];

test('skill picker accepts slash, space and native colon prefixes and searches descriptions', () => {
  for (const input of ['/skill', '/skill ', '/skill:']) {
    const menu = commandMenu(input, [], skills, false);
    assert.equal(menu.kind, 'skills');
    assert.deepEqual(
      menu.items.map((c) => c.name),
      ['skill:review', 'skill:web-search'],
    );
  }
  for (const input of ['/skill REV', '/skill:rev', '/skill 代码审查'])
    assert.deepEqual(
      commandMenu(input, [], skills, false).items.map((c) => c.name),
      ['skill:review'],
    );
  assert.deepEqual(commandMenu('/skill missing', [], skills, false).items, []);
  assert.equal(commandMenu('/skill missing', [], skills, false).kind, 'skills');
});

test('selection inserts native command without treating a completed task as a picker', () => {
  const selected = commandMenu('/skill', [], skills, true).items[0];
  assert.equal(completeCommand(selected), '/skill:review ');
  for (const input of ['/skill:review ', '/skill:review 请审查这个项目', '介绍 /skill', '/skills '])
    assert.equal(commandMenu(input, [], skills, true).kind, null);
  assert.equal(completeCommand({ name: 'skill' }), '/skill ');
  assert.equal(completeCommand({ name: 'skills' }), '/skills ');
});

test('root menu exposes management only to owner and ignores stale native skill entries', () => {
  const stale = [{ name: 'skill:private' }, { name: 'skills' }, { name: 'extension-tool' }];
  const member = commandMenu('/', stale, skills, false).items.map((c) => c.name);
  assert.ok(member.includes('skill'));
  assert.ok(member.includes('extension-tool'));
  assert.ok(!member.includes('skills'));
  assert.ok(!member.includes('skill:private'));
  assert.ok(commandMenu('/', stale, skills, true).items.some((c) => c.name === 'skills'));
  assert.match(commandMenu('/skills', [], [], true).items[0].description, /对话中/);
  assert.deepEqual(commandMenu('/skill', stale, [], true).items, []);
  assert.deepEqual(
    commandMenu(
      '/skill',
      stale,
      skills.map((s) => ({ ...s, enabled: false })),
      true,
    ).items,
    [],
  );
});

test('package skills show their source and preserve the native invocation syntax', () => {
  const menu = commandMenu(
    '/skill mermaid',
    [],
    [
      {
        name: 'mermaid',
        description: 'Draw diagrams',
        enabled: true,
        source: 'package',
        readOnly: true,
      },
    ],
    true,
  );
  assert.equal(menu.items.length, 1);
  assert.equal(menu.items[0].description, '插件技能 · Draw diagrams');
  assert.equal(completeCommand(menu.items[0]), '/skill:mermaid ');
});
