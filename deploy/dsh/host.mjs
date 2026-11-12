import { runProfile } from '@deepseek-ai/dsh/profile-boot';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import * as Connection from '@deepseek-ai/dsh-client-connection';
import { mkdir, readFile, writeFile, lstat, readlink, unlink } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createRemoteServer } from './vendor/remote-server.mjs';
import { pnpmEnvironment } from './pnpm-environment.mjs';
import {
  HostPluginRuntime,
  IdentityStore,
  resolveConfig,
  SafeLogger,
  TypertGatewaySwitch,
  createOwnerPeerFactory,
  ownerPeerConstructor,
} from './vendor/remote-host.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.env.DSH_HOME || '/state/harness');
const config = JSON.parse(
  await readFile(process.env.DSH_SERVER_CONFIG || '/run/astral-dsh/connection.json', 'utf8'),
);
const origin = new URL(config.origin);
if (
  origin.protocol !== 'http:' ||
  origin.hostname !== '127.0.0.1' ||
  origin.pathname !== '/' ||
  origin.port !== '8971' ||
  !config.account ||
  config.password?.length < 32
)
  throw Error('Invalid local DSH deployment configuration');
const profileDir = resolve(root, 'profiles/astral-server');
await mkdir(profileDir, { recursive: true, mode: 0o700 });
// Old profiles pointed node_modules at the immutable installation. Keep the
// installation as the runtime fallback; profile packages need their own tree.
const profileModules = resolve(profileDir, 'node_modules');
const profileModulesInfo = await lstat(profileModules).catch((e) => {
  if (e.code !== 'ENOENT') throw e;
  return null;
});
if (profileModulesInfo?.isSymbolicLink()) {
  const link = await readlink(profileModules);
  if (resolve(profileDir, link) !== resolve(here, 'node_modules'))
    throw Error('Unexpected profile dependency link; manual inspection required');
  await unlink(profileModules); // only the known link; the installed tree stays intact
}
async function initial(path, text) {
  try {
    await writeFile(path, text, { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}
// Match the pinned Harness Profile layout. Stable package paths let its
// native HMR compare and replace a changed package rather than reuse an old
// pnpm symlink target. Existing user-owned pnpm configuration is preserved.
await initial(
  resolve(profileDir, 'pnpm-workspace.yaml'),
  'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
);
await initial(
  resolve(profileDir, 'package.json'),
  JSON.stringify({
    name: 'astral-dsh-server',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  }),
);
const model = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
if (!/^[A-Za-z0-9._-]{1,128}$/.test(model)) throw Error('Invalid configured model');
await initial(
  resolve(profileDir, 'cordis.patch.yml'),
  `- id: session-title-llm
  disabled: true
- id: llm-deepseek-account
  disabled: true
- id: deepseek-account
  disabled: true
- id: session-telemetry-otel
  disabled: true
- id: desktop-product-telemetry
  disabled: true
- id: agent-default-model
  config:
    provider: deepseek-official
    model: ${model}
    reasoningEffort: off
- insert:
    - id: astral-app-tools
      name: ${JSON.stringify(resolve(here, '../../integrations/dsh-app-tools/index.mjs'))}
      config:
        endpoint: http://127.0.0.1:8787/api/agent/dsh/app-access
`,
);
// Separate overlay also upgrades existing persisted profiles without replacing
// their user-owned patch, provider selection or credentials.
const extensionsPatch = resolve(root, 'astral-extensions.patch.yml');
await writeFile(
  extensionsPatch,
  `- insert:\n    - id: astral-extensions\n      name: ${JSON.stringify(resolve(here, '../../integrations/dsh-app-tools/extensions.mjs'))}\n`,
  { mode: 0o600 },
);
// Credentials remain inside this server container, and are not used as browser
// or Remote authentication. The native Messages adapter owns model traffic.
const environment = createLaunchEnvironmentSnapshot([
  {
    source: 'process',
    values: {
      DSH_HOME: root,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: 'workspace-write',
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
    },
  },
]);
let runtime,
  host,
  relay,
  health,
  stopping = false;
let ready = false;
async function close() {
  if (stopping) return;
  stopping = true;
  ready = false;
  await new Promise((r) => health?.close(r) || r());
  await host?.close().catch(() => {});
  await relay?.close().catch(() => {});
  await runtime?.ctx?.fiber.dispose().catch(() => {});
}
process.once('SIGTERM', () => {
  void close().then(() => process.exit(0));
});
process.once('SIGINT', () => {
  void close().then(() => process.exit(0));
});
try {
  runtime = await runProfile({
    profile: 'astral-server',
    environment,
    patchFiles: [extensionsPatch],
    args: ['--port', '0', '--no-open'],
    packageManager: {
      command: process.execPath,
      args: [resolve(here, 'node_modules/pnpm/bin/pnpm.mjs')],
      env: pnpmEnvironment(root),
    },
  });
  const ctx = runtime.ctx;
  if (!ctx.sessionController || !ctx.typertGateway || !ctx.agentLoop)
    throw Error('Required Harness services are absent');
  await ctx.workspaceController.create({ path: '/workspace' });
  relay = createRemoteServer({
    account: config.account,
    password: config.password,
    dataFile: resolve(root, 'remote-state.json'),
    publicUrl: config.origin,
    logLevel: 'error',
  });
  await new Promise((r) => relay.server.listen(8971, '127.0.0.1', r));
  const connection = ctx.get('connection');
  const createOwner = createOwnerPeerFactory(ctx, ownerPeerConstructor(Connection), connection),
    fallback = createOwner();
  const wrapper = new TypertGatewaySwitch(ctx.typertGateway, () => fallback),
    gateway = wrapper.local();
  gateway.createPeer = () => {
    const peer = createOwner();
    return { ...wrapper.local(peer), dispose: async () => peer?.dispose?.() };
  };
  const identities = new IdentityStore({ directory: resolve(root, 'identity'), role: 'host' });
  host = new HostPluginRuntime(
    resolveConfig({
      enabled: true,
      serverUrl: config.origin,
      deviceName: config.name,
      forceRelay: true,
      terminal: { enabled: true },
      codex: { enabled: false },
      cursor: { enabled: false },
      acp: { enabled: false, backends: [] },
    }),
    identities,
    new SafeLogger({ debug() {}, info() {}, warn() {}, error() {} }, () => 'error'),
    gateway,
  );
  await host.start();
  // Saved host credentials are reused; only the first deployment enrolls it.
  if (!host.hostStatus().authorized)
    await host.authorizeHostWithAccount(config.account, config.password);
  for (let i = 0; i < 240 && !host.hostStatus().online; i++)
    await new Promise((r) => setTimeout(r, 250));
  if (!host.hostStatus().online) throw Error('DSH Remote host is offline');
  const identity = host.currentIdentity();
  const fingerprint = createHash('sha256')
    .update(Buffer.from(identity.publicKey, 'base64url'))
    .digest('hex')
    .toUpperCase();
  const proof = {
    version: '0.8.13',
    revision: 'dsh4',
    fileBridgeVersion: 1,
    workbenchVersion: 1,
    extensionManagerVersion: 1,
    harness: '0.2.2-rc.1',
    remote: '14037e78f45e14f7a5ad56c2266944548def7e3d',
    deviceId: identity.deviceId,
    fingerprint,
    model,
    workspace: '/workspace',
  };
  await writeFile(resolve(root, 'ready.json'), JSON.stringify(proof), { mode: 0o600 });
  ready = true;
  health = createServer((req, res) => {
    const online = ready && !stopping && host.hostStatus().online;
    res.writeHead(req.url === '/health' && online ? 200 : 503, {
      'Content-Type': 'application/json',
    });
    res.end(JSON.stringify({ ok: online, ...proof }));
  });
  await new Promise((r) => health.listen(8972, '127.0.0.1', r));
  console.log('Astral DSH runtime ready (loopback relay, pinned native session protocol).');
} catch (error) {
  // Startup diagnostics omit credentials and entire provider request bodies.
  const detail = String(error?.message || error?.code || error?.name || 'Error')
    .replaceAll(process.env.DEEPSEEK_API_KEY || 'never-match-missing-key', '[redacted-key]')
    .replaceAll(config.password, '[redacted-password]');
  console.error('Astral DSH startup failed:', detail);
  await close();
  process.exitCode = 1;
}
