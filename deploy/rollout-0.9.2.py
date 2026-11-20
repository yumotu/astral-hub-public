"""Guarded App/DSH-only 0.9.2 rollout.

The script records a read-only baseline, replaces only the App and the DSH
sidecar that shares the App network namespace, and leaves Pi, data volumes,
plugins, credentials, and independent configuration in place. It refuses to
switch while any tracked operation is active or unknown.
"""
from pathlib import Path
import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import time
import urllib.request

ROOT = Path('/opt/astral-hub')
NAMES = ['astral-hub-app-1', 'astral-hub-dsh-1', 'astral-hub-pi-1']
OLD = ['astral-hub:0.9.1', 'astral-dsh:0.8.12-dsh4', 'astral-pi:1.4.0-v0820-learning1']
NEW = ['astral-hub:0.9.2', OLD[1], OLD[2]]
OLD_IDS = [
    'sha256:b7bc939ee56c327dfbafa40adc26952d8529850684e2ad715f0a39580b1301ce',
    'sha256:415d6203a155f055907c74d6752b0fccb9b4e29f9a5b62e7e7bc7e60dbf98b39',
    'sha256:6d44523198fd256c486bcdf03561d6a797c77186e3a0e807613807e12dce7000',
]
LAYERS = [
    'compose.0.8.10.yml', 'compose.0.8.10-sandbox.yml',
    'compose.0.8.11-relay.yml', 'compose.0.8.12-dsh.yml',
    'compose.0.8.12-dsh2.yml', 'compose.0.8.12-dsh3.yml',
    'compose.0.8.12-dsh4.yml', 'compose.0.8.15.yml',
    'compose.0.8.15-r1.yml', 'compose.computer-session-recovery.yml',
    'compose.0.8.18.yml', 'compose.0.8.19.yml', 'compose.0.8.20.yml',
]
OVERRIDE = ROOT / 'deploy' / 'compose.0.9.2.yml'


def run(args, **kwargs):
    return subprocess.check_output(args, text=True, **kwargs)


def inspect():
    return json.loads(run(['docker', 'inspect', *NAMES]))


def mounted(container, destination):
    return Path(next(item['Source'] for item in container['Mounts'] if item['Destination'] == destination))


def db_for(container):
    data = mounted(container, '/app/data')
    db = sqlite3.connect('file:' + str(data / 'astral.sqlite') + '?mode=ro', uri=True)
    db.execute('PRAGMA query_only=ON')
    return db, data


def compose():
    args = ['docker', 'compose', '--project-name', 'astral-hub', '--env-file', str(ROOT / '.env')]
    for layer in LAYERS:
        args += ['-f', str(ROOT / 'deploy' / layer)]
    args += ['-f', str(OVERRIDE)]
    return args


def health():
    with urllib.request.urlopen('http://127.0.0.1:8787/api/health', timeout=5) as response:
        return json.load(response)


