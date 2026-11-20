"""Guarded 0.9.1 App/Pi learning-tool rollout; retains dsh4 and current SQLite on rollback.

Run on the deployment host only. `status` and `review` read existing state.
`backup`/`switch` explicitly call the native idle verifier, which temporarily
registers and revokes a read client but sends no prompts or tools. No command
installs plugins, modifies independent configuration, or replays user tasks.

Stage contract: source.json {commit,files:{relative_path:sha256}} includes all
runtime and operations inputs; acceptance-0.9.1.json must contain
passed:true, source, linuxTests>0, paidModelCalls:0, productionTouched:false,
nativeChecks, unifiedChecks, streamChunks>0, piRuntimePassed:true,
verifierSha256, images:{app,pi,dsh} (immutable image IDs), and
dependencySetUnchanged:true. Both ingress and Pi are frozen before the final
idle snapshot. Only the verified idle App and Pi are killed while still frozen. This avoids
unfreezing schedulers between the final check and replacement. Any unknown
process, task or cron ledger entry aborts and unfreezes the existing services.
The maintainer creates that proof only after actual isolated image tests.
"""
from pathlib import Path, PurePosixPath
import argparse, datetime, hashlib, json, os, re, shutil, sqlite3, stat, subprocess, tarfile, time, urllib.request

ROOT = Path('/opt/astral-hub')
NAMES = ['astral-hub-app-1', 'astral-hub-dsh-1', 'astral-hub-pi-1']
OLD = ['astral-hub:0.8.20', 'astral-dsh:0.8.12-dsh4', 'astral-pi:1.4.0-v0820-learning1']
NEW = ['astral-hub:0.9.1', OLD[1], 'astral-pi:1.4.0-v0820-learning1']
OLD_IMAGE_IDS = ['sha256:5fb5c2b60b2424fd280928e4f6525787224076ca5462ed1a0333829256f479f1',
                 'sha256:415d6203a155f055907c74d6752b0fccb9b4e29f9a5b62e7e7bc7e60dbf98b39',
                 'sha256:6d44523198fd256c486bcdf03561d6a797c77186e3a0e807613807e12dce7000']
LAYERS = ['compose.0.8.10.yml', 'compose.0.8.10-sandbox.yml', 'compose.0.8.11-relay.yml',
          'compose.0.8.12-dsh.yml', 'compose.0.8.12-dsh2.yml', 'compose.0.8.12-dsh3.yml', 'compose.0.8.12-dsh4.yml', 'compose.0.8.15.yml', 'compose.0.8.15-r1.yml', 'compose.computer-session-recovery.yml', 'compose.0.8.18.yml', 'compose.0.8.19.yml', 'compose.0.8.20.yml']
OVERRIDE = 'compose.0.9.1.yml'
SOURCE_COMMIT = '1bbfcb61ecd1df9b885036ba57bbbb1da3cb6d79'
SOURCE_REPOSITORY = 'https://github.com/yumotu/astral-hub-public'
DSH_IMAGE = 'sha256:415d6203a155f055907c74d6752b0fccb9b4e29f9a5b62e7e7bc7e60dbf98b39'
CONFIGS = ['.env', '.env.example', 'AGENTS.md', 'deploy/pi/projects.json',
           'private/dsh-share/connection.json', 'private/dsh-runtime.env',
           'private/dsh-state/harness/profiles/astral-server/package.json',
           'private/dsh-state/harness/profiles/astral-server/cordis.patch.yml']


def run(args, **kw):
    return subprocess.check_output(args, text=True, **kw)


def load(path):
    return json.loads(path.read_text())


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    path.chmod(0o600)


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def inspect():
    return json.loads(run(['docker', 'inspect', *NAMES]))


def mounted(container, destination):
    return Path(next(m['Source'] for m in container['Mounts'] if m['Destination'] == destination))


def connect(app):
    data = mounted(app, '/app/data')
    db = sqlite3.connect('file:' + str(data / 'astral.sqlite') + '?mode=ro', uri=True)
    db.execute('PRAGMA query_only=ON')
    return db, data


