import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const generated = new Set(['.git', 'node_modules', 'release', 'dist', '.gradle', '.codex', '.claude']);
export async function auditPublicSource(root = process.cwd()) {
  root = resolve(root); let files = [];
  let ownGit = false;
  try { ownGit = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim() === root; } catch {}
  if (ownGit) files = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 8e6 }).toString().split('\0').filter(Boolean);
  else {
    const walk = async (folder, prefix = '') => { for (const e of await readdir(folder, { withFileTypes: true })) {
      const name = prefix + e.name;
      if (e.isDirectory()) { if (!generated.has(e.name) && !(name.startsWith('android/') && e.name === 'build') && !['desktop/web','desktop/runtime','web/public/pdfjs','web/public/downloads','agent/assets'].includes(name)) await walk(join(folder,e.name),name+'/'); }
      else if (e.isFile()) files.push(name);
      else throw Error('Public source must not contain symbolic links: ' + name);
    } }; await walk(root);
  }
  const findings = [];
  for (const name of files) {
    const parts = name.split('/'), leaf = parts.at(-1);
    if (parts.some(p => generated.has(p)) || /^android\/(?:.*\/)?build\//.test(name) || /^(?:agent\/assets|desktop\/(?:runtime|web)|web\/public\/(?:downloads|pdfjs))\//.test(name) || /(^|\/)(?:data|private|backups)\//.test(name) || /(?:\.sqlite(?:-\w+)?|\.keystore|\.jks|\.p8|\.p12|\.pfx|\.pem|\.key|\.zip|\.mp4)$/.test(name) || /^\.env(?:\.|$)/.test(leaf) && !/\.example$/.test(leaf) || leaf === 'device.json' || leaf === '.device-ai.json' || /^docs\/(?:handoff|checkpoints|rollback|plan)-/.test(name) || name.startsWith('docs/previews/') || /^deploy\/(?:ssh-|set-server-key)/.test(name)) findings.push({ file:name, kind:'private-or-generated-file' });
    if (!/\.(?:md|mjs|cjs|js|json|ts|tsx|css|svg|xml|yml|yaml|sh|py|properties|gradle)$/.test(name)) continue;
    const content = await readFile(join(root,name),'utf8');
    if (/\/Users\/(?!runner(?:\/|\b))[^\s/'"`]+\//.test(content) || /wxid_[a-zA-Z0-9]{8,}/.test(content) || /codex-clipboard-[a-f0-9-]{36}/.test(content)) findings.push({file:name,kind:'personal-machine-or-attachment-reference'});
  }
  if (findings.length) throw Object.assign(Error('Public source audit failed: ' + JSON.stringify(findings)),{ findings });
  return { files:files.length, privateOrGeneratedFiles:0, personalMachineReferences:0 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log(JSON.stringify(await auditPublicSource()));