def tables(db):
    return [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")]


def schema_and_counts(db):
    result = {}
    for table in tables(db):
        columns = list(db.execute('PRAGMA table_info("' + table.replace('"', '""') + '")'))
        primary = [row[1] for row in sorted(columns, key=lambda row: row[5]) if row[5]]
        count = db.execute('SELECT count(*) FROM "' + table.replace('"', '""') + '"').fetchone()[0]
        result[table] = {'primaryKey': primary, 'count': count}
    return result


def confirmed_control_receipt(row):
    if row['state'] != 'accepted' or row['kind'] not in ['setting-thinking', 'setting-permission']:
        return False
    try:
        value = json.loads(row['result'])
        kind = row['kind'][8:]
        field = 'model' if kind == 'thinking' else 'permissions'
        assert isinstance(value, dict) and set(value) == {field}
        receipt = value[field]
        selected = receipt['reasoningEffort' if kind == 'thinking' else 'currentValue']
        assert isinstance(selected, str) and 0 < len(selected) <= 300
        assert not any(ord(c) < 32 or ord(c) == 127 for c in selected)
        if kind == 'thinking':
            assert set(receipt) == {'provider', 'model', 'reasoningEffort'}
            assert all(isinstance(receipt[k], str) and 0 < len(receipt[k]) <= 300 for k in ['provider', 'model'])
        else:
            assert set(receipt) <= {'currentValue', 'options'}
            assert re.fullmatch('[a-z0-9]+(?:-[a-z0-9]+)*', selected)
        original = json.dumps({'id': row['id'], 'kind': kind, 'value': selected}, separators=(',', ':'), ensure_ascii=False)
        return hashlib.sha256(original.encode()).hexdigest() == row['digest']
    except (KeyError, TypeError, ValueError, AssertionError):
        return False


def confirmed_expired_mail_read(row, now_ms):
    expected = {
        'id': 'dee113a5-94fb-441b-8711-4734f928d436', 'name': 'mail.list',
        'state': 'unknown', 'origin': 'dsh', 'task': 'eeea7a44-ec6e-4411-8303-bbc9a4be4a1b',
        'created': 1794879607732, 'expires': 1794879907732,
        'error': '任务已结束，功能授权已撤销。', 'payload': None, 'result': None,
    }
    return all(row.get(key) == value for key, value in expected.items()) and row['expires'] <= now_ms


def confirmed_stopped_receipt(db, row, now_ms):
    if row['kind'] != 'stop' or row['state'] != 'accepted':
        return False
    try:
        receipt = json.loads(row['result'])
        assert isinstance(receipt, dict) and set(receipt) == {'accepted'} and receipt['accepted'] is True
        assert re.fullmatch('[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', row['id'])
        original = json.dumps({'id': row['id']}, separators=(',', ':'))
        assert hashlib.sha256(original.encode()).hexdigest() == row['digest']
        assert re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z', row['created_at'])
        created = dt.datetime.fromisoformat(row['created_at'].replace('Z', '+00:00')).timestamp() * 1000
        assert 0 < created <= now_ms
        conversation = db.execute('SELECT state,snapshot,stop_cursor FROM dsh_conversations WHERE owner=? AND id=?', (row['owner'], row['conversation_id'])).fetchone()
        assert conversation and conversation[0] == 'ready' and conversation[2] is None
        state = json.loads(conversation[1])
        assert isinstance(state, dict) and state.get('assistant') is None
        projections = state.get('projections', {})
        assert isinstance(projections, dict) and not projections.get('inbox')
        boundary = projections.get('turnBoundary')
        assert boundary is None or (isinstance(boundary, dict) and boundary.get('openTurnStartSeq') is None)
        assert all(isinstance(item, dict) and not item.get('answerable') for item in state.get('interactions', []))
        events = state['events']; seqs = [event['seq'] for event in events]
        assert all(isinstance(event, dict) for event in events) and all(type(seq) is int and seq >= 0 for seq in seqs)
        assert all(left < right for left, right in zip(seqs, seqs[1:]))
        terminal = next((event for event in reversed(events) if event.get('type') in ['turn/start', 'turn/end']), None)
        assert terminal and terminal['type'] == 'turn/end' and type(terminal['time']) is int and created < terminal['time'] <= now_ms
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
        'dshActions': "SELECT count(*) FROM dsh_actions WHERE state IS NULL OR state NOT IN ('observed','rejected')",
    }
    result = {}
    for name, query in queries.items():
        try:
            result[name] = db.execute(query).fetchone()[0]
        except sqlite3.OperationalError:
            result[name] = 0
    function_columns = ['id', 'name', 'state', 'origin', 'task', 'created', 'expires', 'error', 'payload', 'result']
    result['functions'] = sum(not confirmed_expired_mail_read(dict(zip(function_columns, row)), now_ms)
        for row in db.execute('SELECT ' + ','.join(function_columns) + " FROM app_function_calls WHERE state IS NULL OR state NOT IN ('prepared','done','error','denied')"))
    action_columns = ['id', 'kind', 'state', 'digest', 'result', 'owner', 'conversation_id', 'created_at']
    result['dshActions'] = 0
    for record in db.execute('SELECT ' + ','.join(action_columns) + " FROM dsh_actions WHERE state IS NULL OR state NOT IN ('observed','rejected')"):
        row = dict(zip(action_columns, record))
        if not confirmed_control_receipt(row) and not confirmed_stopped_receipt(db, row, now_ms):
            result['dshActions'] += 1
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assistant_switches'").fetchone():
        result['unifiedOperations'] = db.execute("SELECT count(*) FROM assistant_switches WHERE state IS NULL OR state<>'done'").fetchone()[0]
    helper_table = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pi_assistance_operations'").fetchone()
    result['helperOperations'] = db.execute('SELECT count(*) FROM pi_assistance_operations').fetchone()[0] if helper_table else 0
    for table, field, allowed in [
        ('mail_reply_sends', 'mailReplies', "('sent')"),
        ('mail_send_confirmations', 'mailCompositions', "('prepared','sent')"),
    ]:
        try:
            result[field] = db.execute('SELECT count(*) FROM ' + table + ' WHERE state IS NULL OR state NOT IN ' + allowed).fetchone()[0]
        except sqlite3.OperationalError:
            result[field] = 0
    deletion_table = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pi_file_deletions'").fetchone()
    result['fileDeletions'] = db.execute('SELECT count(*) FROM pi_file_deletions').fetchone()[0] if deletion_table else 0
    result['dsh'] = 0
    try:
        result['dsh'] += db.execute("SELECT count(*) FROM dsh_conversations WHERE state IS NULL OR state <> 'ready'").fetchone()[0]
    except sqlite3.OperationalError:
        pass
    for snapshot, cursor in db.execute("SELECT snapshot,stop_cursor FROM dsh_conversations WHERE state='ready'"):
        state = json.loads(snapshot); events = state.get('events', [])
        last = next((event['type'] for event in reversed(events) if event.get('type') in ['turn/start', 'turn/end']), None)
        projections = state.get('projections', {})
        if cursor is not None or last == 'turn/start' or state.get('assistant') or (projections.get('turnBoundary') or {}).get('openTurnStartSeq') is not None or projections.get('inbox') or any(item.get('answerable') for item in state.get('interactions', [])):
            result['dsh'] += 1
    return result