def tables(db):
    return [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def keys(db):
    result = {}
    for table in tables(db):
        columns = [r[1] for r in sorted(db.execute('PRAGMA table_info(' + quote(table) + ')'), key=lambda r: r[5]) if r[5]]
        if not columns:
            continue
        rows = db.execute('SELECT ' + ','.join(map(quote, columns)) + ' FROM ' + quote(table))
        result[table] = {'columns': columns, 'rows': {json.dumps(list(row), ensure_ascii=False) for row in rows}}
    return result


def verify_keys(original, current):
    for table, value in original.items():
        assert table in current, 'Original table missing: ' + table
        assert value['columns'] == current[table]['columns'], 'Original primary key changed: ' + table
        assert value['rows'] <= current[table]['rows'], 'Original rows missing: ' + table
    return {'preservedTables': len(original), 'preservedPrimaryKeys': sum(len(v['rows']) for v in original.values())}


def verify_key_schema(original, current):
    """Ongoing structural health only; never claim old rows still exist.

    Authorized helper expiry and explicit user deletion can remove rows after
    the strict deployment checkpoint. Initial switch and default rollback verification
    continue to call verify_keys, without an exception for TTL records. Only
    explicit current-state rollback after strict acceptance may use schema checks.
    """
    for table, value in original.items():
        assert table in current, 'Original table missing: ' + table
        assert value['columns'] == current[table]['columns'], 'Original primary key changed: ' + table
    return {'primaryKeyStructurePreserved': True, 'checkedTables': len(original),
            'originalRowsCompared': False}


def verify_tool_preferences(db, required=True):
    """Read-only migration verification; rollback may precede schema creation."""
    columns = list(db.execute('PRAGMA table_info(assistant_dsh_tool_preferences)'))
    if not columns:
        assert not required, 'DSH preference migration is missing.'
        return False
    assert [(r[1], r[2], r[3], r[5]) for r in columns] == [
        ('owner', 'TEXT', 1, 1), ('connection_id', 'TEXT', 1, 2),
        ('workspace_id', 'TEXT', 1, 3), ('enabled', 'INTEGER', 1, 0)], 'DSH preference schema differs.'
    assert not db.execute('SELECT 1 FROM assistant_dsh_tool_preferences WHERE enabled IS NULL OR enabled NOT IN (0,1) LIMIT 1').fetchone(), 'DSH preference value differs.'
    return True


def confirmed_control_receipt(row):
    if row['state'] != 'accepted' or row['kind'] not in ['setting-thinking', 'setting-permission']:
        return False
    try:
        value = json.loads(row['result'])
        kind = row['kind'][8:]
        field = 'model' if kind == 'thinking' else 'permissions'
        assert isinstance(value, dict) and set(value) == {field}
        receipt = value[field]
        assert isinstance(receipt, dict)
        selected = receipt['reasoningEffort' if kind == 'thinking' else 'currentValue']
        assert isinstance(selected, str) and 0 < len(selected) <= 300
        assert not any(ord(c) < 32 or ord(c) == 127 for c in selected)
        if kind == 'thinking':
            assert set(receipt) == {'provider', 'model', 'reasoningEffort'}
            assert all(isinstance(receipt[k], str) and 0 < len(receipt[k]) <= 300 for k in ['provider', 'model'])
        else:
            assert set(receipt) <= {'currentValue', 'options'}
            assert re.fullmatch('[a-z0-9]+(?:-[a-z0-9]+)*', selected)
        original = json.dumps({'id': row['id'], 'kind': kind, 'value': selected},
                              separators=(',', ':'), ensure_ascii=False)
        return hashlib.sha256(original.encode()).hexdigest() == row['digest']
    except (KeyError, TypeError, ValueError, AssertionError):
        return False


def confirmed_expired_mail_read(row, now_ms):
    """One reviewed historical query; never settle or alter its unknown journal.

    mail.list has no prepare/send path and uses a read-only IMAP mailbox lock.
    The post-execution context recheck can revoke the task before its result is
    saved. This exact expired receipt has no pending payload or saved result.
    Other unknown reads or writes continue to block; this is not a general
    unknown-state exception. Evidence: production-pending-proof.json.
    """
    expected = {
        'id': 'dee113a5-94fb-441b-8711-4734f928d436', 'name': 'mail.list',
        'state': 'unknown', 'origin': 'dsh',
        'task': 'eeea7a44-ec6e-4411-8303-bbc9a4be4a1b',
        'created': 1794879607732, 'expires': 1794879907732,
        'error': '任务已结束，功能授权已撤销。', 'payload': None, 'result': None,
    }
    return all(row.get(key) == value for key, value in expected.items()) and row['expires'] <= now_ms


def confirmed_stopped_receipt(db, row, now_ms):
    """A stop admission needs a later terminal event and no active projection.

    The runtime observes prompt/respond receipts but leaves stop as accepted;
    only a newer turn/end clears its stop_cursor. This read-only interpretation
    never marks an operation observed, and the separate native_idle verifier is
    still mandatory before backup/switch, including while App/Pi are frozen.
    """
    if row['kind'] != 'stop' or row['state'] != 'accepted':
        return False
    try:
        receipt = json.loads(row['result'])
        assert isinstance(receipt, dict) and set(receipt) == {'accepted'} and receipt['accepted'] is True
        assert re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', row['id'])
        original = json.dumps({'id': row['id']}, separators=(',', ':'))
        assert hashlib.sha256(original.encode()).hexdigest() == row['digest']
        assert re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', row['created_at'])
        created = datetime.datetime.fromisoformat(row['created_at'].replace('Z', '+00:00')).timestamp() * 1000
        assert 0 < created <= now_ms
        conversation = db.execute(
            'SELECT state,snapshot,stop_cursor FROM dsh_conversations WHERE owner=? AND id=?',
            (row['owner'], row['conversation_id'])).fetchone()
        assert conversation and conversation[0] == 'ready' and conversation[2] is None
        state = json.loads(conversation[1])
        assert isinstance(state, dict) and state.get('assistant') is None
        projections = state.get('projections', {})
        assert isinstance(projections, dict) and not projections.get('inbox')
        boundary = projections.get('turnBoundary')
        assert boundary is None or (isinstance(boundary, dict) and boundary.get('openTurnStartSeq') is None)
        interactions = state.get('interactions', [])
        assert isinstance(interactions, list) and all(isinstance(item, dict) and not item.get('answerable') for item in interactions)
        events = state['events']
        assert isinstance(events, list) and all(isinstance(event, dict) for event in events)
        seqs = [event['seq'] for event in events]
        assert all(type(seq) is int and seq >= 0 for seq in seqs)
        assert all(left < right for left, right in zip(seqs, seqs[1:]))
        terminal = next((event for event in reversed(events) if event.get('type') in ['turn/start', 'turn/end']), None)
        assert terminal and terminal['type'] == 'turn/end'
        assert type(terminal['time']) is int and created < terminal['time'] <= now_ms
        assert type(state['cursor']) is int and state['cursor'] >= terminal['seq']
        return True
    except (KeyError, TypeError, ValueError, AssertionError):
        return False


def activity(db, now_ms=None):
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    queries = {
        'pi': "SELECT count(*) FROM pi_tasks WHERE json_extract(state,'$.status') IS NULL OR json_extract(state,'$.status') NOT IN ('done','error','cancelled','interrupted')",
        'computer': "SELECT count(*) FROM relay_jobs WHERE status IS NULL OR status NOT IN ('done','error','cancelled','interrupted')",
        'operations': "SELECT count(*) FROM relay_operations WHERE status IS NULL OR status NOT IN ('done','error','cancelled','interrupted')",
        'terminals': "SELECT count(*) FROM relay_terminals WHERE status IS NULL OR status NOT IN ('closed','error','cancelled','interrupted')",
        'learning': "SELECT count(*) FROM learning_lessons WHERE status IS NULL OR status NOT IN ('ready','error')",
        'grading': "SELECT count(*) FROM learning_attempts WHERE status IS NULL OR status NOT IN ('done','error')",
        'functions': "SELECT count(*) FROM app_function_calls WHERE state IS NULL OR state NOT IN ('prepared','done','error','denied')",
        # Acceptance only acknowledges admission, not a native receipt or turn
        # completion. Never clear uncertain historical actions to force idle.
        'dshActions': "SELECT count(*) FROM dsh_actions WHERE state IS NULL OR state NOT IN ('observed','rejected')",
    }
    result = {key: db.execute(sql).fetchone()[0] for key, sql in queries.items()}
    # Workbench setting calls return a fully validated native receipt rather than
    # a future message event. Their journal remains 'accepted' in the current
    # runtime. Verify that exact receipt against the original request digest;
    # never rewrite it, and never exempt prompts, unknowns or mere acceptance.
    function_columns = ['id', 'name', 'state', 'origin', 'task', 'created', 'expires', 'error', 'payload', 'result']
    result['functions'] = sum(not confirmed_expired_mail_read(dict(zip(function_columns, row)), now_ms)
        for row in db.execute('SELECT ' + ','.join(function_columns) +
            " FROM app_function_calls WHERE state IS NULL OR state NOT IN ('prepared','done','error','denied')"))
    action_columns = ['id', 'kind', 'state', 'digest', 'result', 'owner', 'conversation_id', 'created_at']
    result['dshActions'] = 0
    for record in db.execute('SELECT ' + ','.join(action_columns) +
            " FROM dsh_actions WHERE state IS NULL OR state NOT IN ('observed','rejected')"):
        row = dict(zip(action_columns, record))
        if not confirmed_control_receipt(row) and not confirmed_stopped_receipt(db, row, now_ms):
            result['dshActions'] += 1
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_switches'").fetchone():
        result['unifiedOperations'] = db.execute("SELECT count(*) FROM assistant_switches WHERE state IS NULL OR state<>'done'").fetchone()[0]
    # This table was added by 0.8.15. Rows exist only while a native helper
    # operation is pending or its outcome is unknown; no idle snapshot or
    # later successful request may settle it. Older deployments lack the table.
    helper_table = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pi_assistance_operations'").fetchone()
    result['helperOperations'] = db.execute('SELECT count(*) FROM pi_assistance_operations').fetchone()[0] if helper_table else 0
    # Direct mail API sends need not have an Agent task. Only an unsent preview
    # or a confirmed sent receipt is quiescent; unknown outcomes remain blocked
    # even after a restart. Do not settle, expire or rewrite send records here.
    for table, field, allowed in [
        ('mail_reply_sends', 'mailReplies', "('sent')"),
        ('mail_send_confirmations', 'mailCompositions', "('prepared','sent')"),
    ]:
        exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
        result[field] = db.execute('SELECT count(*) FROM ' + table +
            ' WHERE state IS NULL OR state NOT IN ' + allowed).fetchone()[0] if exists else 0
    # A deletion intent remains until filesystem removal and metadata cleanup
    # finish together. Any retained row blocks replacement; the guard must not
    # settle a failed or interrupted cleanup merely to make deployment idle.
    deletion_table = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pi_file_deletions'").fetchone()
    result['fileDeletions'] = db.execute('SELECT count(*) FROM pi_file_deletions').fetchone()[0] if deletion_table else 0
    result['dsh'] = 0
    result['dsh'] += db.execute("SELECT count(*) FROM dsh_conversations WHERE state IS NULL OR state <> 'ready'").fetchone()[0]
    for snapshot, cursor in db.execute("SELECT snapshot,stop_cursor FROM dsh_conversations WHERE state='ready'"):
        state = json.loads(snapshot)
        events = state.get('events', [])
        last = next((e['type'] for e in reversed(events) if e['type'] in ['turn/start', 'turn/end']), None)
        p = state.get('projections', {})
        if cursor is not None or last == 'turn/start' or state.get('assistant') or (p.get('turnBoundary') or {}).get('openTurnStartSeq') is not None or p.get('inbox') or any(i.get('answerable') for i in state.get('interactions', [])):
            result['dsh'] += 1
    return result


def independent():
    return {name: sha(ROOT / name) for name in CONFIGS}


def policies(container):
    return {
        'mounts': sorted([[m['Source'], m['Destination'], m['RW']] for m in container['Mounts']]),
        'env': sorted(container['Config']['Env']),
        **{k: container['HostConfig'].get(k) for k in [
            'ReadonlyRootfs', 'Memory', 'MemorySwap', 'PidsLimit', 'NanoCpus', 'CapDrop', 'CapAdd',
            'SecurityOpt', 'PortBindings', 'RestartPolicy', 'Init', 'Tmpfs', 'LogConfig', 'Devices']},
    }


def plugin_digest(pi):
    root = mounted(pi, '/home/node/.pi') / 'agent/astral/packages'
    digest = hashlib.sha256()
    count = 0
    if not root.exists():
        return {'files': 0, 'sha256': digest.hexdigest()}
    for item in sorted(root.rglob('*')):
        name = item.relative_to(root).as_posix()
        if item.is_symlink():
            digest.update(('L:' + name + ':' + os.readlink(item)).encode())
        elif item.is_file():
            digest.update(('F:' + name + ':' + sha(item)).encode())
            count += 1
    return {'files': count, 'sha256': digest.hexdigest()}


def pi_durable_state(pi, require_idle=True):
    """Read grants and logical cron records; never edit journals to force idle."""
    home = mounted(pi, '/home/node/.pi') / 'agent/astral'
    result = {'grants': {}, 'cron': {}}
    for name in ['projects.json', 'projects.json.members.json', 'plugin-state/owners.json']:
        path = home / name
        assert not path.is_symlink(), 'Pi durable metadata must not be a symlink.'
        result['grants'][name] = sha(path) if path.exists() else None
    root = home / 'plugin-state'
    if root.exists():
        assert not root.is_symlink()
        for path in sorted(root.rglob('astral-runs.sqlite')):
            assert not path.is_symlink() and path.resolve().is_relative_to(root.resolve())
            db = sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True)
            try:
                db.execute('PRAGMA query_only=ON')
                assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
                runs = {row[0]: list(row[1:]) for row in db.execute('SELECT id,job_id,slot,payload,state FROM runs')}
                if require_idle:
                    assert all(json.loads(value[-1]).get('status') in ['done','error','cancelled','interrupted'] for value in runs.values()), 'Pi scheduled work is active or unknown.'
                contexts = {row[0]: row[1] for row in db.execute('SELECT job_id,context FROM contexts')}
                result['cron'][path.relative_to(home).as_posix()] = {'runs': runs, 'contexts': contexts}
            finally:
                db.close()
    return result


