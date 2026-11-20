"""Disposable 0.9.1 integrated App/Pi + unchanged dsh4 acceptance; no production mounts or model key."""
from pathlib import Path
import json, sys, subprocess, os, time, re, hashlib, secrets, uuid, base64, tarfile, urllib.request

stage = Path(sys.argv[1]).resolve()
attempt = sys.argv[2] if len(sys.argv) > 2 else '1'
assert re.fullmatch('[1-9][0-9]?', attempt)
qa = stage / ('canary-release-0820-' + attempt)
proof = stage / ('proof-release-0820-' + attempt)
assert not qa.exists() and not proof.exists(), 'Inspect old attempt; use a fresh isolated attempt.'
os.umask(0o077)
qa.mkdir(); proof.mkdir(); os.chown(proof, 1000, 1000)
for name in ['share', 'state', 'workspace', 'test-temp', 'test-deps']:
    path = qa / name; path.mkdir(); os.chown(path, 1000, 1000)
def prepare_test_compiler(lock_path, destination):
    # Only the disposable test container sees this dev dependency. App/Pi
    # images and production node_modules remain byte-for-byte unchanged.
    entry = json.loads(lock_path.read_text())['packages']['node_modules/typescript']
    assert entry['version'] == '5.9.3' and entry.get('dev') is True
    assert entry['resolved'] == 'https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz'
    algorithm, encoded = entry['integrity'].split('-', 1)
    assert algorithm == 'sha512'
    request = urllib.request.Request(entry['resolved'], headers={'User-Agent': 'Astral-Hub-isolated-release-QA'})
    with urllib.request.urlopen(request, timeout=60) as response:
        assert response.geturl() == entry['resolved']
        blob = response.read(8 * 1024 * 1024 + 1)
    assert len(blob) <= 8 * 1024 * 1024
    assert hashlib.sha512(blob).digest() == base64.b64decode(encoded, validate=True), 'Test compiler integrity mismatch.'
    package = destination / 'typescript.tgz'
    package.write_bytes(blob)
    with tarfile.open(package, mode='r:gz') as archive:
        entries = archive.getmembers()
        assert sum(item.size for item in entries) <= 40 * 1024 * 1024
        for item in entries:
            assert (item.name == 'package' and item.isdir() or item.name.startswith('package/')) and '..' not in Path(item.name).parts
            assert item.isdir() or item.isfile(), 'Test compiler contains a symlink or special entry.'
        archive.extractall(destination)
    package.unlink()
    result = destination / 'package'
    # Root's restrictive QA umask also affects implicit tar directories.
    # Normalize only this disposable, validated compiler tree for uid 1000.
    for path in [result, *result.rglob('*')]:
        path.chmod(0o755 if path.is_dir() else 0o644)
    assert json.loads((result / 'package.json').read_text())['version'] == entry['version']
    assert (result / 'lib/typescript.js').is_file()
    return {'version': entry['version'], 'integrity': entry['integrity'], 'source': entry['resolved']}

compiler = prepare_test_compiler(stage / 'package-lock.json', qa / 'test-deps')

config = {'version': 1, 'owner': str(uuid.uuid4()), 'name': 'Isolated 0.9.1 QA',
          'origin': 'http://127.0.0.1:8971', 'account': 'synthetic-release-0820@example.test',
          'password': secrets.token_hex(32), 'deviceId': str(uuid.uuid4()), 'fingerprint': '0' * 64}
connection = qa / 'share/connection.json'
connection.write_text(json.dumps(config)); connection.chmod(0o600); os.chown(connection, 1000, 1000)
profile = qa / 'state/harness/profiles/astral-server'; profile.mkdir(parents=True)
(profile / 'cordis.patch.yml').write_text('''- id: session-title-llm
  disabled: true
- id: llm-deepseek
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
    provider: synthetic
    model: synthetic
    reasoningEffort: off
- id: skill-filesystem
  config:
    includeDefaultRoots: false
    customSkillDirs:
      - /workspace/.dsh/skills
- insert:
    - id: astral-workbench-synthetic
      name: /qa/workbench-provider.mjs
    - id: astral-app-tools
      name: /opt/astral/integrations/dsh-app-tools/index.mjs
      config:
        endpoint: http://127.0.0.1:8787/api/agent/dsh/app-access
''')
skill = qa / 'workspace/.dsh/skills/qa-skill'; skill.mkdir(parents=True)
(qa / 'workspace/.git').mkdir()
(skill / 'SKILL.md').write_text('---\nname: qa-skill\ndescription: Isolated QA skill\n---\nLinux QA skill body\n')
for base in [qa / 'state', qa / 'workspace']:
    for path in [base, *base.rglob('*')]: os.chown(path, 1000, 1000)
