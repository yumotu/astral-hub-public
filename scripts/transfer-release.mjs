import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { androidVerification, requiresAndroidVerification } from '../shared/android-release-verification.mjs';

export function verifiedTransferSource(run, repository) {
  if (
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository ||
    run.path !== '.github/workflows/packages.yml' ||
    run.status !== 'completed' || run.conclusion !== 'success' ||
    !['push', 'workflow_dispatch'].includes(run.event) ||
    !/^[a-f0-9]{40}$/.test(run.head_sha || '')
  ) throw Error('Only the successful complete package workflow from this repository can be transferred.');
  return run.head_sha;
}
export async function verifyTransferredFiles(directory, { run, commit, version }) {
  const info = JSON.parse(await readFile(join(directory, 'build-info.json'), 'utf8'));
  if (info.version !== version || info.commit !== commit || String(info.run) !== String(run))
    throw Error('Release provenance does not match the verified workflow.');
  const jobs = ['web-and-tests','desktop-macOS','desktop-Windows','android','pi-runtime','computer-runtime-linux','computer-runtime-macOS','computer-runtime-Windows'];
  if (!jobs.every(j => info.verifiedJobs?.includes(j))) throw Error('Native verification is incomplete.');
  if (requiresAndroidVerification(version) && !['source-audit','android-sign'].every(j => info.verifiedJobs?.includes(j))) throw Error('Public release signing verification is incomplete.');
  const sums = new Map((await readFile(join(directory, 'SHA256SUMS.txt'), 'utf8')).trim().split('\n').map(line => line.split(/\s+/)).map(([hash,name]) => [name,hash]));
  const files = [];
  for (const suffix of ['mac-arm64.dmg','mac-arm64.zip','mac-x64.dmg','mac-x64.zip','win-x64.exe','android-debug.apk']) {
    const name = `Astral-Hub-${version}-${suffix}`;
    const bytes = await readFile(join(directory,name));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== sums.get(name)) throw Error('Installer checksum mismatch: '+name);
    if ((await stat(join(directory,name))).size > 500 * 1024 * 1024) throw Error('Individual installer exceeds transfer limit.');
    files.push({name,bytes:bytes.length,sha256});
  }
  if (requiresAndroidVerification(version)) androidVerification(info.androidVerification, { version, commit, files });
  return {run:String(run),commit,version,files};
}
export async function transferRelease({run,repository,directory=resolve('transferred-release')}) {
  if (!/^[1-9][0-9]{0,19}$/.test(String(run)) || !/^[\w.-]+\/[\w.-]+$/.test(repository||'')) throw Error('Invalid source run/repository.');
  const gh = args => execFileSync('gh',args,{encoding:'utf8',maxBuffer:4*1024*1024});
  const record = JSON.parse(gh(['api',`repos/${repository}/actions/runs/${run}`]));
  const commit=verifiedTransferSource(record,repository);
  const manifest=JSON.parse(gh(['api',`repos/${repository}/contents/package.json?ref=${commit}`]));
  const {version}=JSON.parse(Buffer.from(manifest.content,'base64').toString('utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid source version.');
  await mkdir(directory,{recursive:true});
  const patterns=[`Astral-Hub-${version}-mac-*.dmg`,`Astral-Hub-${version}-mac-*.zip`,`Astral-Hub-${version}-win-x64.exe`,`Astral-Hub-${version}-android-debug.apk`,'build-info.json','SHA256SUMS.txt'];
  for (const pattern of patterns) gh(['release','download','v'+version,'--repo',repository,'--pattern',pattern,'--dir',directory]);
  const proof=await verifyTransferredFiles(directory,{run,commit,version});
  await writeFile(join(directory,'transfer-proof.json'),JSON.stringify(proof,null,2)+'\n');
  console.log(JSON.stringify({run,commit,version,verifiedInstallers:proof.files.length}));
  return proof;
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  await transferRelease({run:process.env.SOURCE_RUN,repository:process.env.GITHUB_REPOSITORY});