def verify_pi_durable(original, current):
    assert current['grants'] == original['grants'], 'Pi project grants or cron ownership changed.'
    for name, before in original['cron'].items():
        assert name in current['cron'], 'Original Pi scheduling ledger missing.'
        after = current['cron'][name]
        for table in ['runs', 'contexts']:
            assert all(key in after[table] and after[table][key] == value for key, value in before[table].items()), 'Original Pi scheduling records changed.'
    return {'piGrantsPreserved': True, 'piCronRecordsPreserved': True, 'piCronLedgers': len(original['cron'])}


def health():
    return json.load(urllib.request.urlopen('http://127.0.0.1:8787/api/health', timeout=10))


def native_health(via_app=False):
    script = "const r=await fetch('http://127.0.0.1:8972/health');if(!r.ok)throw Error('health');const d=await r.json();console.log(JSON.stringify(Object.fromEntries(['ok','version','revision','deviceId','fingerprint','fileBridgeVersion','workbenchVersion','extensionManagerVersion'].map(k=>[k,d[k]]))))"
    return json.loads(run(['docker', 'exec', NAMES[0] if via_app else NAMES[1], 'node', '--input-type=module', '-e', script]))


def pi_idle():
    script = "const r=await fetch('http://127.0.0.1:8790/health',{headers:{Authorization:'Bearer '+process.env.PI_BRIDGE_TOKEN}});if(!r.ok)throw Error('Pi health');const d=await r.json();console.log(JSON.stringify({ready:d.ready,runningCount:d.runningCount,pluginReady:d.pluginActivation?.ready,checking:d.pluginActivation?.checking}));if(d.runningCount!==0)process.exitCode=1"
    return json.loads(run(['docker', 'exec', NAMES[2], 'node', '--input-type=module', '-e', script]))


