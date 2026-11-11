import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] && resolve(process.argv[2]);
const dependencies = process.argv[3] && resolve(process.argv[3]);
if (!source || !dependencies)
  throw Error(
    'Usage: node scripts/prepare-dsh-remote.mjs <upstream-source> <dependencies-node_modules>',
  );
const commit = '14037e78f45e14f7a5ad56c2266944548def7e3d';
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim() !== commit)
  throw Error('DSH Remote source must match the recorded commit.');
if (
  execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: source,
    encoding: 'utf8',
  }).trim()
)
  throw Error('DSH Remote source contains modified tracked files.');
const aliases = Object.fromEntries(
  ['client-core', 'webrtc', 'protocol', 'crypto'].map((name) => [
    '@dsh-remote/' + name,
    resolve(source, 'packages', name, 'src/index.ts'),
  ]),
);
const code = `
export { RemoteClientCore } from '@dsh-remote/client-core';
export { RemoteTypertGateway, HarnessAlphaClient } from '@dsh-remote/client-core';
export { HarnessQuestions } from ${JSON.stringify(resolve(source, 'packages/client-core/src/harness-questions.ts'))};
export { AdaptiveTransport } from '@dsh-remote/webrtc';
export { ClientSecureTransport } from ${JSON.stringify(resolve(source, 'packages/plugin/src/client-secure-transport.ts'))};
export { generateKeyPair, identityFingerprint, NoiseIkSession, createNoisePrologue } from '@dsh-remote/crypto';
export { SecureMessageCodec, createControlFrame, decodeControlFrame, encodeControlFrame,
createRpcResponse, createRpcError, createEvent, decodeMessage, encodeMessage } from '@dsh-remote/protocol';
`;
const out = resolve(root, 'server/vendor/dsh-remote');
const result = await build({
  stdin: { contents: code, resolveDir: source, sourcefile: 'astral-client-entry.ts', loader: 'ts' },
  outfile: resolve(out, 'client.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  minify: true,
  legalComments: 'inline',
  external: ['zod'],
  alias: aliases,
  nodePaths: [dependencies],
  plugins: [
    {
      name: 'astral-origin-bound-websocket',
      setup(builder) {
        builder.onLoad(
          { filter: /[/\\]webrtc[/\\]src[/\\]adaptive-transport\.ts$/ },
          async ({ path }) => {
            const original = await readFile(path, 'utf8');
            if ((original.match(/new WebSocket\(/g) || []).length !== 3)
              throw Error('Upstream socket sites changed; review the origin binding patch.');
            return {
              loader: 'ts',
              contents: original.replaceAll(
                'new WebSocket(',
                'new (this.options.WebSocket ?? WebSocket)(',
              ),
            };
          },
        );
      },
    },
  ],
  metafile: true,
  write: false,
  banner: {
    js: `// DSH Remote MIT sources ${commit}. See LICENSE, NOTICES and UPSTREAM.json.`,
  },
});
await mkdir(out, { recursive: true });
const inputFiles = Object.keys(result.metafile.inputs).filter(
  (p) => !p.startsWith('<') && !p.endsWith('astral-client-entry.ts'),
);
const inputs = await Promise.all(
  inputFiles.map(async (file) => ({
    file: resolve(file).startsWith(source)
      ? 'upstream/' + relative(source, resolve(file))
      : file.includes('node_modules/')
        ? 'dependencies/' + relative(dependencies, resolve(file))
        : relative(source, file),
    sha256: createHash('sha256')
      .update(await readFile(file))
      .digest('hex'),
  })),
);
const metadata = {
  repository: 'https://github.com/liguobao/ds-harness-remote',
  commit,
  license: 'MIT',
  build: 'esbuild@0.28.2; node24 ESM; minify; external zod',
  patches: [
    'AdaptiveTransport uses an injected per-connection WebSocket constructor when supplied; all three dial sites.',
  ],
  bundleSha256: createHash('sha256').update(result.outputFiles[0].contents).digest('hex'),
  inputs: inputs.sort((a, b) => a.file.localeCompare(b.file)),
};
await writeFile(resolve(out, 'client.mjs'), result.outputFiles[0].contents);
await writeFile(resolve(out, 'UPSTREAM.json'), JSON.stringify(metadata, null, 2) + '\n');
await writeFile(resolve(out, 'LICENSE'), await readFile(resolve(source, 'LICENSE')));
await writeFile(
  resolve(out, 'build-package.json'),
  await readFile(resolve(dependencies, '../package.json')),
);
await writeFile(
  resolve(out, 'build-package-lock.json'),
  await readFile(resolve(dependencies, '../package-lock.json')),
);
const licenseRoots = new Set(
  inputFiles
    .filter((p) => p.includes('node_modules/'))
    .map((p) => {
      const base = p.slice(0, p.lastIndexOf('node_modules/') + 13);
      const parts = p.slice(base.length).split('/');
      return base + parts.slice(0, parts[0].startsWith('@') ? 2 : 1).join('/');
    }),
);
const notices = [];
for (const entry of [...licenseRoots].sort()) {
  const pkg = JSON.parse(await readFile(resolve(entry, 'package.json'), 'utf8'));
  notices.push(`${pkg.name}@${pkg.version}\n${await readFile(resolve(entry, 'LICENSE'), 'utf8')}`);
}
await writeFile(
  resolve(out, 'NOTICES'),
  notices.join('\n\n--------------------------------\n\n') + '\n',
);
console.log(
  `Prepared DSH Remote client: ${result.outputFiles[0].contents.length} bytes, ${inputs.length} inputs.`,
);
