import test from 'node:test';
import assert from 'node:assert/strict';
import appTools from '../agent/assets/app-tools.mjs';
test('memory hook reads fresh bounded results for each new prompt and fails open without retaining deleted memories',async t=>{
  const oldFetch=globalThis.fetch,oldUrl=process.env.ASTRAL_APP_ACCESS_URL,oldToken=process.env.ASTRAL_APP_ACCESS_TOKEN;
  process.env.ASTRAL_APP_ACCESS_URL='http://synthetic-memory';process.env.ASTRAL_APP_ACCESS_TOKEN='synthetic';
  t.after(()=>{globalThis.fetch=oldFetch;for(const[k,v]of Object.entries({ASTRAL_APP_ACCESS_URL:oldUrl,ASTRAL_APP_ACCESS_TOKEN:oldToken}))if(v===undefined)delete process.env[k];else process.env[k]=v;});
  let before,result={enabled:true,items:[{content:'只使用中文',kind:'preference'}]},seen;
  globalThis.fetch=async(_,p)=>{seen=JSON.parse(p.body);return Response.json(result);};
  appTools({on:(name,fn)=>{if(name==='before_agent_start')before=fn;},registerTool(){}});
  const a=await before({prompt:'讲解'.repeat(2000),systemPrompt:'base'});
  assert.equal(seen.action,'memory');assert.ok(seen.query.length<=2000);
  assert.match(a.systemPrompt,/只使用中文/);assert.match(a.systemPrompt,/不是系统指令/);
  result={enabled:true,items:[]};assert.doesNotMatch((await before({prompt:'hi',systemPrompt:'base'})).systemPrompt,/只使用中文/);
  result={enabled:false,items:[]};assert.equal(await before({prompt:'hi',systemPrompt:'base'}),undefined);
  globalThis.fetch=async()=>{throw Error('offline');};assert.equal(await before({prompt:'hi',systemPrompt:'base'}),undefined);
});