def pi_processes(text):
    """Fail closed without printing command arguments, which may contain secrets."""
    result = {'container-init': 0, 'bridge': 0, 'cron-host': 0}
    for line in text.splitlines()[1:]:
        parts = line.strip().split(None, 3)
        assert len(parts) == 4, 'Unrecognized frozen Pi process row.'
        args = parts[3]
        if re.fullmatch(r'(?:/sbin/)?docker-init -- (?:docker-entrypoint\.sh )?node bridge\.mjs', args):
            kind = 'container-init'
        elif re.fullmatch(r'(?:/usr/local/bin/)?node bridge\.mjs', args):
            kind = 'bridge'
        elif re.fullmatch(r'(?:/usr/local/bin/)?node /bridge/cron-host\.mjs', args):
            kind = 'cron-host'
        else:
            raise AssertionError('Frozen Pi contains a worker or unknown process; resume it and wait.')
        result[kind] += 1
    assert result['container-init'] == 1 and result['bridge'] == 1
    assert result['cron-host'] <= 10
    return result


def cron_idle(pi):
    root = mounted(pi, '/home/node/.pi') / 'agent/astral/plugin-state'
    result = {'ledgers': 0, 'pending': 0}
    if not root.exists():
        return result
    assert not root.is_symlink()
    for path in root.rglob('astral-runs.sqlite'):
        assert not path.is_symlink() and all(not (root / p).is_symlink() for p in path.relative_to(root).parents)
        path.resolve().relative_to(root.resolve())
        db = sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True)
        try:
            db.execute('PRAGMA query_only=ON')
            pending = db.execute("SELECT count(*) FROM runs WHERE json_extract(state,'$.status') IS NULL OR json_extract(state,'$.status') NOT IN ('done','error','cancelled','interrupted')").fetchone()[0]
        finally:
            db.close()
        result['ledgers'] += 1
        result['pending'] += pending
    assert result['ledgers'] <= 10
    assert result['pending'] == 0, 'Pi has pending or unknown scheduled work; resume it and wait.'
    return result


