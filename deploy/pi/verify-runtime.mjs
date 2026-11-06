// Run only in a fresh disposable container, without production volumes or ports.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createProjects } from './projects.mjs';
import { createSandboxOperations } from './bash-sandbox.mjs';
import { checkPackageActivation } from './package-preflight.mjs';

if (process.platform !== 'linux' || process.env.ASTRAL_RUNTIME_QA !== '1')
  throw Error('Run only in a disposable Linux QA container with ASTRAL_RUNTIME_QA=1.');
if ((await readdir('/projects/workspace')).length)
  throw Error('QA refuses a non-empty workspace; never attach production volumes.');

const base = await mkdtemp('/projects/workspace/runtime-qa-');
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const node = (code) => 'node -e ' + quote(code);
let server;
const proof = {};
try {
  const workspace = join(base, 'workspace');
  await mkdir(workspace);
  const registry = await createProjects({
    sources: [
      { id: 'workspace', name: 'QA', root: workspace, serverPath: '/synthetic', readOnly: false },
    ],
    registryFile: join(base, 'projects.json'),
    backupDir: join(base, 'backups'),
    fullAccess: true,
  });
  const alice = { id: randomUUID(), username: 'alice', admin: false },
    bob = { id: randomUUID(), username: 'bob', admin: false };
  const own = await registry.ensureUser(alice),
    other = await registry.ensureUser(bob);
  const projects = await registry.authorize(alice, own.id, 'edit');
  assert.equal(projects.length, 1);
  await assert.rejects(registry.authorize(alice, other.id, 'read'));
  const cwd = projects[0].root,
    foreign = registry.files.project(other.id).root;
  await writeFile(join(cwd, '.env'), 'SYNTHETIC_SECRET=must-be-masked');
  await writeFile(join(cwd, 'visible.txt'), 'own-project');
  process.env.DEEPSEEK_API_KEY = 'synthetic-parent-secret-never-mount';
  process.env.ASTRAL_MAIL_ACCESS_TOKEN = 'synthetic-capability-never-inherit';
  const offline = createSandboxOperations(projects, cwd);
  async function command(operations, script, timeout = 30) {
    let output = '';
    const result = await operations.exec(script, cwd, {
      timeout,
      onData: (chunk) => {
        output += chunk;
      },
    });
    assert.equal(result.exitCode, 0, output);
    return output;
  }
  const isolation = await command(
    offline,
    node(
      `const fs=require('node:fs');if(process.env.DEEPSEEK_API_KEY||process.env.ASTRAL_MAIL_ACCESS_TOKEN)throw Error('credential inherited');if(process.env.HOME!=='/home/agent')throw Error('HOME');if(fs.existsSync(${JSON.stringify(foreign)}))throw Error('other user visible');try{if(fs.readFileSync('.env','utf8')!=='')throw Error('private file unmasked')}catch(e){if(!['EACCES','ENOENT'].includes(e.code))throw e;}if(fs.readFileSync('visible.txt','utf8')!=='own-project')throw Error('own file missing');console.log('ISOLATION_OK')`,
    ),
  );
  assert.match(isolation, /ISOLATION_OK/);
  proof.memberIsolation = true;
  proof.credentialsNotInherited = true;

  server = createServer((_req, res) => res.end('OWNED_QA_LOOPBACK'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const local = `http://127.0.0.1:${server.address().port}`;
  const blocked = await command(
    offline,
    node(
      `fetch(${JSON.stringify(local)},{signal:AbortSignal.timeout(1500)}).then(()=>{process.exitCode=1}).catch(()=>console.log('OFFLINE_BLOCKED'))`,
    ),
  );
  assert.match(blocked, /OFFLINE_BLOCKED/);
  proof.offlineDefault = true;
  const policy = { enabled: true, version: 1, expiresAt: Date.now() + 60000 };
  const online = createSandboxOperations(projects, cwd, { getNetworkPolicy: async () => policy });
  const reachable = await command(
    online,
    node(
      `(async()=>{const dns=require('node:dns').promises;const a=await dns.resolve4('registry.npmjs.org');if(!a.length)throw Error('DNS');const r=await fetch('https://registry.npmjs.org/-/ping',{signal:AbortSignal.timeout(10000)});if(r.status!==200)throw Error('HTTPS '+r.status);const local=await fetch(${JSON.stringify(local)},{signal:AbortSignal.timeout(3000)});if(await local.text()!=='OWNED_QA_LOOPBACK')throw Error('loopback');console.log('DNS_HTTPS_CONTAINER_NETWORK_OK')})().catch(e=>{console.error(e.message);process.exitCode=1})`,
    ),
  );
  assert.match(reachable, /DNS_HTTPS_CONTAINER_NETWORK_OK/);
  proof.authorizedDnsHttps = true;
  proof.scopeIncludesContainerLoopback = true;
  await command(
    offline,
    'python3 -m virtualenv --no-download .venv && .venv/bin/python -m pip --version && curl --version',
  );
  proof.projectLocalPythonEnvironment = true;
  let started = false;
  const revocable = createSandboxOperations(projects, cwd, {
    networkPollMs: 50,
    getNetworkPolicy: async () => policy,
  });
  const at = Date.now();
  await assert.rejects(
    revocable.exec('echo RUNNING_WITH_NETWORK; sleep 30', cwd, {
      timeout: 10,
      onData: (chunk) => {
        if (String(chunk).includes('RUNNING_WITH_NETWORK')) {
          started = true;
          policy.enabled = false;
          policy.version++;
        }
      },
    }),
    /联网授权/,
  );
  assert.equal(started, true);
  assert.ok(Date.now() - at < 5000);
  proof.revocationStopsRunningProcess = true;

  const packages = join(base, 'packages');
  await mkdir(packages);
  await writeFile(join(packages, 'settings.json'), '{"packages":[]}');
  const activation = await checkPackageActivation(packages, { coreOnly: true });
  assert.equal(activation.ready, true);
  proof.realPiRpcActivation = true;
  proof.note =
    'Synthetic accounts in a fresh Linux container. Real DNS/HTTPS and Pi RPC; no model task or formal plugins.';
  console.log(JSON.stringify(proof, null, 2));
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(base, { recursive: true, force: true });
}
