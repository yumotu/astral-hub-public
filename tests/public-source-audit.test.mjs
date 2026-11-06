import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditPublicSource } from '../scripts/audit-public-source.mjs';
test('public export accepts configuration templates and rejects actual private deployment files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'astral-public-audit-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'.env.example'),'APP_TOKEN=\n');assert.equal((await auditPublicSource(root)).files,1);
 await writeFile(join(root,'.env'),'APP_TOKEN=synthetic');await assert.rejects(auditPublicSource(root),/private-or-generated-file/);await rm(join(root,'.env'));
 await mkdir(join(root,'docs'));await writeFile(join(root,'docs/handoff-old.md'),'private operational record');await assert.rejects(auditPublicSource(root),/private-or-generated-file/);
});
test('public export detects local machine paths and excludes installed dependencies',async t=>{
 const root=await mkdtemp(join(tmpdir(),'astral-public-audit-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await mkdir(join(root,'node_modules'));await writeFile(join(root,'node_modules/vendor.js'),['/Users','fixture','workspace/'].join('/'));
 await writeFile(join(root,'source.mjs'),'export {};');assert.equal((await auditPublicSource(root)).files,1);
 await writeFile(join(root,'source.mjs'),['/Users','fixture','workspace/'].join('/'));await assert.rejects(auditPublicSource(root),/personal-machine/);
});