def frozen_pi_idle(pi):
    assert pi['State']['Running'] and pi['State']['Paused'], 'Pi must remain frozen for the final snapshot.'
    processes = pi_processes(run(['docker', 'top', NAMES[2], '-eo', 'pid,ppid,comm,args']))
    cron = cron_idle(pi)
    assert processes['cron-host'] <= cron['ledgers'], 'A frozen cron host has no readable durable ledger.'
    return {'processes': processes, **cron}


def native_idle(stage, frozen=False, app=None):
    script = stage / 'deploy/dsh/idle-native.mjs'
    # The managed runtime can remain in an older namespace after an App
    # restart while its own health still passes. Read its actual namespace
    # directly, without restarting it or treating unreachable as idle.
    image = app['Image'] if app else inspect()[0]['Image']
    args = ['docker', 'run', '--rm', '-i', '--init', '--read-only',
            '--network=container:' + NAMES[1], '--memory=192m', '--pids-limit=64',
            '--cap-drop=ALL', '--security-opt=no-new-privileges',
            '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m',
            '-e', 'DSH_MANAGED_CONFIG=/run/connection.json',
            '-v', str(ROOT / 'private/dsh-share/connection.json') + ':/run/connection.json:ro',
            '--entrypoint=node', image, '--input-type=module']
    with script.open() as source:
        value = subprocess.run(args, stdin=source, text=True, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, check=True, timeout=45)
    proof = json.loads(value.stdout)
    assert proof['nativeActive'] == 0 and proof['modelRequests'] == 0
    return proof


def idle(stage, frozen=False, app=None):
    containers = inspect()
    if frozen:
        assert containers[0]['State']['Paused'] and containers[2]['State']['Paused']
    db, _ = connect(containers[0])
    value = activity(db)
    db.close()
    assert not any(value.values()), json.dumps({'waitForTasks': value})
    return {'activity': value, 'pi': frozen_pi_idle(containers[2]) if frozen else pi_idle(),
            'native': native_idle(stage, frozen, app)}


def freeze(stage, containers, paused):
    # App owns ingress and dispatch. Freeze it first, verify the still-running
    # bridge, then freeze all Pi processes, including persistent cron hosts.
    subprocess.run(['docker', 'pause', NAMES[0]], check=True)
    paused.add(NAMES[0])
    pi_idle()
    subprocess.run(['docker', 'pause', NAMES[2]], check=True)
    paused.add(NAMES[2])
    return idle(stage, frozen=True, app=containers[0])


def resume(paused):
    for name in [NAMES[2], NAMES[0]]:
        if name in paused:
            subprocess.run(['docker', 'unpause', name], check=True)
            paused.remove(name)


def stop_frozen(paused):
    # docker stop unfreezes a paused service before delivering SIGTERM. That
    # creates a cron/dispatch race. Terminate only the certified idle snapshot
    # without thawing either process tree. Durable ledgers/volumes are retained.
    containers = inspect()
    assert all(containers[n]['State']['Paused'] for n in [0, 2])
    # Stop ingress first, then the certified-idle Pi without thawing cron hosts.
    for name in [NAMES[0], NAMES[2]]:
        assert name in paused
        subprocess.run(['docker', 'kill', '--signal=KILL', name], check=True)
        paused.remove(name)


def compose(override=None):
    args = ['docker', 'compose', '--project-name', 'astral-hub', '--env-file', str(ROOT / '.env')]
    for layer in LAYERS:
        args += ['-f', str(ROOT / 'deploy' / layer)]
    if override:
        args += ['-f', str(override)]
    return args