anchor = 'astral-release-0820-canary-app-' + attempt
runtime = 'astral-release-0820-canary-dsh-' + attempt
images = {'app': 'astral-hub:0.9.1', 'pi': 'astral-pi:1.4.0-v0820-learning1', 'dsh': 'astral-dsh:0.8.12-dsh4'}
def run(args, **kw): return subprocess.run(args, check=True, **kw)
def output(args): return subprocess.check_output(args, text=True)
def passed_tests(path, minimum):
    text = path.read_text()
    counts = {}
    for key in ['tests', 'pass', 'fail', 'cancelled', 'skipped']:
        values = re.findall(r'^# ' + key + r' (\d+)\s*$', text, re.MULTILINE)
        assert len(values) == 1, 'Missing or ambiguous test summary: ' + key
        counts[key] = int(values[0])
    assert counts['tests'] >= minimum and counts['pass'] == counts['tests']
    assert counts['fail'] == counts['cancelled'] == counts['skipped'] == 0
    return counts['tests']

def test_group(name, tests, minimum):
    logs[name] = stage / ('release-0820-' + attempt + '-' + name + '.log')
    with logs[name].open('w') as log:
        run(['docker', 'exec', '-e', 'TMPDIR=/testtmp', anchor, 'node', '--test',
             '--test-reporter=tap', '--test-concurrency=1', *tests], stdout=log, stderr=subprocess.STDOUT, timeout=360)
    return passed_tests(logs[name], minimum)

def test_pi_learning():
    # This test imports a real Pi extension. Resolve it in the candidate Pi
    # image so its runtime dependencies match production, without app secrets.
    logs['pi-learning'] = stage / ('release-0820-' + attempt + '-pi-learning.log')
    script = """import fs from 'node:fs';import {spawnSync} from 'node:child_process';
fs.mkdirSync('/qa/deploy',{recursive:true});fs.symlinkSync('/bridge','/qa/deploy/pi');
const r=spawnSync(process.execPath,['--test','--test-reporter=tap','/qa/tests/pi-learning-handoff.test.mjs'],{stdio:'inherit'});process.exit(r.status??1);"""
    with logs['pi-learning'].open('w') as log:
        run(['docker','run','--rm','--init','--network=none','--read-only',
             '--tmpfs','/tmp:rw,size=32m','--tmpfs','/qa:rw,size=16m,mode=1777',
             '--memory=384m','--pids-limit=64','--cap-drop=ALL','--security-opt=no-new-privileges',
             '-v',str(stage/'tests/pi-learning-handoff.test.mjs')+':/qa/tests/pi-learning-handoff.test.mjs:ro',
             '--entrypoint','node',images['pi'],'--input-type=module','-e',script],
            stdout=log,stderr=subprocess.STDOUT,timeout=120)
    return passed_tests(logs['pi-learning'], 2)

image_data = json.loads(output(['docker', 'image', 'inspect', *images.values()]))
source = json.loads((stage / 'source.json').read_text())['commit']
assert image_data[0]['Config']['Labels'].get('org.opencontainers.image.revision') == source
assert image_data[0]['Config']['Labels'].get('org.opencontainers.image.base.digest') == 'sha256:5fb5c2b60b2424fd280928e4f6525787224076ca5462ed1a0333829256f479f1'
assert image_data[1]['Config']['Labels'].get('org.opencontainers.image.revision') == 'd10b1f822c9ea6a9f54e96ce926ab334e3523515'
assert image_data[1]['Config']['Labels'].get('org.opencontainers.image.base.digest') == 'sha256:14fbdbf68f57e67a844802751c6b1749bcfd01c0f0adf8569ce3923a820c12c6'
assert image_data[2]['Id'] == 'sha256:415d6203a155f055907c74d6752b0fccb9b4e29f9a5b62e7e7bc7e60dbf98b39', 'Only the reviewed dsh4 image may be used for acceptance.'
assert all(n not in output(['docker', 'ps', '-a', '--format', '{{.Names}}']).splitlines() for n in [anchor, runtime])
def image_files(image, roots):
    # Isolated read-only image introspection, no production mounts or credentials.
    script = """import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
const value={};function visit(p){const s=fs.lstatSync(p);if(s.isSymbolicLink())value[p]='L:'+fs.readlinkSync(p);else if(s.isDirectory())for(const n of fs.readdirSync(p).sort())visit(path.join(p,n));else if(s.isFile())value[p]=crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');else throw Error('special runtime entry');}for(const p of JSON.parse(process.argv[1]))visit(p);console.log(JSON.stringify(value));"""
    return json.loads(output(['docker','run','--rm','--network=none','--read-only','--memory=256m','--pids-limit=64','--cap-drop=ALL','--security-opt=no-new-privileges','--entrypoint=node',image,'--input-type=module','-e',script,json.dumps(roots)]))

