import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDshExtensionStore } from '../integrations/dsh-app-tools/extensions-core.mjs';
import { dshExtensionChange } from '../shared/dsh-extensions.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'astral-ext-')),
    cwd = join(root, 'workspace');
  await mkdir(cwd);
  const agent = { id: 'native-a', session: { header: { cwd } } },
    calls = [];
  let idle = true,
    rejected = false;
  const options = {
    root: join(root, 'private'),
    runtime: {
      parseSkill: () => ({ name: 'test-skill', description: 'Test' }),
      bundles: async () => [],
      inspect: async (spec) => {
        const i = spec.lastIndexOf('@');
        return {
          status: 'accepted',
          bundle: true,
          name: spec.slice(0, i),
          version: spec.slice(i + 1),
        };
      },
      inspectUpdate: async (name, spec) => ({
        status: 'accepted',
        bundle: true,
        name,
        version: spec.slice(spec.lastIndexOf('@') + 1),
      }),
      assertIdle: async () => {
        if (!idle) throw Error('busy');
      },
      refreshSkills: async () => {},
      mcpStatus: () => ({ state: 'connected', tools: 1 }),
      applyMcp: async (_cwd, next) => {
        calls.push(next);
        if (rejected) throw Error('secret-from-host');
      },
      install: async (spec) => {
        calls.push(spec);
        return { application: 'applied', version: spec.slice(spec.lastIndexOf('@') + 1) };
      },
      update: async (name, version) => {
        calls.push(name);
        return { result: { application: 'applied', version } };
      },
      enable: async () => ({ application: 'applied' }),
      remove: async () => ({ application: 'applied' }),
    },
  };
  const store = await createDshExtensionStore(options);
  t.after(() => store.close());
  const handle = (input, selected = agent) => store.handle(selected, input);
  const change = async (change) => {
    const preview = await handle({ action: 'prepare', id: randomUUID(), change });
    const id = randomUUID();
    return { preview, id, result: await handle({ action: 'commit', id, plan: preview.plan }) };
  };
  return {
    store,
    options,
    root,
    cwd,
    calls,
    agent,
    handle,
    change,
    busy: () => {
      idle = false;
    },
    reject: () => {
      rejected = true;
    },
  };
}
const skill = {
  kind: 'skill-save',
  name: 'test-skill',
  markdown: '---\nname: test-skill\ndescription: Test\n---\nActual instructions.',
};
test('DSH skills require a preview, use revisions and restore without overwriting unrelated skills', async (t) => {
  const f = await fixture(t),
    first = await f.change(skill);
  assert.equal(first.result.state, 'applied');
  const catalog = await f.handle({ action: 'catalog' }),
    s = catalog.skills[0];
  await assert.rejects(f.change(skill), /存在/);
  await assert.rejects(f.change({ ...skill, revision: '0'.repeat(64) }), /变化/);
  const off = await f.change({
    kind: 'skill-state',
    name: s.name,
    revision: s.revision,
    state: 'removed',
  });
  const restored = await f.change({
    kind: 'skill-state',
    name: s.name,
    revision: off.result.item.revision,
    state: 'enabled',
  });
  assert.equal(restored.result.item.state, 'enabled');
  assert.match((await f.handle({ action: 'read-skill', name: s.name })).markdown, /Actual/);
  await assert.rejects(
    f.handle({ action: 'commit', id: randomUUID(), plan: first.preview.plan }),
    /已执行/,
  );
});
test('skill content updates preserve resources unless explicitly replaced and previews remain idempotent', async (t) => {
  const f = await fixture(t),
    first = await f.change({
      ...skill,
      resources: [{ path: 'references/help.md', text: 'reference body' }],
    });
  const request = {
    action: 'prepare',
    id: randomUUID(),
    change: {
      ...skill,
      markdown: skill.markdown + '\nUpdated.',
      revision: first.result.item.revision,
    },
  };
  const p = await f.handle(request);
  assert.equal((await f.handle(request)).plan, p.plan);
  await f.handle({ action: 'commit', id: randomUUID(), plan: p.plan });
  const saved = await f.handle({ action: 'read-skill', name: skill.name });
  assert.deepEqual(saved.resources, [{ path: 'references/help.md', text: 'reference body' }]);
});
test('discarded previews cannot be applied; a changed skill invalidates an older unclaimed preview', async (t) => {
  const f = await fixture(t);
  const cancelled = await f.handle({ action: 'prepare', id: randomUUID(), change: skill });
  assert.equal((await f.handle({ action: 'discard', plan: cancelled.plan })).state, 'discarded');
  await assert.rejects(
    f.handle({ action: 'commit', id: randomUUID(), plan: cancelled.plan }),
    /过期/,
  );
  const saved = await f.change(skill);
  const pending = await f.handle({
    action: 'prepare',
    id: randomUUID(),
    change: {
      ...skill,
      markdown: skill.markdown + '\nOld preview',
      revision: saved.result.item.revision,
    },
  });
  await f.change({
    ...skill,
    markdown: skill.markdown + '\nNew edit',
    revision: saved.result.item.revision,
  });
  await assert.rejects(
    f.handle({ action: 'commit', id: randomUUID(), plan: pending.plan }),
    /更改/,
  );
});
test('disabled plugin updates remain disabled and linked resource files cannot be overwritten', async (t) => {
  const f = await fixture(t),
    installed = await f.change({ kind: 'plugin-install', spec: 'qa-plugin@1.0.0' });
  const off = await f.change({
    kind: 'plugin-state',
    name: 'qa-plugin',
    state: 'disabled',
    revision: installed.result.item.revision,
  });
  const updated = await f.change({
    kind: 'plugin-update',
    name: 'qa-plugin',
    spec: 'qa-plugin@1.1.0',
    revision: off.result.item.revision,
  });
  assert.equal(updated.result.item.state, 'disabled');
  await f.change({ ...skill, resources: [{ path: 'help.md', text: 'read me' }] });
  const s = f.store.snapshot(f.cwd).skills[skill.name];
  const dir = await f.store.resourceDirectory(f.cwd, s);
  assert.equal(await readFile(join(dir, 'help.md'), 'utf8'), 'read me');
  const sibling = { ...s, resources: [{ path: 'linked.md', text: 'replace' }] };
  const empty = await f.store.resourceDirectory(f.cwd, { ...sibling, resources: [] });
  await symlink(empty, join(f.cwd, '.astral-skill-resources', 'linked-skill'));
  await assert.rejects(
    f.store.resourceDirectory(f.cwd, { ...sibling, name: 'linked-skill' }),
    /链接/,
  );
});
test('MCP secrets never enter list, preview, errors or plaintext ledger; repeated commits do not reconnect', async (t) => {
  const f = await fixture(t),
    id = randomUUID(),
    plan = randomUUID(),
    input = {
      action: 'prepare',
      id: plan,
      change: {
        kind: 'mcp-save',
        name: 'test-mcp',
        config: {
          transport: 'streamable-http',
          url: 'https://example.test/mcp?key=private-url-key',
          headers: { Authorization: 'private-header' },
        },
      },
    };
  const preview = await f.handle(input);
  assert.ok(!JSON.stringify(preview).includes('private-'));
  const result = await f.handle({ action: 'commit', id, plan });
  assert.equal(result.state, 'applied');
  assert.equal((await f.handle({ action: 'commit', id, plan })).state, 'applied');
  assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(await f.handle({ action: 'catalog' })).includes('private-'));
  assert.ok(!(await readFile(join(f.root, 'private/state.enc'), 'utf8')).includes('private-'));
  const again = await createDshExtensionStore(f.options);
  assert.equal((await again.handle(f.agent, { action: 'catalog' })).mcps[0].name, 'test-mcp');
  await again.close();
});
test('extensions reject cross-workspace plans, busy tasks and linked workspaces', async (t) => {
  const f = await fixture(t),
    plan = await f.handle({ action: 'prepare', id: randomUUID(), change: skill });
  const other = join(f.root, 'other');
  await mkdir(other);
  await assert.rejects(
    f.handle(
      { action: 'commit', id: randomUUID(), plan: plan.plan },
      { session: { header: { cwd: other } } },
    ),
    /过期/,
  );
  f.busy();
  await assert.rejects(f.handle({ action: 'commit', id: randomUUID(), plan: plan.plan }), /busy/);
  const link = join(f.root, 'link');
  await symlink(f.cwd, link);
  await assert.rejects(
    f.handle({ action: 'catalog' }, { session: { header: { cwd: link } } }),
    /路径/,
  );
});
test('invalid package sources, resource traversal, floating versions and insecure MCP URLs are rejected', () => {
  for (const spec of [
    'test',
    'test@latest',
    'test@^1.2.3',
    '../test@1.2.3',
    'https://evil.test/a.tgz',
    'test@1.2.3;echo bad',
  ])
    assert.equal(dshExtensionChange.safeParse({ kind: 'plugin-install', spec }).success, false);
  assert.equal(
    dshExtensionChange.safeParse({ kind: 'plugin-install', spec: '@example/dsh-bundle@1.2.3' })
      .success,
    true,
  );
  for (const path of ['../private', '/absolute', '.env', 'a//b', 'a\\b', 'SKILL.md'])
    assert.equal(
      dshExtensionChange.safeParse({ ...skill, resources: [{ path, text: 'x' }] }).success,
      false,
    );
  assert.equal(
    dshExtensionChange.safeParse({
      kind: 'mcp-save',
      name: 'a',
      config: { transport: 'streamable-http', url: 'http://public.test/mcp' },
    }).success,
    false,
  );
});
test('native plugin install/update/state is scoped and does not claim failed MCP activation succeeded', async (t) => {
  const f = await fixture(t),
    first = await f.change({ kind: 'plugin-install', spec: 'example-dsh@1.0.0' });
  assert.equal(first.result.item.version, '1.0.0');
  const second = await f.change({
    kind: 'plugin-update',
    name: 'example-dsh',
    spec: 'example-dsh@1.1.0',
    revision: first.result.item.revision,
  });
  assert.equal(second.result.item.previousVersion, '1.0.0');
  f.reject();
  const p = await f.handle({
    action: 'prepare',
    id: randomUUID(),
    change: {
      kind: 'mcp-save',
      name: 'test-mcp',
      config: { transport: 'stdio', command: 'node', args: [] },
    },
  });
  const id = randomUUID();
  await assert.rejects(
    f.handle({ action: 'commit', id, plan: p.plan }),
    (e) => !e.message.includes('secret-from-host'),
  );
  assert.equal((await f.handle({ action: 'status', id })).state, 'unknown');
  assert.equal((await f.handle({ action: 'catalog' })).mcps.length, 0);
  assert.equal((await f.handle({ action: 'commit', id, plan: p.plan })).state, 'unknown');
  assert.equal(f.calls.length, 3);
});
