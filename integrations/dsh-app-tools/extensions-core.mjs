import { mkdir, readFile, writeFile, rename, lstat } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { randomUUID, createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { dshExtensionRequest, dshExtensionLabels } from '../../shared/dsh-extensions.mjs';

const fail = (status, message) => Object.assign(Error(message), { status });
const digest = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const versioned = (v) => ({ ...v, revision: digest(v) });
const genericError = '扩展操作未完成，请查看实际目录和原操作状态；不会自动重试。';
const goodApplication = new Set(['applied', 'restart-required']);

// A host-private encrypted ledger. It contains no server credential, and its
// public projection never includes environment values, headers or raw errors.
export async function createDshExtensionStore({ root, runtime, now = Date.now }) {
  root = resolve(root);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) throw fail(403, '扩展存储不能使用链接。');
  const keyPath = join(root, 'key'),
    file = join(root, 'state.enc');
  try {
    await writeFile(keyPath, randomBytes(32), { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  if ((await lstat(keyPath)).isSymbolicLink()) throw fail(403, '扩展密钥不能使用链接。');
  const key = await readFile(keyPath);
  if (key.length !== 32) throw Error('Invalid extension ledger key');
  let data = { version: 1, scopes: {}, plans: {}, operations: {} };
  try {
    if ((await lstat(file)).isSymbolicLink()) throw Error('Invalid extension ledger');
    const packed = JSON.parse(await readFile(file, 'utf8')),
      decrypt = createDecipheriv('aes-256-gcm', key, Buffer.from(packed.iv, 'base64'));
    decrypt.setAAD(Buffer.from('astral-dsh-extensions-v1'));
    decrypt.setAuthTag(Buffer.from(packed.tag, 'base64'));
    data = JSON.parse(
      Buffer.concat([decrypt.update(Buffer.from(packed.body, 'base64')), decrypt.final()]),
    );
    if (data.version !== 1 || !data.scopes || !data.plans || !data.operations)
      throw Error('Invalid extension ledger');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  for (const op of Object.values(data.operations)) if (op.state === 'running') op.state = 'unknown';
  let tail = Promise.resolve();
  async function save() {
    // Bound terminal journals while retaining unknown outcomes for inspection.
    const settled = Object.entries(data.operations).filter(
      ([, op]) => !['unknown', 'running'].includes(op.state),
    );
    if (settled.length > 2000)
      for (const [id] of settled.slice(0, settled.length - 2000)) delete data.operations[id];
    const iv = randomBytes(12),
      encrypt = createCipheriv('aes-256-gcm', key, iv);
    encrypt.setAAD(Buffer.from('astral-dsh-extensions-v1'));
    const body = Buffer.concat([encrypt.update(JSON.stringify(data)), encrypt.final()]),
      temp = join(root, 'state-' + randomUUID() + '.tmp');
    await writeFile(
      temp,
      JSON.stringify({
        iv: iv.toString('base64'),
        tag: encrypt.getAuthTag().toString('base64'),
        body: body.toString('base64'),
      }),
      { flag: 'wx', mode: 0o600 },
    );
    await rename(temp, file);
  }
  function scope(cwd) {
    return data.scopes[digest(cwd)] || { cwd, skills: {}, mcps: {}, plugins: {} };
  }
  function publicSkill(s) {
    return versioned({
      name: s.name,
      description: s.description,
      state: s.state,
      markdown: s.markdown,
      resources: s.resources,
    });
  }
  function publicMcp(s) {
    const c = s.config;
    return versioned({
      name: s.name,
      state: s.state,
      transport: c.transport,
      ...(c.transport === 'stdio'
        ? { command: c.command, args: c.args, envKeys: Object.keys(c.env) }
        : {
            url: (() => {
              const u = new URL(c.url);
              u.search = '';
              return u.href;
            })(),
            headerKeys: Object.keys(c.headers),
          }),
      generation: s.generation,
    });
  }
  function publicPlugin(s) {
    return versioned(s);
  }
  const view = (kind, s) =>
    kind === 'skill' ? publicSkill(s) : kind === 'mcp' ? publicMcp(s) : publicPlugin(s);
  async function canonical(cwd) {
    const path = resolve(cwd);
    const stat = await lstat(path);
    if (path !== cwd || stat.isSymbolicLink() || !stat.isDirectory())
      throw fail(403, '工作区实际路径不符，请重新关联主机。');
    return path;
  }
  function parseSkill(p) {
    const match = p.markdown.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
    if (!match || !match[2].trim()) throw fail(400, '请提供含名称、用途和正文的标准 SKILL.md。');
    // JSON is a YAML subset. The runtime's native YAML parser owns the full grammar.
    const meta = runtime.parseSkill(match[1]);
    if (
      meta.name !== p.name ||
      typeof meta.description !== 'string' ||
      !meta.description.trim() ||
      meta.description.length > 1024
    )
      throw fail(400, 'SKILL.md 的 name、description 与技能名称不匹配。');
    const seen = new Set();
    for (const resource of p.resources) {
      if (seen.has(resource.path.toLowerCase())) throw fail(400, '技能资源路径重复。');
      seen.add(resource.path.toLowerCase());
    }
    if (
      p.resources.reduce((n, r) => n + Buffer.byteLength(r.text), Buffer.byteLength(p.markdown)) >
      512 * 1024
    )
      throw fail(413, '技能及附带资源合计最多512 KiB。');
    return {
      description: meta.description.trim(),
      content: match[2].trim(),
      invocation: {
        modelInvocable: meta['disable-model-invocation'] !== true,
        userInvocable: meta['user-invocable'] !== false,
      },
    };
  }
  async function plan(cwd, request, signal) {
    const old = data.plans[request.id];
    if (old) {
      if (old.discarded) throw fail(409, '预览已取消。');
      if (old.cwd !== cwd || old.signature !== digest(request.change))
        throw fail(409, '操作编号已绑定其他内容。');
      return old.public;
    }
    const originalSignature = digest(request.change);
    const change = structuredClone(request.change),
      state = scope(cwd),
      [kind] = change.kind.split('-'),
      collection = state[kind === 'skill' ? 'skills' : kind === 'mcp' ? 'mcps' : 'plugins'],
      current = collection[change.name];
    if (!current && Object.keys(collection).length >= 50)
      throw fail(429, '每个工作区每类最多保存50个扩展，请先整理已有扩展。');
    if (change.revision ? !current || view(kind, current).revision !== change.revision : current)
      throw fail(
        409,
        current ? '扩展已存在或内容有变化，请刷新后再修改。' : '扩展不存在，请刷新后重试。',
      );
    let detail;
    if (kind === 'skill' && change.kind === 'skill-save') {
      if (!current && (await runtime.skillExists?.(cwd, change.name)))
        throw fail(409, '主机已有同名技能，请使用其他名称；不会覆盖原技能。');
      change.resources ??= current?.resources || [];
      detail = parseSkill(change);
      if (collection[change.name]?.state === 'removed') throw fail(409, '请先恢复已移除技能。');
    }
    if (kind === 'plugin') {
      if (['plugin-install', 'plugin-update'].includes(change.kind)) {
        const inspected =
          change.kind === 'plugin-update'
            ? await runtime.inspectUpdate(change.name, change.spec, signal)
            : await runtime.inspect(change.spec, signal);
        if (
          inspected.status !== 'accepted' ||
          !inspected.bundle ||
          !inspected.name ||
          !inspected.version ||
          `${inspected.name}@${inspected.version}` !== change.spec
        )
          throw fail(409, '该固定版本不是可安装的 DSH 原生 bundle，或版本无法核验。');
        if (change.kind === 'plugin-update' && inspected.name !== change.name)
          throw fail(400, '更新必须使用同一个插件包名。');
        if (
          change.kind === 'plugin-install' &&
          (await runtime.bundles()).some(
            (b) => b.name === inspected.name && b.availability !== 'missing',
          )
        )
          throw fail(409, '主机已有该插件，管理入口不会接管或覆盖原配置。');
        detail = {
          name: inspected.name,
          version: inspected.version,
          description: inspected.description?.slice(0, 1000) || '',
        };
        if (change.kind === 'plugin-install' && collection[detail.name])
          throw fail(409, '此插件已有管理记录，请选择恢复或更新版本。');
      } else if (!current) throw fail(403, '内置或其他工作区的插件不能在这里移除。');
      else if (current.state === 'removed' && change.state === 'enabled') {
        const inspected = await runtime.inspect(`${current.name}@${current.version}`, signal);
        if (
          inspected.status !== 'accepted' ||
          !inspected.bundle ||
          inspected.name !== current.name ||
          inspected.version !== current.version
        )
          throw fail(409, '原版本无法重新核验，暂时不能恢复。');
      }
    }
    const publicPreview = {
      plan: request.id,
      title: dshExtensionLabels[change.kind],
      kind: change.kind,
      target: change.name || detail?.name || change.spec,
      expiresAt: now() + 5 * 60000,
      ...(detail
        ? { detail: kind === 'skill' ? { description: detail.description } : detail }
        : {}),
      ...(kind === 'skill' && change.kind === 'skill-save'
        ? { markdown: change.markdown, resourceNames: change.resources.map((r) => r.path) }
        : {}),
      ...(kind === 'mcp' && change.config
        ? {
            configuration: publicMcp({
              name: change.name,
              state: 'enabled',
              generation: 'preview',
              config: change.config,
            }),
          }
        : {}),
      ...(change.state ? { state: change.state } : {}),
      scope: kind === 'plugin' ? '此主机 DSH Profile；其他会话也可能使用此插件' : '当前工作区',
      notice:
        kind === 'mcp'
          ? '连接会把工具请求及相关内容交给此 MCP；凭据只保存在目标主机。'
          : kind === 'plugin'
            ? '原生插件在主机进程执行；保留原版本恢复，原生回执可能要求稍后重启。'
            : '按版本校验保存，移除后仍可恢复。',
    };
    for (const [id, p] of Object.entries(data.plans))
      if (p.public.expiresAt < now()) delete data.plans[id];
    if (Object.keys(data.plans).length >= 100) throw fail(429, '待确认扩展较多，请稍后再试。');
    data.plans[request.id] = {
      cwd,
      signature: originalSignature,
      change,
      detail,
      public: publicPreview,
    };
    await save();
    return publicPreview;
  }
  async function commit(cwd, request, signal) {
    const old = data.operations[request.id];
    if (old) {
      if (old.cwd !== cwd || old.plan !== request.plan) throw fail(409, '操作编号已绑定其他内容。');
      return old.public || { id: request.id, state: old.state };
    }
    const p = data.plans[request.plan];
    if (!p || p.cwd !== cwd || p.discarded || p.public.expiresAt <= now())
      throw fail(409, '预览已过期，请重新查看。');
    if (p.claimed) throw fail(409, '预览已执行，请核对原操作结果。');
    if (Object.keys(data.operations).length >= 5000)
      throw fail(429, '扩展操作记录较多，请先核对未知结果。');
    signal?.throwIfAborted();
    await runtime.assertIdle(cwd, p.change.kind.startsWith('plugin'));
    const state = scope(cwd),
      c = p.change,
      kind = c.kind.split('-')[0],
      collection = state[kind === 'skill' ? 'skills' : kind === 'mcp' ? 'mcps' : 'plugins'],
      current = collection[c.name];
    if (c.revision ? !current || view(kind, current).revision !== c.revision : current)
      throw fail(409, '扩展已被其他操作更改，请重新预览。');
    p.claimed = request.id;
    const op = (data.operations[request.id] = { cwd, plan: request.plan, state: 'running' });
    await save();
    let result;
    try {
      signal?.throwIfAborted();
      if (kind === 'skill') {
        collection[c.name] =
          c.kind === 'skill-save'
            ? {
                name: c.name,
                markdown: c.markdown,
                resources: c.resources,
                ...p.detail,
                state: 'enabled',
              }
            : { ...current, state: c.state };
        data.scopes[digest(cwd)] = state;
        await save();
        await runtime.refreshSkills(cwd);
        result = { state: 'applied', item: publicSkill(collection[c.name]) };
      } else if (kind === 'mcp') {
        const next =
          c.kind === 'mcp-save'
            ? { name: c.name, config: c.config, state: 'enabled', generation: randomUUID() }
            : { ...current, state: c.state, generation: randomUUID() };
        // Connect new configuration before replacing/removing the old generation.
        await runtime.applyMcp(cwd, next, current, signal);
        collection[c.name] = next;
        data.scopes[digest(cwd)] = state;
        await save();
        result = { state: 'applied', item: publicMcp(next) };
      } else {
        const native =
          c.kind === 'plugin-install'
            ? await runtime.install(c.spec, request.id, signal)
            : c.kind === 'plugin-update'
              ? await runtime.update(c.name, p.detail.version, request.id, signal)
              : c.state === 'removed'
                ? await runtime.remove(c.name)
                : current.state === 'removed' && c.state === 'enabled'
                  ? await runtime.install(`${current.name}@${current.version}`, request.id, signal)
                  : await runtime.enable(c.name, c.state === 'enabled');
        const receipt = native.result || native;
        if (!goodApplication.has(receipt.application)) {
          op.state = receipt.application === 'cancelled' ? 'cancelled' : 'failed';
          op.public = {
            id: request.id,
            state: op.state,
            error: native.restored
              ? '插件加载失败，已恢复原配置。'
              : '插件没有应用，请核对主机原生目录；不会重试。',
          };
          await save();
          return op.public;
        }
        const itemName = p.detail?.name || c.name;
        collection[itemName] = {
          name: itemName,
          version: receipt.version || p.detail?.version || current.version,
          state: c.state || (c.kind === 'plugin-update' ? current.state : 'enabled'),
          application: receipt.application,
          ...(receipt.restartReason ? { restartReason: receipt.restartReason } : {}),
          previousVersion:
            c.kind === 'plugin-update' ? current.version : current?.previousVersion || null,
        };
        data.scopes[digest(cwd)] = state;
        await save();
        result = { state: receipt.application, item: publicPlugin(collection[itemName]) };
      }
      op.state = result.state;
      op.public = { id: request.id, ...result };
      await save();
      return op.public;
    } catch (e) {
      op.state = 'unknown';
      op.public = { id: request.id, state: 'unknown', error: genericError };
      await save();
      throw fail(e.status || 409, genericError);
    }
  }
  return {
    snapshot: (cwd) => structuredClone(scope(cwd)),
    async handle(agent, raw, signal) {
      const request = dshExtensionRequest.parse(raw),
        cwd = await canonical(agent.session.header.cwd);
      signal?.throwIfAborted();
      if (request.action === 'catalog') {
        const state = scope(cwd);
        return {
          version: 1,
          skills: Object.values(state.skills).map((s) => {
            const { markdown, resources, ...item } = publicSkill(s);
            return { ...item, resourceNames: resources.map((r) => r.path) };
          }),
          mcps: await Promise.all(
            Object.values(state.mcps).map(async (s) => ({
              ...publicMcp(s),
              connection: await runtime.mcpStatus(agent, s.name),
            })),
          ),
          plugins: Object.values(state.plugins).map(publicPlugin),
          nativePlugins: (await runtime.bundles()).slice(0, 150).map((b) => ({
            name: b.name,
            version: b.version,
            enabled: b.enabled,
            availability: b.availability,
            managed: !!state.plugins[b.name],
            description: b.description?.slice(0, 1000) || '',
          })),
        };
      }
      if (request.action === 'read-skill') {
        const skill = scope(cwd).skills[request.name];
        if (!skill) throw fail(404, '此技能不是本工作区管理的技能。');
        return publicSkill(skill);
      }
      if (request.action === 'status') {
        const result = data.operations[request.id];
        if (!result || result.cwd !== cwd) throw fail(404, '扩展操作不存在。');
        return result.public || { id: request.id, state: result.state };
      }
      const run = async () =>
        request.action === 'discard'
          ? await (async () => {
              const p = data.plans[request.plan];
              if (!p || p.cwd !== cwd || p.claimed)
                throw fail(409, '预览不存在或已执行，请核对原操作。');
              p.discarded = true;
              await save();
              return { state: 'discarded' };
            })()
          : request.action === 'prepare'
            ? plan(cwd, request, signal)
            : runtime.withIdle
              ? runtime.withIdle(
                  cwd,
                  data.plans[request.plan]?.change.kind.startsWith('plugin'),
                  () => commit(cwd, request, signal),
                )
              : commit(cwd, request, signal);
      const result = tail.then(run);
      tail = result.catch(() => {});
      return result;
    },
    async resourceDirectory(cwd, skill) {
      const directory = join(cwd, '.astral-skill-resources', skill.name, digest(skill.resources));
      let base = cwd;
      for (const segment of ['.astral-skill-resources', skill.name, digest(skill.resources)]) {
        base = join(base, segment);
        await mkdir(base, { recursive: true, mode: 0o700 });
        const info = await lstat(base);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw fail(403, '技能资源目录不能使用链接。');
      }
      for (const r of skill.resources) {
        const path = resolve(directory, r.path),
          rel = relative(directory, path);
        if (!rel || isAbsolute(rel) || rel.startsWith('..')) throw fail(403, '资源路径不正确。');
        const parts = rel.split('/');
        let parent = directory;
        for (const part of parts.slice(0, -1)) {
          parent = join(parent, part);
          await mkdir(parent, { recursive: true, mode: 0o700 });
          if ((await lstat(parent)).isSymbolicLink()) throw fail(403, '资源路径不能使用链接。');
        }
        try {
          await writeFile(path, r.text, { flag: 'wx', mode: 0o600 });
        } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          const info = await lstat(path);
          if (
            info.isSymbolicLink() ||
            !info.isFile() ||
            info.nlink !== 1 ||
            (await readFile(path, 'utf8')) !== r.text
          )
            throw fail(403, '技能资源内容或文件链接不符。');
        }
      }
      return directory;
    },
    close: () => tail,
  };
}
