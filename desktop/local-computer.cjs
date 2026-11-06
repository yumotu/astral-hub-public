const { readFile, mkdir, writeFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { hostname } = require('node:os');
const { spawn } = require('node:child_process');
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function createLocalComputer({ directory, bundle, chooseDirectory, launch = spawn, fetch = global.fetch, platform = process.platform }) {
  const configPath = join(directory, 'device.json'), preference = join(directory, 'enabled.json');
  const node = join(bundle, 'runtime', platform === 'win32' ? 'node.exe' : 'bin/node');
  const entry = join(bundle, 'agent/relay-agent.mjs');
  let child = null, failure = '', tail = Promise.resolve();
  const serial = (fn) => { const next = tail.then(fn); tail = next.catch(() => {}); return next; };
  const helpers = () => import(pathToFileURL(join(bundle, 'agent/config.mjs')).href);
  async function config() { try { return await (await helpers()).loadConfig(configPath); } catch(e) { if(e.code === 'ENOENT') return null; throw e; } }
  async function identity(value) {
    if (!value || !uuid.test(value.owner || '') || typeof value.server !== 'string') throw Error('请先登录服务器账号。');
    return { owner:value.owner, server:(await helpers()).validServer(value.server) };
  }
  function matches(c, who) { return c && c.owner === who.owner && c.server === who.server; }
  async function enabled(value) { await mkdir(directory,{recursive:true,mode:0o700});await writeFile(preference,JSON.stringify({enabled:value}),{mode:0o600}); }
  async function status(value) {
    const who = await identity(value), c = await config();
    if (!matches(c,who)) return { configured:false, running:false, projects:[] };
    return { configured:true, running:!!child, deviceId:c.deviceId, name:c.name, server:c.server, error:failure, projects:c.projects.map(({id,name,root,allowWrite,allowExecute})=>({id,name,root,allowWrite,allowExecute})) };
  }
  async function startProcess(c) {
    if (child) return;
    failure = '';
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const p = launch(node,[entry,'--config',configPath],{cwd:join(bundle,'agent'),env,windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
    child=p;
    p.stderr?.on('data',()=>{}); // Credentials and task content never cross the renderer bridge.
    p.once('error',()=>{if(child===p){child=null;failure='本机连接未能启动，请重新开启或重新安装客户端。';}});
    p.once('exit',(code)=>{if(child===p){child=null;if(code)failure='本机连接已停止，请检查服务器和本机授权。';}});
  }
  async function stopProcess() {
    const p=child;if(!p)return;
    await new Promise(resolveStop=>{
      let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);if(child===p)child=null;resolveStop();};
      const timer=setTimeout(()=>{p.kill();finish();},7000);p.once('exit',finish);
      if(p.connected)p.send({type:'astral-desktop-stop'});else p.kill();
    });
  }
  return {
    status,
    pair: (value) => serial(async()=>{
      const who=await identity(value);
      if(await config())throw Error('此客户端已配对，请使用现有连接；不同服务器或账号不能覆盖原配对。');
      if(typeof value.code!=='string'||!/^[a-f0-9]{32}$/i.test(value.code)||typeof value.allowWrite!=='boolean'||typeof value.allowExecute!=='boolean')throw Error('配对或权限格式不正确。');
      const selected=await chooseDirectory();if(!selected)return{cancelled:true};
      const h=await helpers(),grant=await h.localGrant(selected,{allowWrite:value.allowWrite,allowExecute:value.allowExecute});
      const name=hostname().slice(0,60)||'本机电脑';
      const response=await fetch(who.server+'/api/relay/device/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:value.code,name,platform,rootLabel:grant.name.slice(0,100),allowWrite:value.allowWrite}),redirect:'error',signal:AbortSignal.timeout(20000)});
      const result=await response.json();if(!response.ok)throw Error(result.error||'电脑配对失败。');
      if(!uuid.test(result.deviceId||'')||typeof result.token!=='string'||result.token.length<32)throw Error('配对响应不正确。');
      const c={...result,...who,name,root:grant.root,allowWrite:grant.allowWrite,projects:[grant],legacyProjectId:grant.id};
      await h.saveConfig(configPath,c,{create:true});await enabled(true);await startProcess(c);return status(who);
    }),
    start: (value) => serial(async()=>{const who=await identity(value),c=await config();if(!matches(c,who))throw Error('本机连接属于其他账号或服务器。');await enabled(true);await startProcess(c);return status(who);}),
    stop: (value) => serial(async()=>{const who=await identity(value),c=await config();if(!matches(c,who))throw Error('本机连接属于其他账号或服务器。');await enabled(false);await stopProcess();return status(who);}),
    grant: (value) => serial(async()=>{
      const who=await identity(value),c=await config();if(!matches(c,who))throw Error('本机连接属于其他账号或服务器。');
      const h=await helpers();
      if(value.remove){if(!uuid.test(value.projectId||''))throw Error('项目编号不正确。');c.projects=c.projects.filter(p=>p.id!==value.projectId);}
      else{
        if(typeof value.allowWrite!=='boolean'||typeof value.allowExecute!=='boolean')throw Error('权限格式不正确。');
        if(value.projectId){const p=c.projects.find(p=>p.id===value.projectId);if(!p)throw Error('本机项目不存在。');p.allowWrite=value.allowWrite;p.allowExecute=value.allowExecute;}
        else {if(c.projects.length>=32)throw Error('最多授权32个本机项目。');const selected=await chooseDirectory();if(!selected)return{cancelled:true};c.projects.push(await h.localGrant(selected,{allowWrite:value.allowWrite,allowExecute:value.allowExecute}));}
      }
      await h.saveConfig(configPath,c);return status(who);
    }),
    restore: () => serial(async()=>{let p;try{p=JSON.parse(await readFile(preference,'utf8'));}catch{return;}if(p.enabled){const c=await config();if(c)await startProcess(c);}}),
    close: () => serial(stopProcess),
  };
}
module.exports={createLocalComputer};
