import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtemp,writeFile,rm}from'node:fs/promises';import{join}from'node:path';import{tmpdir}from'node:os';import{createHash}from'node:crypto';
import{verifiedTransferSource,verifyTransferredFiles}from'../scripts/transfer-release.mjs';
test('installer transfer rejects incomplete, forked or unrelated workflows',()=>{
 const base={repository:{full_name:'owner/repo'},head_repository:{full_name:'owner/repo'},path:'.github/workflows/packages.yml',status:'completed',conclusion:'success',event:'push',head_sha:'a'.repeat(40)};
 assert.equal(verifiedTransferSource(base,'owner/repo'),base.head_sha);
 for(const change of [{conclusion:'failure'},{status:'in_progress'},{head_repository:{full_name:'fork/repo'}},{path:'.github/workflows/computer-tools.yml'},{event:'pull_request'},{head_sha:'untrusted'}])assert.throws(()=>verifiedTransferSource({...base,...change},'owner/repo'));
});
test('installer transfer binds bytes to the release source and native verification',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'astral-transfer-'));try{
 const expected={run:123,commit:'b'.repeat(40),version:'0.8.5'},info={...expected,verifiedJobs:['web-and-tests','desktop-macOS','desktop-Windows','android','pi-runtime','computer-runtime-linux','computer-runtime-macOS','computer-runtime-Windows']};
 await writeFile(join(dir,'build-info.json'),JSON.stringify(info));
 let sums='';for(const suffix of ['mac-arm64.dmg','mac-arm64.zip','mac-x64.dmg','mac-x64.zip','win-x64.exe','android-debug.apk']){const name='Astral-Hub-0.8.5-'+suffix,bytes=Buffer.from('synthetic installer '+suffix);await writeFile(join(dir,name),bytes);sums+=createHash('sha256').update(bytes).digest('hex')+'  '+name+'\n';}
 await writeFile(join(dir,'SHA256SUMS.txt'),sums);assert.equal((await verifyTransferredFiles(dir,expected)).files.length,6);
 await assert.rejects(verifyTransferredFiles(dir,{...expected,commit:'c'.repeat(40)}),/provenance/);
 await writeFile(join(dir,'Astral-Hub-0.8.5-android-debug.apk'),'tampered');await assert.rejects(verifyTransferredFiles(dir,expected),/checksum/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