def accepted(stage):
    stage = Path(stage)
    assert not stage.is_symlink() and stage.is_dir(), 'Stage must be a real directory.'
    stage = stage.resolve()
    manifest_path = stage / 'source.json'
    assert not manifest_path.is_symlink() and manifest_path.is_file(), 'Source manifest must be a regular file.'
    manifest = load(manifest_path)
    source = manifest['commit']
    assert re.fullmatch('[0-9a-f]{40}', SOURCE_COMMIT), 'Pin the reviewed runtime source before rollout.'
    assert source == SOURCE_COMMIT
    assert manifest.get('repository') == SOURCE_REPOSITORY and manifest.get('publicCommit') == source, 'Use the exact reviewed public source, never private history.'
    files = manifest['files']
    assert isinstance(files, dict) and files, 'Source manifest must include every runtime input.'
    for name, digest in files.items():
        assert isinstance(name, str) and name and '\\' not in name and not any(ord(c) < 32 or ord(c) == 127 for c in name), 'Unsafe source path.'
        relative = PurePosixPath(name)
        assert not relative.is_absolute() and '..' not in relative.parts and relative.as_posix() == name, 'Unsafe source path: ' + name
        assert isinstance(digest, str) and re.fullmatch('[0-9a-f]{64}', digest), 'Invalid source digest: ' + name
        target = stage / name
        for component in [target, *target.parents]:
            if component == stage:
                break
            assert not component.is_symlink(), 'Symlink in source path: ' + name
        assert target.is_file() and stat.S_ISREG(target.stat().st_mode), 'Missing/non-regular source file: ' + name
        assert target.resolve().is_relative_to(stage), 'Source file escapes stage: ' + name
        assert sha(target) == digest, 'Source file hash mismatch: ' + name
    required = ['package.json', 'package-lock.json', 'deploy/dsh/idle-native.mjs',
                'deploy/preflight-0.9.1.py', 'deploy/rollout-0.9.1.py',
                'deploy/Dockerfile.0.9.1-app', 'deploy/Dockerfile.0.9.1-app.dockerignore',
                'deploy/pi/assistant-artifacts.mjs', 'deploy/pi/app-tools.mjs', 'deploy/pi/rpc-worker.mjs']
    assert all(name in files for name in required), 'Runtime/operations source coverage incomplete.'
    for prefix in ['server', 'shared', 'dist']:
        directory = stage / prefix
        assert directory.is_dir() and not directory.is_symlink(), 'Runtime tree missing: ' + prefix
        actual = set()
        for target in directory.rglob('*'):
            name = target.relative_to(stage).as_posix()
            assert not target.is_symlink(), 'Symlink in runtime tree: ' + name
            if target.is_dir():
                continue
            assert target.is_file() and stat.S_ISREG(target.stat().st_mode), 'Non-regular runtime entry: ' + name
            actual.add(name)
        assert actual and actual == {name for name in files if name.startswith(prefix + '/')}, 'Runtime manifest coverage mismatch: ' + prefix
    proof = load(stage / 'acceptance-0.9.1.json')
    assert proof['passed'] is True and proof['source'] == source and proof['linuxTests'] >= 242 and proof['projectManagementTests'] == 18 and proof['startupCacheTests'] >= 29 and proof['runtimePermissionTests'] >= 20 and proof['releaseRegressionTests'] >= 98
    assert type(proof['mergedPrRegressionTests']) is int and proof['mergedPrRegressionTests'] >= 77, 'Merged PR regression proof is incomplete.'
    compiler = load(stage / 'package-lock.json')['packages']['node_modules/typescript']
    assert compiler['version'] == '5.9.3' and compiler.get('dev') is True, 'Use the reviewed disposable test compiler.'
    assert compiler['resolved'] == 'https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz'
    assert compiler['integrity'] == 'sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw=='
    assert proof['testCompiler'] == {'version':compiler['version'], 'source':compiler['resolved'], 'integrity':compiler['integrity']}, 'Test compiler receipt differs from reviewed source lock.'
    assert proof['dependencySetUnchanged'] is True and proof['paidModelCalls'] == 0 and proof['productionTouched'] is False
    assert proof['piRuntimePassed'] is True and proof['streamChunks'] > 0
    for key in ['nativeChecks', 'unifiedChecks']:
        assert isinstance(proof[key], list) and len(proof[key]) >= 4
        assert all(isinstance(item, str) and item.strip() for item in proof[key])
        assert len(set(proof[key])) == len(proof[key])
    assert proof['verifierSha256'] == sha(stage / 'deploy/preflight-0.9.1.py')
    images = json.loads(run(['docker', 'image', 'inspect', *NEW]))
    assert [i['Id'] for i in images] == [proof['images'][k] for k in ['app', 'dsh', 'pi']]
    assert images[0]['Config']['Labels'].get('org.opencontainers.image.revision') == source
    assert images[1]['Id'] == DSH_IMAGE, 'Only the reviewed dsh4 image may be deployed.'
    assert images[2]['Config']['Labels'].get('org.opencontainers.image.revision') == 'd10b1f822c9ea6a9f54e96ce926ab334e3523515'
    assert images[2]['Config']['Labels'].get('org.opencontainers.image.base.digest') == 'sha256:14fbdbf68f57e67a844802751c6b1749bcfd01c0f0adf8569ce3923a820c12c6'
    assert images[0]['Config']['Labels'].get('org.opencontainers.image.base.digest') == OLD_IMAGE_IDS[0]
    assert proof['appRuntimeSourceExact'] is True
    assert proof['piBridgeSourceExact'] is False and proof['piUnchangedBridgeFilesExact'] is True
    return proof


def snapshot(db, destination):
    assert not destination.exists(), 'Never replace a prior deployment snapshot.'
    with sqlite3.connect(destination) as target:
        db.backup(target)
        assert target.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
        assert not target.execute('PRAGMA foreign_key_check').fetchall()
    destination.chmod(0o600)


def archive(source, destination):
    with tarfile.open(destination, 'w:gz') as output:
        output.add(source, arcname=source.name, recursive=True)
    destination.chmod(0o600)


def backup(stage):
    proof = accepted(stage)
    containers = inspect()
    assert [c['Config']['Image'] for c in containers] == OLD
    assert [c['Image'] for c in containers] == OLD_IMAGE_IDS, 'Production baseline changed; review the actual images before rollout.'
    assert containers[1]['Image'] == proof['images']['dsh'], 'Never replace dsh4 in this rollout.'
    checks = idle(stage)
    db, data = connect(containers[0])
    target = ROOT / 'backups' / ('before-0.9.1-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    target.mkdir(mode=0o700)
    snapshot(db, target / 'astral.sqlite')
    state = {'images': [c['Image'] for c in containers], 'policies': [policies(c) for c in containers],
             'independent': independent(), 'plugins': plugin_digest(containers[2]),
             'native': native_health(), 'updates': sha(data / 'private/updates/manifest.json'),
             'idle': checks, 'dataPath': str(data)}
    save(target / 'before.json', state)
    save(target / 'containers.json', containers)
    for name in CONFIGS + ['deploy/' + n for n in LAYERS]:
        dest = target / 'configs' / name
        dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, dest)
        dest.chmod(0o600)
    shutil.copy2(data / 'private/updates/manifest.json', target / 'manifest.before.json')
    # Complete mutable native state is preserved for investigation, never
    # automatically extracted over live state during rollback.
    archive(ROOT / 'private/dsh-state', target / 'dsh-state.before.tgz')
    archive(mounted(containers[2], '/home/node/.pi'), target / 'pi-home.before.tgz')
    (target / 'COMPLETE').write_text('Original images, SQLite, native state and independent configuration retained.\n')
    print(json.dumps({'backup': str(target), 'checks': checks, 'databaseRestored': False}))