def assert_idle(db):
    current = activity(db)
    assert not any(current.values()), 'Active or unknown operations remain: ' + json.dumps(current, ensure_ascii=False)
    return current


def image_state(containers):
    return [
        {'name': name, 'configImage': container['Config']['Image'], 'imageId': container['Image'], 'health': container['State'].get('Health', {}).get('Status')}
        for name, container in zip(NAMES, containers)
    ]


def validate_baseline(containers):
    assert [container['Config']['Image'] for container in containers] == OLD
    assert [container['Image'] for container in containers] == OLD_IDS
    assert all(item['health'] == 'healthy' for item in image_state(containers))


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def save_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    path.chmod(0o600)


def backup():
    containers = inspect()
    validate_baseline(containers)
    db, data = db_for(containers[0])
    assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
    assert not db.execute('PRAGMA foreign_key_check').fetchall()
    idle = assert_idle(db)
    schema = schema_and_counts(db)
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    target = ROOT / 'backups' / ('before-0.9.2-' + stamp)
    target.mkdir(mode=0o700)
    shutil.copy2(data / 'astral.sqlite', target / 'astral.sqlite')
    shutil.copy2(data / 'private/updates/manifest.json', target / 'manifest.before.json')
    (target / 'manifest.before.json').chmod(0o600)
    save_json(target / 'before.json', {
        'version': health()['version'], 'images': image_state(containers),
        'schemaAndCounts': schema, 'activity': idle,
        'dbPath': str(data / 'astral.sqlite'), 'manifestSha256': sha(data / 'private/updates/manifest.json'),
        'createdAt': dt.datetime.now(dt.timezone.utc).isoformat(),
    })
    save_json(target / 'docker-inspect.json', containers)
    subprocess.run(['tar', '-czf', str(target / 'dsh-state.before.tgz'), '-C', str(ROOT / 'private'), 'dsh-state'], check=True)
    (target / 'dsh-state.before.tgz').chmod(0o600)
    (target / 'COMPLETE').write_text('0.9.1 App baseline, database and DSH state retained before the 0.9.2 switch.\n')
    print(json.dumps({'backup': str(target), 'version': health()['version'], 'activity': idle, 'database': 'ok'}))