old_pi = image_files('sha256:6d44523198fd256c486bcdf03561d6a797c77186e3a0e807613807e12dce7000', ['/bridge'])
new_pi = image_files(images['pi'], ['/bridge'])
assert old_pi == new_pi, 'The 0.9.1 rollout must retain the verified Pi runtime image byte-for-byte.'
app_files = image_files(images['app'], ['/app/server','/app/shared','/app/dist','/app/package.json','/app/package-lock.json','/app/deploy/pi/assistant-artifacts.mjs'])
manifest = json.loads((stage/'source.json').read_text())['files']
expected_app = {'/app/'+name:digest for name,digest in manifest.items() if name.startswith(('server/','shared/','dist/')) or name in ['package.json','package-lock.json','deploy/pi/assistant-artifacts.mjs']}
assert app_files == expected_app, 'App image source differs from the reviewed public runtime.'

logs = {}
try:
    args = ['docker', 'run', '-d', '--name', anchor, '--init', '--network=none', '--read-only',
            '--tmpfs', '/tmp:rw,size=256m', '--memory=768m', '--pids-limit=192', '--cap-drop=ALL', '--security-opt=no-new-privileges']
    mounts = [(qa / 'share', '/run/astral-dsh:ro'), (proof, '/proof'),
              (qa / 'workspace', '/qa-workspace:ro'), (qa / 'test-temp', '/testtmp'),
              (stage / 'tests', '/app/tests:ro'), (stage / 'agent', '/app/agent:ro'), (stage / 'deploy/pi', '/app/deploy/pi:ro'), (stage / 'web/src', '/app/web/src:ro'),
              (stage / 'deploy/dsh', '/app/deploy/dsh:ro'), (stage / 'deploy/dsh', '/qa:ro'), (stage / 'integrations', '/app/integrations:ro'),
              (qa / 'test-deps/package', '/app/node_modules/typescript:ro')]
    for source_path, dest in mounts: args += ['-v', str(source_path) + ':' + dest]
    run(args + ['--entrypoint=sleep', images['app'], '1800'])
    run(['docker', 'run', '-d', '--name', runtime, '--init', '--network=container:' + anchor,
         '--read-only', '--tmpfs', '/tmp:rw,size=128m', '--memory=512m', '--pids-limit=192',
         '--cap-drop=ALL', '--security-opt=no-new-privileges', '-e', 'ASTRAL_DSH_WORKBENCH_QA=1',
         '-v', str(qa / 'share') + ':/run/astral-dsh:ro', '-v', str(qa / 'state') + ':/state',
         '-v', str(qa / 'workspace') + ':/workspace', '-v', str(stage / 'deploy/dsh') + ':/qa:ro', images['dsh']])
    for _ in range(150):
        state = json.loads(output(['docker', 'inspect', runtime]))[0]['State']
        if not state['Running'] or state.get('Health', {}).get('Status') == 'healthy': break
        time.sleep(1)
    assert state.get('Health', {}).get('Status') == 'healthy', 'Inspect canary DSH log.'
    tests = ['tests/computer-catalogue.test.mjs', 'tests/assistance-context.test.mjs', 'tests/temporary-context-api.test.mjs',
             'tests/temporary-chat.test.mjs',
             'tests/unified-conversations.test.mjs', 'tests/unified-conversations-api.test.mjs',
             'tests/unified-selection.test.mjs', 'tests/assistant-artifacts.test.mjs',
             'tests/relay-unified-adapter.test.mjs', 'tests/dsh-workbench.test.mjs',
             'tests/dsh-chat.test.mjs', 'tests/dsh-files.test.mjs',
             'tests/relay-request.test.mjs', 'tests/assistant-resume.test.mjs',
             'tests/project-management.test.mjs', 'tests/app-project-management.test.mjs',
             'tests/dsh-app-tools.test.mjs', 'tests/read-cache.test.mjs', 'tests/dsh-display-cache.test.mjs']
    linux_tests = test_group('linux', tests, 242)
    project_tests = test_group('project-management', ['tests/project-management.test.mjs', 'tests/app-project-management.test.mjs'], 18)
    startup_tests = test_group('startup-cache', ['tests/dsh-app-tools.test.mjs', 'tests/read-cache.test.mjs', 'tests/dsh-display-cache.test.mjs'], 29)
    permission_tests = test_group('runtime-permissions', ['tests/computer-workspace.test.mjs', 'tests/computer-task-lifecycle.test.mjs', 'tests/sandbox-network.test.mjs'], 13)
    pr_tests = test_group('merged-pr-regressions', ['tests/realtime-recovery.test.mjs', 'tests/pi-independent-loading.test.mjs', 'tests/mail.test.mjs', 'tests/dsh-files.test.mjs', 'tests/read-cache.test.mjs'], 1)
    release_tests = test_group('release-regressions', ['tests/app-feature-integration.test.mjs', 'tests/learning-postcheck.test.mjs', 'tests/learning.test.mjs', 'tests/learning-materials.test.mjs', 'tests/learning-answer-rendering.test.mjs', 'tests/conversation-preparation.test.mjs', 'tests/conversation-preparation-lifecycle.test.mjs', 'tests/conversation-preparation-concurrency.test.mjs', 'tests/dsh-extension-api.test.mjs', 'tests/dsh-extensions.test.mjs'], 1)
    logs['native'] = stage / ('release-0820-' + attempt + '-native.log')
    with logs['native'].open('w') as log:
        run(['docker', 'exec', '-e', 'ASTRAL_DSH_WORKBENCH_QA=1', '-e', 'ASTRAL_DSH_EXPECT_REVISION=dsh4',
             anchor, 'node', 'deploy/dsh/workbench-acceptance.mjs'], stdout=log, stderr=subprocess.STDOUT, timeout=420)
    native = json.loads((proof / 'native-workbench.json').read_text())
    assert native['passed'] and native['streamChunks'] > 0 and not native['productionTouched']
    logs['unified'] = stage / ('release-0820-' + attempt + '-unified.log')
    with logs['unified'].open('w') as log:
        run(['docker', 'exec', anchor, 'node', 'deploy/dsh/unified-acceptance.mjs'], stdout=log, stderr=subprocess.STDOUT, timeout=360)
    unified = json.loads((proof / 'unified-native.json').read_text())
    assert unified['passed'] and unified['streamChunks'] > 0 and unified['paidModelCalls'] == 0 and not unified['productionTouched']
    logs['pi'] = stage / ('release-0820-' + attempt + '-pi.log')
    completed = run(['docker', 'run', '--rm', '--init', '--memory=768m', '--cpus=1.5', '--pids-limit=512',
             '--cap-drop=ALL', '--security-opt=no-new-privileges', '--security-opt=seccomp=unconfined',
             '--security-opt=apparmor=unconfined', '-e', 'ASTRAL_RUNTIME_QA=1',
             '--entrypoint=node', images['pi'], '/bridge/verify-runtime.mjs'], capture_output=True, text=True, timeout=420)
    logs['pi'].write_text(completed.stdout + '\n' + completed.stderr)
    pi_proof = json.loads(completed.stdout)
    assert pi_proof['realPiRpcActivation'] and pi_proof['revocationStopsRunningProcess'] and pi_proof['memberIsolation']
    assert all(pi_proof['scheduling'].get(key) is True for key in ['realPinnedCron','actualTimedOccurrence','computerScopePersisted','scopesIsolated','restartWithoutReplay','revocationDisablesPlan'])
    result = {'passed': True, 'source': source, 'images': dict(zip(images, [c['Id'] for c in image_data])),
              'linuxTests': linux_tests, 'nativeChecks': native['checks'],
              'streamChunks': native['streamChunks'] + unified['streamChunks'], 'unifiedChecks': unified['checks'], 'piRuntimePassed': True, 'dependencySetUnchanged': True, 'projectManagementTests': project_tests, 'startupCacheTests': startup_tests,
              'verifierSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'releaseRegressionTests': release_tests, 'mergedPrRegressionTests': pr_tests, 'runtimePermissionTests': permission_tests, 'testCompiler': compiler, 'piBridgeSourceExact': False, 'piUnchangedBridgeFilesExact': True, 'piImageUnchanged': True, 'appRuntimeSourceExact': True,
              'productionTouched': False, 'paidModelCalls': 0}
    (stage / 'acceptance-0.9.1.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
finally:
    for name in [runtime, anchor]:
        target = stage / (name + '.log')
        with target.open('w') as log: subprocess.run(['docker', 'logs', name], stdout=log, stderr=subprocess.STDOUT)
        subprocess.run(['docker', 'stop', '--time', '20', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['docker', 'rm', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
