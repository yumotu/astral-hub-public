import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
mkdirSync('release', { recursive: true });
const result = spawnSync(
  'python3',
  [
    '-c',
    `
from pathlib import Path
import tarfile, hashlib, json
root = Path.cwd()
assert (root / 'dist/index.html').is_file(), '请先运行 npm run build'
assert len(list((root / 'dist/cards/classic').glob('*.jpg'))) == 78
version = json.loads((root / 'package.json').read_text())['version']
target = root / 'release' / f'Astral-Hub-{version}-server.tar.gz'
included = ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', '.env.example', 'README.md', 'dist', 'server', 'shared', 'integrations', 'scripts/init.mjs', 'scripts/publish-updates.mjs', 'docs', 'deploy']
def allowed(entry):
    parts = Path(entry.name).parts
    if 'node_modules' in parts or any(part in {'data','private','.git'} for part in parts): return None
    if Path(entry.name).name == '.env' or entry.name.endswith(('.sqlite','.key','.pem','.log')): return None
    return entry
with tarfile.open(target, 'w:gz') as archive:
    for name in included:
        assert (root / name).exists(), f'文件缺失: {name}'
        archive.add(root / name, arcname=name, filter=allowed)
with tarfile.open(target) as archive:
    names = archive.getnames()
    assert not any(n == '.env' or n.startswith('data/') for n in names)
    assert len([n for n in names if n.startswith('dist/cards/classic/') and n.endswith('.jpg')]) == 78
checksum = hashlib.sha256(target.read_bytes()).hexdigest()
target.with_suffix(target.suffix + '.sha256').write_text(f'{checksum}  {target.name}\\n')
print(f'运行包校验通过: {target.stat().st_size} bytes, {target}')
`,
  ],
  { stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
