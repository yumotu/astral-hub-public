import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
mkdirSync('release', { recursive: true });
const result = spawnSync(
  'python3',
  [
    '-c',
    `
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json, subprocess
root = Path.cwd()
version = json.loads((root / 'package.json').read_text())['version']
target = root / 'release' / f'Astral-Hub-{version}-source.zip'
excluded = {'node_modules', 'release', 'data', '.git', '.gradle', '.idea', 'dist'}
with ZipFile(target, 'w', ZIP_DEFLATED) as archive:
    tracked = subprocess.check_output(['git','ls-files','-z']).decode().split('\\0')
    for filename in sorted(filter(None, tracked)):
        path = root / filename
        rel = path.relative_to(root)
        if any(part in excluded for part in rel.parts):
            continue
        if 'build' in rel.parts and rel.parts[:2] != ('desktop', 'build'):
            continue
        if rel.parts[:2] == ('desktop', 'web'):
            continue
        if rel.parts[:6] == ('android', 'app', 'src', 'main', 'assets', 'public'):
            continue
        if path.is_symlink() or path.name in {'.env', '.device-ai.json', '.DS_Store', 'local.properties'} or path.suffix in {'.log', '.jks', '.keystore', '.sqlite', '.key', '.pem'} or (path.name.startswith('.env.') and not path.name.endswith('.example')):
            continue
        if path.is_file():
            archive.write(path, Path('astral-hub') / rel)
with ZipFile(target) as archive:
    assert archive.testzip() is None
    assert not any(name.endswith('/.env') or '/data/' in name or '/node_modules/' in name for name in archive.namelist())
    print(f'Source archive verified: {len(archive.namelist())} files, {target.stat().st_size} bytes')
    print(target)
`,
  ],
  { stdio: 'inherit' },
);
process.exitCode = result.status ?? 1;