def preserved(target, allow_updated_manifest=False, compare_original_rows=True, require_preference_schema=True, expected_pi_image=None, durable_snapshot=None):
    assert expected_pi_image, 'Bind preservation checks to the exact target Pi image.'
    before = load(target / 'before.json')
    containers = inspect()
    if compare_original_rows or durable_snapshot is not None:
        durable_proof = verify_pi_durable(load(durable_snapshot or target / 'pi-durable.at-switch.json'), pi_durable_state(containers[2]))
    else:
        pi_durable_state(containers[2], require_idle=False)
        durable_proof = {'piDurableStructureVerified': True, 'piDurableRecordsCompared': False}
    assert independent() == before['independent'], 'Independent configuration changed.'
    assert plugin_digest(containers[2]) == before['plugins'], 'User plugin files changed.'
    assert [policies(c) for c in containers] == before['policies'], 'Mounts, environment or resource limits changed.'
    assert containers[1]['HostConfig']['NetworkMode'] == 'container:' + containers[0]['Id']
    namespaces = [os.readlink('/proc/' + str(c['State']['Pid']) + '/ns/net') for c in containers[:2]]
    assert namespaces[0] == namespaces[1], 'App and DSH must share their actual running network namespace.'
    assert containers[1]['Image'] == before['images'][1], 'dsh4 image changed.'
    assert containers[2]['Image'] == expected_pi_image, 'Pi image differs from the reviewed target.'
    assert all(c['State'].get('Health', {}).get('Status') == 'healthy' for c in containers)
    db, data = connect(containers[0])
    assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
    assert not db.execute('PRAGMA foreign_key_check').fetchall()
    original = sqlite3.connect('file:' + str(target / 'at-switch.sqlite') + '?mode=ro', uri=True)
    key_proof = (verify_keys if compare_original_rows else verify_key_schema)(keys(original), keys(db))
    preference_verified = verify_tool_preferences(db, required=require_preference_schema)
    original.close()
    db.close()
    if not allow_updated_manifest:
        assert sha(data / 'private/updates/manifest.json') == before['updates']
    native = native_health(via_app=True)
    assert all(native[k] == before['native'][k] for k in ['deviceId', 'fingerprint', 'revision', 'fileBridgeVersion', 'workbenchVersion', 'extensionManagerVersion'])
    assert native['revision'] == 'dsh4'
    return {**key_proof, **durable_proof, 'independentConfigurationPreserved': True, 'pluginsPreserved': True,
            'piImageVerified': True, 'piReplaced': containers[2]['Id'] != load(target / 'containers.json')[2]['Id'],
            'mountsAndResourcesPreserved': True, 'dsh4Preserved': True, 'dshPreferenceSchemaVerified': preference_verified, 'database': 'ok'}


def wait(expected, version):
    for _ in range(180):
        try:
            containers = inspect()
            if [c['Image'] for c in containers] == expected and all(c['State'].get('Health', {}).get('Status') == 'healthy' for c in containers) and health()['version'] == version:
                check = pi_idle()
                if check['ready'] and check['pluginReady'] and not check['checking']:
                    return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError('Services or plugin activation failed health checks; inspect actual state before any retry.')


def write_override(path, images):
    with path.open('x') as output:
        output.write('services:\n' + ''.join('  ' + service + ':\n    image: ' + image + '\n' for service, image in zip(['app', 'dsh', 'pi'], images)))
    path.chmod(0o600)


def start(override):
    for service in ['pi', 'app', 'dsh']:
        subprocess.run(compose(override) + ['up', '-d', '--no-deps', '--no-build', '--force-recreate', service], cwd=ROOT, check=True)


def strict_deployment_checkpoint(target, proof):
    """Require the recorded strict switch before a later structural-only check."""
    initial = load(target / 'deployed.json')
    assert initial['passed'] is True and initial['source'] == proof['source']
    assert initial['images'] == proof['images']
    assert initial['preservedTables'] > 0 and initial['preservedPrimaryKeys'] >= 0
    assert (target / 'DEPLOYED').is_file(), 'Strict deployment acceptance is missing.'
    return initial


def rollback(target, stage, current_state_mode=False):
    # Automatic recovery and ordinary rollback retain the strict original-row
    # gate. Later authorized TTL/user deletion may use a separate explicit mode,
    # but only after the original switch was strictly accepted.
    if current_state_mode:
        strict_deployment_checkpoint(target, accepted(stage))
    before = load(target / 'before.json')
    assert independent() == before['independent']
    containers = inspect()
    db, _ = connect(containers[0])
    assert not any(activity(db).values()), 'Wait for active/unknown tasks before rollback.'
    db.close()
    # Healthy services still need the actual native idle check. Broken services
    # do not count as idle: the final freeze gate below must also succeed.
    if containers[0]['State'].get('Health', {}).get('Status') == 'healthy' and containers[1]['State'].get('Health', {}).get('Status') == 'healthy':
        idle(stage)
    paused = set()
    try:
        # Fail closed if a broken service cannot prove its true idle state;
        # do not equate an unavailable bridge with an empty task queue.
        freeze(stage, containers, paused)
        durable_snapshot = target / ('pi-durable.before-rollback-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ') + '.json')
        save(durable_snapshot, pi_durable_state(containers[2]))
        stop_frozen(paused)
        subprocess.run(['docker', 'stop', '--time', '20', NAMES[1]], check=True)
        override = target / 'rollback-images.yml'
        if override.exists():
            assert load(target / 'rollback-images-proof.json') == before['images']
        else:
            write_override(override, before['images'])
            save(target / 'rollback-images-proof.json', before['images'])
        start(override)
    finally:
        resume(paused)
    wait(before['images'], '0.8.20')
    result = preserved(target, allow_updated_manifest=True, compare_original_rows=not current_state_mode, require_preference_schema=False, expected_pi_image=before['images'][2], durable_snapshot=durable_snapshot)
    if current_state_mode:
        result.update(scope='current-state-rollback-after-strict-deployment', strictDeploymentCheckpoint=True)
    save(target / 'rollback.json', {'returnedTo': '0.8.20', 'databaseRestored': False, **result})
    print(json.dumps({'rolledBack': True, 'databaseRestored': False, **result}))


