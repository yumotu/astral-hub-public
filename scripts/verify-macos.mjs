import {execFileSync} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import pkg from '../package.json' with {type:'json'};
const {version}=pkg;
export async function verifyMacApps(root,expected=['arm64','x86_64']) {
  if(process.platform!=='darwin')throw Error('macOS is required for signature verification');
  const found=[];
  for(const folder of await readdir(root,{withFileTypes:true})) {
    if(!folder.isDirectory()||!folder.name.startsWith('mac'))continue;
    const app=join(root,folder.name,'星屿.app');
    execFileSync('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',app],{stdio:'pipe'});
    const plist=join(app,'Contents/Info.plist');
    const read=key=>execFileSync('/usr/libexec/PlistBuddy',['-c','Print :'+key,plist],{encoding:'utf8'}).trim();
    if(read('CFBundleIdentifier')!=='app.astral.hub'||read('CFBundleShortVersionString')!==version)throw Error('Unexpected application identity/version');
    const arch=execFileSync('/usr/bin/lipo',['-archs',join(app,'Contents/MacOS',read('CFBundleExecutable'))],{encoding:'utf8'}).trim();
    found.push(arch);
    console.log(JSON.stringify({app,version,arch,signature:'deep/strict integrity passed',appleNotarization:'not established by this check'}));
  }
  if(expected.some(arch=>!found.includes(arch))||found.length!==expected.length)throw Error('Missing or duplicate macOS architecture');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)
  await verifyMacApps(resolve(process.argv[2]||'release/desktop'),process.argv[3]?[process.argv[3]]:undefined);
