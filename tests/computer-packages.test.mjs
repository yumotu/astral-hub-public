import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createComputerPackageCatalog } from '../server/computer-package-catalog.mjs';
import { parseOnlinePackage } from '../shared/computer-package.mjs';
const integrity = 'sha512-' + Buffer.alloc(64, 1).toString('base64');
test('online plugin wishes select only verified registry results and bind expiring previews to owner/device/project', async () => {
  let now = 1000;
  const calls = [];
  const catalog = createComputerPackageCatalog({
    now: () => now,
    ai: async (stage, data) => {
      if (stage === 'queries') return { queries: ['diagram'] };
      assert.equal(data.candidates.length, 1);
      return {
        choices: [
          { id: 40, reason: 'invented' },
          { id: 0, reason: '实际候选', limitations: '运行依赖待检查' },
        ],
      };
    },
    fetch: async (url) => {
      calls.push(url);
      assert.ok(url.startsWith('https://registry.npmjs.org/'));
      if (url.includes('/-/v1/search?'))
        return Response.json({
          objects: [
            { package: { name: 'test-pi-diagram', version: '1.0.0' } },
            { package: { name: '../../private', version: 'latest' } },
          ],
        });
      return Response.json({
        name: 'test-pi-diagram',
        version: '1.0.0',
        description: 'Diagram tool',
        keywords: ['pi-package'],
        pi: { extensions: ['index.ts'] },
        dist: {
          integrity,
          tarball: 'https://registry.npmjs.org/test-pi-diagram/-/test-pi-diagram-1.0.0.tgz',
        },
      });
    },
  });
  const args = {
    wish: '帮我画图',
    owner: 'owner',
    deviceId: randomUUID(),
    projectId: randomUUID(),
  };
  const r = await catalog.wish(args);
  assert.equal(r.packages.length, 1);
  const p = r.packages[0];
  assert.deepEqual(catalog.resolve(p.previewId, args.owner, args.deviceId, args.projectId), {
    name: p.name,
    version: '1.0.0',
    integrity,
  });
  assert.throws(
    () => catalog.resolve(p.previewId, 'other', args.deviceId, args.projectId),
    /过期|属于/,
  );
  assert.throws(
    () => catalog.resolve(p.previewId, args.owner, randomUUID(), args.projectId),
    /过期|属于/,
  );
  now += 16 * 60000;
  assert.throws(
    () => catalog.resolve(p.previewId, args.owner, args.deviceId, args.projectId),
    /过期/,
  );
  assert.equal(calls.length, 2);
});
test('online plugin pins reject paths, commands, tags, ranges, foreign tarballs and missing integrity', async () => {
  for (const p of [
    { name: '../private', version: '1.0.0', integrity },
    { name: 'package', version: 'latest', integrity },
    { name: 'pkg;echo', version: '1.0.0', integrity },
    { name: 'pkg', version: '^1.0.0', integrity },
    { name: 'pkg', version: '1.0.0' },
    { name: 'pkg', version: '1.0.0', integrity, extra: 'private' },
  ])
    assert.throws(() => parseOnlinePackage(p));
  const catalog = createComputerPackageCatalog({
    ai: async () => ({ queries: ['test'] }),
    fetch: async (url) =>
      url.includes('/-/v1/')
        ? Response.json({ objects: [{ package: { name: 'test', version: '1.0.0' } }] })
        : Response.json({
            name: 'test',
            version: '1.0.0',
            keywords: ['pi-package'],
            dist: { integrity, tarball: 'http://127.0.0.1/private' },
          }),
  });
  assert.deepEqual((await catalog.wish({ wish: 'test' })).packages, []);
});
