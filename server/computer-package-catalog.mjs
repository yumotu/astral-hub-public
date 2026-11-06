import { randomUUID } from 'node:crypto';
import { fail } from './accounts.mjs';
import {
  npmPackageName,
  exactPackageVersion,
  parseOnlinePackage,
  packageAuthority,
} from '../shared/computer-package.mjs';

export function createComputerPackageCatalog({ ai, fetch: fetcher = fetch, now = Date.now }) {
  const previews = new Map();
  async function registry(path) {
    const response = await fetcher('https://registry.npmjs.org/' + path, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw fail(502, 'npm插件目录暂时无法读取（' + response.status + '）。');
    const reader = response.body.getReader();
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 3 * 1024 * 1024) throw fail(502, 'npm插件目录响应过大。');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const clean = (v, n) => (typeof v === 'string' ? v.replace(/[\x00-\x1f]/g, ' ').slice(0, n) : '');
  return {
    resolve(id, owner, deviceId, projectId) {
      const p = previews.get(id);
      if (
        !p ||
        p.expires <= now() ||
        p.owner !== owner ||
        p.deviceId !== deviceId ||
        p.projectId !== projectId
      )
        throw fail(409, '安装预览已过期或不属于此电脑项目，请重新查找。');
      return p.package;
    },
    async wish({ wish, owner, deviceId, projectId }) {
      if (!ai) throw fail(503, '插件推荐尚未配置。');
      const plan = await ai('queries', { wish });
      const queries = (Array.isArray(plan.queries) ? plan.queries : [])
        .filter((q) => typeof q === 'string' && /^[A-Za-z0-9 ._-]{1,100}$/.test(q))
        .slice(0, 3);
      if (!queries.length) throw fail(502, '插件搜索关键词生成失败，请重新描述需求。');
      const searches = await Promise.all(
        queries.map(async (q) =>
          registry(
            '-/v1/search?' + new URLSearchParams({ text: 'keywords:pi-package ' + q, size: '16' }),
          ),
        ),
      );
      const names = new Map();
      for (const result of searches)
        for (const { package: p } of result.objects || [])
          if (p && npmPackageName.test(p.name || '') && exactPackageVersion.test(p.version || ''))
            names.set(p.name, p.version);
      const candidates = [];
      const inspect = async ([name, version]) => {
        const p = await registry(encodeURIComponent(name) + '/' + encodeURIComponent(version));
        if (p.name !== name || p.version !== version) throw Error('registry identity changed');
        const pinned = parseOnlinePackage({
          name: p.name,
          version: p.version,
          integrity: p.dist?.integrity,
        });
        const tarball = new URL(p.dist.tarball);
        if (
          tarball.protocol !== 'https:' ||
          tarball.hostname !== 'registry.npmjs.org' ||
          tarball.username ||
          tarball.password
        )
          throw Error('external tarball');
        if (!p.pi && !p.keywords?.includes('pi-package')) throw Error('not a Pi package');
        const repo = typeof p.repository === 'string' ? p.repository : p.repository?.url;
        return {
          ...pinned,
          description: clean(p.description, 700),
          license: clean(p.license, 100),
          npmUrl: 'https://www.npmjs.com/package/' + name + '/v/' + version,
          repository:
            typeof repo === 'string' &&
            /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?$/.test(repo.replace(/^git\+/, ''))
              ? repo.replace(/^git\+/, '')
              : '',
          engines:
            p.engines && typeof p.engines === 'object'
              ? Object.fromEntries(
                  Object.entries(p.engines)
                    .slice(0, 10)
                    .map(([k, v]) => [clean(k, 50), clean(v, 120)]),
                )
              : {},
          dependencies: Object.keys(p.dependencies || {}).slice(0, 30),
          hasInstallScripts: ['preinstall', 'install', 'postinstall', 'prepare'].some(
            (k) => !!p.scripts?.[k],
          ),
          resources: p.pi
            ? ['extensions', 'skills', 'prompts', 'themes'].filter(
                (k) => Array.isArray(p.pi[k]) && p.pi[k].length,
              )
            : [],
        };
      };
      const inspected = [],
        pending = [...names].slice(0, 24);
      for (let offset = 0; offset < pending.length; offset += 4)
        inspected.push(
          ...(await Promise.allSettled(pending.slice(offset, offset + 4).map(inspect))),
        );
      for (const result of inspected)
        if (result.status === 'fulfilled') candidates.push(result.value);
      if (!candidates.length)
        return {
          packages: [],
          message: '没有找到可以核验的npm Pi插件。请换一种描述；没有安装任何软件。',
        };
      const selected = await ai('select', {
        wish,
        candidates: candidates.map((p, id) => ({ id, ...p })),
      });
      const choices = Array.isArray(selected.choices) ? selected.choices.slice(0, 3) : [];
      const packages = [],
        used = new Set();
      for (const choice of choices) {
        if (!Number.isInteger(choice.id) || !candidates[choice.id] || used.has(choice.id)) continue;
        used.add(choice.id);
        const p = candidates[choice.id],
          id = randomUUID(),
          expires = now() + 15 * 60000;
        for (const [key, item] of previews) if (item.expires <= now()) previews.delete(key);
        if (previews.size >= 500) previews.delete(previews.keys().next().value);
        previews.set(id, {
          owner,
          deviceId,
          projectId,
          package: parseOnlinePackage({ name: p.name, version: p.version, integrity: p.integrity }),
          expires,
        });
        packages.push({
          ...p,
          previewId: id,
          expiresAt: new Date(expires).toISOString(),
          reason: clean(choice.reason, 1000),
          limitations: clean(choice.limitations, 1000),
          authority: packageAuthority,
        });
      }
      return {
        packages,
        message: packages.length
          ? '来源和版本已核验；尚未安装。'
          : '未找到足够匹配的插件；没有安装软件。',
      };
    },
  };
}