def wait_healthy():
    for _ in range(180):
        try:
            containers = inspect()
            if [container['Config']['Image'] for container in containers] == NEW and all(item['health'] == 'healthy' for item in image_state(containers)):
                if health()['version'] == '0.9.2':
                    return containers
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError('0.9.2 services did not become healthy; inspect containers before retrying.')


def switch(target):
    target = Path(target).resolve()
    assert (target / 'COMPLETE').is_file()
    assert not (target / 'SWITCH_ATTEMPTED').exists()
    containers = inspect()
    validate_baseline(containers)
    db, _ = db_for(containers[0])
    assert_idle(db)
    db.close()
    (target / 'SWITCH_ATTEMPTED').write_text('Inspect the recorded state before any retry.\n')
    subprocess.run(compose() + ['stop', 'dsh'], cwd=ROOT, check=True)
    subprocess.run(compose() + ['up', '-d', '--no-deps', '--force-recreate', 'app'], cwd=ROOT, check=True)
    subprocess.run(compose() + ['up', '-d', '--no-deps', '--force-recreate', 'dsh'], cwd=ROOT, check=True)
    current = wait_healthy()
    db, data = db_for(current[0])
    assert db.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
    assert not db.execute('PRAGMA foreign_key_check').fetchall()
    assert schema_and_counts(db) == json.loads((target / 'before.json').read_text())['schemaAndCounts']
    after = {'version': health()['version'], 'images': image_state(current), 'manifestSha256': sha(data / 'private/updates/manifest.json'), 'database': 'ok', 'activity': assert_idle(db), 'at': dt.datetime.now(dt.timezone.utc).isoformat()}
    db.close()
    save_json(target / 'after.json', after)
    (target / 'DEPLOYED').write_text('0.9.2 App deployed; DSH4, Pi, database and independent state preserved.\n')
    print(json.dumps({'deployed': True, **after, 'backup': str(target)}))


def review(target):
    target = Path(target).resolve()
    assert (target / 'DEPLOYED').is_file()
    current = inspect()
    assert [container['Config']['Image'] for container in current] == NEW
    assert all(item['health'] == 'healthy' for item in image_state(current))
    assert health()['version'] == '0.9.2'
    db, _ = db_for(current[0])
    result = {'version': health()['version'], 'images': image_state(current), 'activity': assert_idle(db), 'database': db.execute('PRAGMA quick_check').fetchone()[0], 'foreignKeys': len(db.execute('PRAGMA foreign_key_check').fetchall())}
    db.close()
    assert result['database'] == 'ok' and result['foreignKeys'] == 0
    print(json.dumps(result))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=['backup', 'switch', 'review'])
    parser.add_argument('path', nargs='?', type=Path)
    args = parser.parse_args()
    if args.operation == 'backup':
        backup()
    elif args.operation == 'switch':
        assert args.path, 'switch requires a backup directory'
        switch(args.path)
    else:
        assert args.path, 'review requires a backup directory'
        review(args.path)


if __name__ == '__main__':
    os.umask(0o077)
    main()