def review(target, stage, allow_updated_manifest=False):
    proof = accepted(stage)
    containers = inspect()
    assert [c['Image'] for c in containers] == [proof['images'][k] for k in ['app', 'dsh', 'pi']]
    assert health()['version'] == '0.9.1'
    return {'passed': True, 'version': '0.9.1', 'source': proof['source'],
            'images': proof['images'], **preserved(target, allow_updated_manifest, expected_pi_image=proof['images']['pi'])}


def current_state(target, stage, allow_updated_manifest=False):
    """Read current health after a recorded strict deployment acceptance.

    This is intentionally a separate operation from review: it verifies image,
    configuration and database structure, but not an old primary-key subset.
    TTL expiry and explicit user operations are not rollout data loss proofs.
    """
    proof = accepted(stage)
    strict_deployment_checkpoint(target, proof)
    containers = inspect()
    assert [c['Image'] for c in containers] == [proof['images'][k] for k in ['app', 'dsh', 'pi']]
    assert health()['version'] == '0.9.1'
    return {'passed': True, 'version': '0.9.1', 'source': proof['source'],
            'images': proof['images'], 'scope': 'current-state-after-strict-deployment',
            'strictDeploymentCheckpoint': True,
            **preserved(target, allow_updated_manifest, compare_original_rows=False, expected_pi_image=proof['images']['pi'])}


def switch(target, stage):
    assert (target / 'COMPLETE').exists()
    assert not (target / 'SWITCH_ATTEMPTED').exists(), 'Inspect the prior switch; do not blindly repeat.'
    proof = accepted(stage)
    before = load(target / 'before.json')
    containers = inspect()
    assert [c['Image'] for c in containers] == before['images']
    assert [c['Image'] for c in containers] == OLD_IMAGE_IDS
    assert independent() == before['independent'] and plugin_digest(containers[2]) == before['plugins']
    idle(stage)
    paused = set()
    attempted = False
    try:
        checks = freeze(stage, containers, paused)
        db, _ = connect(containers[0])
        snapshot(db, target / 'at-switch.sqlite')
        db.close()
        save(target / 'pi-durable.at-switch.json', pi_durable_state(containers[2]))
        save(target / 'at-switch.json', {'source': proof['source'], 'checks': checks})
        override = ROOT / 'deploy' / OVERRIDE
        assert not override.exists(), 'Inspect existing override; do not replace it.'
        write_override(override, NEW)
        (target / 'SWITCH_ATTEMPTED').write_text('Inspect actual containers before any retry. Never replay unknown operations.\n')
        attempted = True
        stop_frozen(paused)
        subprocess.run(['docker', 'stop', '--time', '20', NAMES[1]], check=True)
        archive(ROOT / 'private/dsh-state', target / 'dsh-state.at-switch.tgz')
        start(override)
        resume(paused)
        wait([proof['images'][k] for k in ['app', 'dsh', 'pi']], '0.9.1')
        result = review(target, stage)
        save(target / 'deployed.json', result)
        (target / 'DEPLOYED').write_text('0.9.1 App/Pi healthy, original grants/plugins/scheduling and dsh4/current user data preserved.\n')
        print(json.dumps(result))
    except BaseException:
        resume(paused)
        if attempted:
            # Automatic rollback only if no new/unknown tasks were accepted.
            # rollback() fails closed rather than terminating new user work.
            rollback(target, stage)
        raise
    finally:
        resume(paused)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['status', 'backup', 'switch', 'review', 'current-status', 'rollback'])
    parser.add_argument('paths', nargs='*', type=Path)
    parser.add_argument('--allow-updated-manifest', action='store_true')
    parser.add_argument('--current-state', action='store_true',
                        help='Rollback only: require strict deployment receipt and check current key structure instead of old rows.')
    args = parser.parse_args()
    if args.current_state and args.operation != 'rollback':
        parser.error('--current-state is only valid for explicit rollback.')
    if args.operation == 'status':
        containers = inspect()
        db, _ = connect(containers[0])
        print(json.dumps({'images': [c['Config']['Image'] for c in containers], 'version': health()['version'], 'activity': activity(db)}))
        db.close()
    elif args.operation == 'backup' and len(args.paths) == 1:
        backup(args.paths[0].resolve())
    elif len(args.paths) == 2:
        target, stage = map(Path.resolve, args.paths)
        if args.operation == 'switch':
            switch(target, stage)
        elif args.operation == 'rollback':
            rollback(target, stage, current_state_mode=args.current_state)
        elif args.operation == 'review':
            print(json.dumps(review(target, stage, args.allow_updated_manifest)))
        elif args.operation == 'current-status':
            print(json.dumps(current_state(target, stage, args.allow_updated_manifest)))
        else:
            parser.error('Invalid arguments.')
    else:
        parser.error('backup requires STAGE; switch/review/rollback require BACKUP STAGE.')


if __name__ == '__main__':
    main()
