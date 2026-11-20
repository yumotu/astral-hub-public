const { readFile, mkdir, writeFile } = require('node:fs/promises');
const { resolve, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { hostname } = require('node:os');
const { spawn } = require('node:child_process');
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const FULL_WORKSPACE = Object.freeze([
  'file.read',
  'file.write',
  'terminal.execute',
  'network.outbound',
  'plugin.install',
  'dsh.workspace',
  'computer.background',
]);
const LEGACY_READ = Object.freeze(['file.read']);

function permissions(value, fallback = {}) {
  const source = value && typeof value === 'object' ? value : {};
  if (Array.isArray(source.permissions) && source.permissions.length) return [...new Set(source.permissions)];
  if (source.permissionProfile === 'full-workspace' || fallback.permissionProfile === 'full-workspace') return [...FULL_WORKSPACE];
  const fileWrite = source.fileWrite ?? source.allowWrite ?? fallback.fileWrite ?? fallback.allowWrite ?? false;
  const terminalExecute = source.terminalExecute ?? source.allowExecute ?? fallback.terminalExecute ?? fallback.allowExecute ?? false;
  return [...LEGACY_READ, ...(fileWrite ? ['file.write'] : []), ...(terminalExecute ? ['terminal.execute'] : [])];
}

function permissionPayload(value, fallback) {
  return permissions(value, fallback);
}

function createLocalComputer({ directory, bundle, chooseDirectory, launch = spawn, fetch = global.fetch, platform = process.platform }) {
  const configPath = join(directory, 'device.json'), profilesPath = join(directory, 'profiles.json'), preference = join(directory, 'enabled.json');
  const node = join(bundle, 'runtime', platform === 'win32' ? 'node.exe' : 'bin/node');
  const entry = join(bundle, 'agent/relay-agent.mjs');
  let child = null, activeKey = null, failure = '', failureKind = '', tail = Promise.resolve(), connectionState = 'unpaired';
  const serial = (fn) => { const next = tail.then(fn); tail = next.catch(() => {}); return next; };
  const helpers = () => import(pathToFileURL(join(bundle, 'agent/config.mjs')).href);
  async function readProfiles() {
    try {
      const parsed = JSON.parse(await readFile(profilesPath, 'utf8'));
      if (Array.isArray(parsed)) return parsed;
      if (Array.isArray(parsed.profiles)) return parsed.profiles;
      throw Error('本机连接档格式不正确。');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      try {
        const legacy = await (await helpers()).loadConfig(configPath);
        const profiles = legacy ? [legacy] : [];
        if (profiles.length) await writeProfiles(profiles);
        return profiles;
      } catch (legacyError) {
        if (legacyError.code === 'ENOENT') return [];
        throw legacyError;
      }
    }
  }
  async function writeProfiles(profiles) {
    await mkdir(directory,{recursive:true,mode:0o700});
    await writeFile(profilesPath, JSON.stringify(profiles, null, 2) + '\n', {mode:0o600});
  }
  async function profile(value) {
    const who = await identity(value), profiles = await readProfiles();
    return { who, profiles, config: profiles.find((item) => matches(item, who)) || null };
  }
  async function saveProfile(next, profiles) {
    const current = profiles.filter((item) => !matches(item, { server: next.server, owner: next.owner }));
    current.push(next);
    await writeProfiles(current);
    return current;
  }
  async function activate(c) {
    const h = await helpers();
    await h.saveConfig(configPath, c);
  }
  async function identity(value) {
    if (!value || !uuid.test(value.owner || '') || typeof value.server !== 'string') throw Error('请先登录服务器账号。');
    return { owner:value.owner, server:(await helpers()).validServer(value.server) };
  }
  function matches(c, who) { return c && c.owner === who.owner && c.server === who.server; }
  const keyOf = (who) => who.server + ':' + who.owner;
  async function enabled(value, who) { await mkdir(directory,{recursive:true,mode:0o700});await writeFile(preference,JSON.stringify({enabled:value, ...(who ? {server:who.server,owner:who.owner} : {})}),{mode:0o600}); }
  async function status(value) {
    const { who, config: c } = await profile(value);
    if (!matches(c,who)) return { configured:false, running:false, connectionState:'unpaired', projects:[] };
    const state = child && activeKey === keyOf(who) ? 'online' : failureKind === 'revoked' && activeKey === keyOf(who) ? 'revoked' : failure && activeKey === keyOf(who) ? 'offline' : 'paired_stopped';
    connectionState = state;
    return {
      configured:true,
      running:!!child && activeKey === keyOf(who),
      connectionState: state,
      deviceId:c.deviceId,
      name:c.name,
      server:c.server,
      error:failure,
      permissionProfile: c.permissionProfile || (permissions(c.permissions, c).length === FULL_WORKSPACE.length ? 'full-workspace' : 'legacy'),
      permissions: permissionPayload(c.permissions, c),
      projects:c.projects.map((project)=>({
        id:project.id,
        name:project.name,
        root:project.root,
        allowWrite:!!project.allowWrite,
        allowExecute:!!project.allowExecute,
        permissions: permissionPayload(project.permissions, project),
      })),
    };
  }
  async function startProcess(c, who) {
    const key = keyOf(who);
    if (child && activeKey === key) return;
    if (child) await stopProcess();
    failure = ''; failureKind = ''; connectionState = 'connecting';
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const p = launch(node,[entry,'--config',configPath],{cwd:join(bundle,'agent'),env,windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});
    child=p; activeKey=key;
    p.stderr?.on('data',()=>{}); // Credentials and task content never cross the renderer bridge.
    p.once('error',()=>{if(child===p){child=null;failureKind='offline';failure='本机连接未能启动，请重新开启或重新安装客户端。';}});
    p.once('exit',(code)=>{if(child===p){child=null;activeKey=null;if(code){failureKind=/撤销|未配对|授权已/.test(failure)?'revoked':'offline';failure=failure||'本机连接已停止，请检查服务器和本机授权。';}else{failure='';failureKind='';}}});
  }
  async function stopProcess() {
    const p=child;if(!p)return;
    await new Promise(resolveStop=>{
      let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timer);if(child===p){child=null;activeKey=null;}resolveStop();};
      const timer=setTimeout(()=>{p.kill();finish();},7000);p.once('exit',finish);
      if(p.connected)p.send({type:'astral-desktop-stop'});else p.kill();
    });
  }
  return {
    status,
    pair: (value) => serial(async()=>{
      const who=await identity(value), existing=await profile(who);
      if(existing.config)throw Error('此服务器和账号已配对，请使用现有连接或重新授权。');
      if(typeof value.code!=='string'||!/^[a-f0-9]{32}$/i.test(value.code))throw Error('配对或权限格式不正确。');
      const requested = value.permissionProfile === 'full-workspace' ? [...FULL_WORKSPACE] : permissionPayload(value.permissions, value);
      const selected=await chooseDirectory();if(!selected)return{cancelled:true};
      const h=await helpers(),allowWrite=requested.includes('file.write'),allowExecute=requested.includes('terminal.execute'),grant=await h.localGrant(selected,{allowWrite,allowExecute,permissions:requested});
      grant.permissions = requested;
      const name=hostname().slice(0,60)||'本机电脑';
      const response=await fetch(who.server+'/api/relay/device/enroll',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:value.code,name,platform,rootLabel:grant.name.slice(0,100),allowWrite,allowExecute,permissions:requested,permissionProfile:value.permissionProfile === 'full-workspace' ? 'full-workspace' : 'legacy'}),redirect:'error',signal:AbortSignal.timeout(20000)});
      const result=await response.json();if(!response.ok)throw Error(result.error||'电脑配对失败。');
      if(!uuid.test(result.deviceId||'')||typeof result.token!=='string'||result.token.length<32)throw Error('配对响应不正确。');
      const c={...result,...who,name,root:grant.root,allowWrite:grant.allowWrite,allowExecute:grant.allowExecute,permissionProfile:value.permissionProfile === 'full-workspace' ? 'full-workspace' : 'legacy',permissions:requested,projects:[grant],legacyProjectId:grant.id};
      await saveProfile(c, existing.profiles); await activate(c); await enabled(true, who); await startProcess(c, who); return status(who);
    }),
    start: (value) => serial(async()=>{const { who, config:c } = await profile(value);if(!c)throw Error('本机连接属于其他账号或服务器，或尚未配对。');await activate(c);await enabled(true, who);await startProcess(c, who);return status(who);}),
    stop: (value) => serial(async()=>{const { who, config:c } = await profile(value);if(!c)throw Error('本机连接属于其他账号或服务器，或尚未配对。');await enabled(false, who);if(activeKey===keyOf(who))await stopProcess();return status(who);}),
    grant: (value) => serial(async()=>{
      const { who, profiles, config:c } = await profile(value);if(!c)throw Error('本机连接属于其他账号或服务器，或尚未配对。');
      const h=await helpers();
      if(value.remove){if(!uuid.test(value.projectId||''))throw Error('项目编号不正确。');c.projects=c.projects.filter(p=>p.id!==value.projectId);}
      else{
        const requested = value.permissionProfile === 'full-workspace' ? [...FULL_WORKSPACE] : permissionPayload(value.permissions, value);
        const allowWrite = requested.includes('file.write');
        const allowExecute = requested.includes('terminal.execute');
        if(value.projectId){const p=c.projects.find(p=>p.id===value.projectId);if(!p)throw Error('本机项目不存在。');p.allowWrite=allowWrite;p.allowExecute=allowExecute;p.permissions=requested;}
        else {if(c.projects.length>=32)throw Error('最多授权32个本机项目。');const selected=await chooseDirectory();if(!selected)return{cancelled:true};const project=await h.localGrant(selected,{allowWrite,allowExecute,permissions:requested});c.projects.push(project);}
      }
      await saveProfile(c, profiles); if (activeKey === keyOf(who)) await activate(c); return status(who);
    }),
    restore: () => serial(async()=>{let p;try{p=JSON.parse(await readFile(preference,'utf8'));}catch{return;}if(!p.enabled)return;const profiles=await readProfiles();const c=p.server&&p.owner?profiles.find((item)=>matches(item,p)):profiles[0];if(c){const who={server:c.server,owner:c.owner};await activate(c);await startProcess(c,who);}}),
    close: () => serial(stopProcess),
  };
}
module.exports={createLocalComputer};
