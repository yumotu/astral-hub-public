import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDocument } from 'yaml';
import * as Mcp from '@deepseek-ai/dsh-mcp-client';
import { createScope } from '@deepseek-ai/dsh-scope';
import { createDshExtensionStore } from './extensions-core.mjs';

export const name = 'astral-extensions';
export const inject = [
  'commands',
  'agents',
  'skills',
  'tools',
  'mcpResources',
  'pluginManager',
  'profileContext',
  'loader',
];

// Human-only command; its input (including MCP secrets) is never logged.
export async function apply(ctx, config) {
  const mounted = new Map(),
    providers = new WeakSet(),
    invalidate = new Map(),
    scopes = new Map();
  let store;
  let maintenance = null;
  const cwdOf = (agent) => agent.session.header.cwd;
  const agentsAt = (cwd) => ctx.agents.list().filter((a) => cwdOf(a) === cwd);
  function context(agent) {
    if (!scopes.has(agent)) scopes.set(agent, createScope(ctx, agent));
    return scopes.get(agent).ctx;
  }
  async function mount(agent, item) {
    const key = JSON.stringify([agent.id, item.name]),
      prior = mounted.get(key);
    if (prior?.generation === item.generation) return;
    await prior?.fiber.dispose();
    mounted.delete(key);
    if (item.state !== 'enabled') return;
    try {
      const fiber = context(agent).plugin(Mcp, {
        ...item.config,
        serverName: item.name,
        ...(item.config.transport === 'stdio' ? { cwd: cwdOf(agent) } : {}),
        toolCallTimeoutMs: 60000,
        failOnStartupError: true,
        reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 30000, maxAttempts: 5 },
      });
      try {
        await fiber.await();
      } catch (e) {
        await fiber.dispose();
        throw e;
      }
      mounted.set(key, { fiber, generation: item.generation, item });
    } catch (e) {
      if (prior)
        try {
          await mount(agent, prior.item);
        } catch {
          /* unavailable in catalog */
        }
      throw e;
    }
  }
  async function attach(agent) {
    const cwd = cwdOf(agent);
    if (!cwd) return;
    if (!providers.has(agent)) {
      providers.add(agent);
      context(agent).skills.registerProvider((control) => {
        invalidate.set(agent, control.invalidate);
        return {
          name: 'astral-managed',
          async list() {
            return Object.values(store.snapshot(cwd).skills)
              .filter((s) => s.state === 'enabled')
              .map((s) => ({
                name: s.name,
                description: s.description,
                invocation: s.invocation,
                source: 'astral-managed',
                provider: 'astral-managed',
                rank: 150,
                locator: s.name,
              }));
          },
          async get(candidate) {
            const s = store.snapshot(cwd).skills[candidate.name];
            if (!s || s.state !== 'enabled') return;
            return {
              name: s.name,
              description: s.description,
              content: s.content,
              invocation: s.invocation,
              source: 'astral-managed',
              provider: 'astral-managed',
              resourceBase: { kind: 'directory', path: await store.resourceDirectory(cwd, s) },
            };
          },
        };
      });
    }
    for (const item of Object.values(store.snapshot(cwd).mcps))
      try {
        if (maintenance && (maintenance.profile || maintenance.cwd === cwd)) continue;
        await mount(agent, item);
      } catch {
        /* MCP cannot prevent reading history */
      }
  }
  const manager = ctx.pluginManager;
  async function validateBundle(name) {
    const bundles = await manager.listBundles(),
      bundle = bundles.find((b) => b.name === name);
    const ownRows = bundle?.rows || [],
      foreignRows = new Set(
        bundles
          .filter((b) => b.name !== name && b.enabled)
          .flatMap((b) => b.rows.map((r) => r.rowId)),
      );
    if (
      !bundle ||
      !ownRows.length ||
      bundle.overrides.length ||
      ownRows.some(
        (r) =>
          foreignRows.has(r.rowId) ||
          ['astral-app-tools', 'astral-extensions', 'plugin-manager', 'hmr'].includes(r.rowId),
      )
    )
      throw Error('Bundle overrides protected runtime configuration');
  }
  async function checkBundleLoaded(name) {
    const bundle = (await manager.listBundles()).find((b) => b.name === name);
    if (!bundle?.enabled || !bundle.rows.length) throw Error('Bundle is not enabled');
    for (const row of bundle.rows) {
      const entry = [...ctx.loader.entries()].find((e) => e.options.id === row.rowId);
      if (!entry?.fiber) throw Error('Bundle entry did not start');
      await entry.fiber.await();
      // Waiting for startup alone also resolves when an injection is missing.
      if (entry.fiber.state !== 2) throw Error('Bundle entry is not active');
    }
  }
  async function installSafe(spec, id, signal, enabled = true) {
    const cancel = () => void manager.cancelInstall(id);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const result = await manager.installBundle(spec, {
        enabled: false,
        saveExact: true,
        requestId: id,
      });
      if (['applied', 'restart-required'].includes(result.application) && result.bundle) {
        try {
          await validateBundle(result.bundle);
          signal?.throwIfAborted();
          if (!enabled) return result;
          const applied = await manager.setBundleEnabled(result.bundle, true);
          if (applied.application === 'applied') await checkBundleLoaded(result.bundle);
          if (['applied', 'restart-required'].includes(applied.application))
            return { ...result, ...applied, version: result.version };
        } catch {
          /* remove unactivated or failed candidate below */
        }
      }
      if (result.bundle) {
        const rollback = await manager.removeBundle(result.bundle);
        if (!['applied', 'restart-required'].includes(rollback.application))
          throw Error('Installation rollback needs inspection');
        return { ...result, application: 'failed', restored: true };
      }
      return result;
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  }
  store = await createDshExtensionStore({
    root: config.root
      ? resolve(config.root, 'astral-extensions')
      : resolve(ctx.profileContext.dir, '.astral-extensions'),
    runtime: {
      parseSkill(header) {
        const doc = parseDocument(header, { uniqueKeys: true });
        if (doc.errors.length) throw Error('Invalid SKILL.md');
        const value = doc.toJS({ maxAliasCount: 0 });
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw Error('Invalid SKILL.md');
        return value;
      },
      async skillExists(cwd, name) {
        const agent = agentsAt(cwd)[0];
        return (await ctx.skills.list({ cwd, scope: agent })).some((s) => s.name === name);
      },
      bundles: () => manager.listBundles(),
      inspect: (spec, signal) => manager.inspect(spec, undefined, signal),
      async inspectUpdate(name, spec, signal) {
        const version = spec.slice(spec.lastIndexOf('@') + 1);
        const available = await manager.listVersions(name, undefined, signal);
        const entry =
          available.status === 'listed' && available.versions.find((v) => v.version === version);
        return entry?.bundle && !entry.incompatible
          ? { status: 'accepted', bundle: true, name, version }
          : { status: 'refused' };
      },
      async assertIdle(cwd, profile) {
        if (ctx.agents.list().some((a) => (profile || cwdOf(a) === cwd) && a.status !== 'idle'))
          throw Object.assign(Error('请等待任务结束后再应用扩展，安装不会停止当前任务。'), {
            status: 409,
          });
      },
      async withIdle(cwd, profile, run) {
        maintenance = { cwd, profile };
        try {
          const agents = ctx.agents.list().filter((a) => profile || cwdOf(a) === cwd);
          const hold = (index) =>
            index === agents.length ? run() : agents[index].runMaintenance(() => hold(index + 1));
          return await hold(0);
        } finally {
          maintenance = null;
        }
      },
      async refreshSkills(cwd) {
        for (const agent of agentsAt(cwd)) {
          await attach(agent);
          invalidate.get(agent)?.();
        }
        ctx.emit('skills/change');
      },
      async mcpStatus(agent, name) {
        const v = mounted.get(JSON.stringify([agent.id, name]));
        const tools = ctx.tools
          .definitions(agent)
          .filter((d) => d.name.startsWith(`mcp__${name}__`)).length;
        if (!v) return { state: 'disconnected', tools: 0 };
        try {
          // Native resource discovery checks the current connection generation;
          // a registered tool alone may survive a temporary disconnect.
          await ctx.mcpResources.request(
            name,
            { method: 'resources/list' },
            {
              agent,
              signal: AbortSignal.timeout(3000),
            },
          );
          return { state: 'connected', tools };
        } catch {
          return { state: 'unavailable', tools };
        }
      },
      async applyMcp(cwd, next, current, signal) {
        const changed = [];
        try {
          for (const agent of agentsAt(cwd)) {
            signal?.throwIfAborted();
            await mount(agent, next);
            changed.push(agent);
            signal?.throwIfAborted();
          }
        } catch (e) {
          for (const agent of changed)
            try {
              await mount(agent, current || { ...next, state: 'disabled', generation: 'rollback' });
            } catch {
              /* unknown */
            }
          throw e;
        }
      },
      install: installSafe,
      async update(name, version, id, signal) {
        const before = (await manager.listBundles()).find((b) => b.name === name);
        if (!before?.installed || !before.version) throw Error('Missing previous bundle');
        signal?.throwIfAborted();
        const removed = await manager.removeBundle(name);
        if (!['applied', 'restart-required'].includes(removed.application)) return removed;
        try {
          const result = await installSafe(`${name}@${version}`, id, signal, before.enabled);
          if (['applied', 'restart-required'].includes(result.application)) return result;
          const restore = await installSafe(
            `${name}@${before.version}`,
            randomUUID(),
            undefined,
            before.enabled,
          );
          return {
            result,
            restore,
            restored: ['applied', 'restart-required'].includes(restore.application),
          };
        } catch {
          const restore = await installSafe(
            `${name}@${before.version}`,
            randomUUID(),
            undefined,
            before.enabled,
          );
          return {
            result: { application: 'failed' },
            restore,
            restored: ['applied', 'restart-required'].includes(restore.application),
          };
        }
      },
      async enable(name, enabled) {
        if (enabled) await validateBundle(name);
        const result = await manager.setBundleEnabled(name, enabled);
        if (enabled && result.application === 'applied') {
          try {
            await checkBundleLoaded(name);
          } catch {
            const rollback = await manager.setBundleEnabled(name, false);
            if (!['applied', 'restart-required'].includes(rollback.application))
              throw Error('Enable rollback needs inspection');
            return { application: 'failed', restored: true };
          }
        }
        return result;
      },
      remove: (name) => manager.removeBundle(name),
    },
  });
  ctx.commands.register({
    name: 'astral-extensions',
    description: '星屿管理当前工作区的扩展，仅供已鉴权的人类客户端使用。',
    recordInput: false,
    async handler({ agent, rawInput, signal }) {
      try {
        if (Buffer.byteLength(rawInput) > 800000) throw Error('Too large');
        await attach(agent);
        return {
          kind: 'success',
          text: JSON.stringify(await store.handle(agent, JSON.parse(rawInput), signal)),
        };
      } catch (e) {
        return {
          kind: 'error',
          text: JSON.stringify({
            error: e.status ? e.message : '扩展操作未完成，请刷新目录或核对原操作。',
            status: e.status || 409,
          }),
        };
      }
    },
  });
  ctx.on('agent/created', async ({ agent }) => {
    if (maintenance && (maintenance.profile || maintenance.cwd === cwdOf(agent)))
      throw Object.assign(Error('主机正在应用扩展，请稍后再打开新对话。'), { status: 409 });
    await attach(agent);
  });
  ctx.on('agent/disposed', ({ agent }) => {
    invalidate.delete(agent);
    void scopes.get(agent)?.dispose();
    scopes.delete(agent);
    for (const [key] of mounted) if (JSON.parse(key)[0] === agent.id) mounted.delete(key);
  });
  ctx.on('dispose', () => store.close());
  for (const agent of ctx.agents.list()) await attach(agent);
}
