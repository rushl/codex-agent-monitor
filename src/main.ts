import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MonitorStore } from './store.js';
import { startUI } from './ui.js';

function options(){
  let home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
  let socket=process.env.CODEX_AGENT_MONITOR_SOCKET||'';
  let refresh=15;let doctor=false;let once=false;
  const args=process.argv.slice(2);
  for(let i=0;i<args.length;i++){
    const arg=args[i];
    if(arg==='--help'||arg==='-h'){
      process.stdout.write('codex-agent-monitor [doctor | --debug | --once] [--codex-home DIR] [--socket PATH] [--refresh SECONDS]\n\nRead-only Codex daemon dashboard. Requires an already running shared daemon.\nControls: q quit, r refresh, arrows/j/k select, space expand/collapse, Enter/d details, a all/active only, u show/hide unloaded.\nRoots start collapsed and expand when descendant data changes. Filters persist during refreshes.\nColor: CODEX_AGENT_MONITOR_COLOR=truecolor|256|none. See UI.md.\n');process.exit(0);
    }else if(arg==='--version'){process.stdout.write('codex-agent-monitor 0.1.0\n');process.exit(0);}
    else if(arg==='doctor'||arg==='--debug')doctor=true;
    else if(arg==='--once')once=true;
    else if(['--codex-home','--socket','--refresh'].includes(arg)){
      const value=args[++i];if(!value||value.startsWith('--'))throw new Error(`Missing value for ${arg}`);
      if(arg==='--codex-home')home=path.resolve(value);
      if(arg==='--socket')socket=path.resolve(value.replace(/^unix:\/\//,''));
      if(arg==='--refresh'){refresh=Number(value);if(!Number.isFinite(refresh)||refresh<2)throw new Error('--refresh must be at least 2 seconds');}
    }else throw new Error(`Unknown option: ${arg}`);
  }
  return {home,socket:socket||path.join(home,'app-server-control','app-server-control.sock'),refresh,doctor,once};
}
function codexVersion(){try{return execFileSync('codex',['--version'],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:5000}).trim();}catch{return 'not found';}}
async function main(){
  const opts=options();
  if(!opts.doctor&&!opts.once&&(!process.stdin.isTTY||!process.stdout.isTTY))throw new Error('A terminal is required. Use doctor for diagnostics or --once for a text snapshot.');
  const store=new MonitorStore(opts.socket,opts.refresh);
  let cleanup=()=>{};let quitting=false;
  const quit=()=>{if(quitting)return;quitting=true;cleanup();store.stop();};
  process.once('SIGINT',quit);process.once('SIGTERM',quit);
  if(!opts.doctor&&!opts.once)cleanup=startUI(store,quit,opts.home);
  await store.start();
  if(quitting){store.stop();return;}
  if(opts.doctor){
    const agents=[...store.agents.values()];
    process.stdout.write(JSON.stringify({monitorVersion:'0.1.0',codexVersion:codexVersion(),codexHome:opts.home,mode:'shared daemon; WebSocket over Unix socket',socket:opts.socket,connected:store.connected,serverVersion:store.serverVersion,protocol:'installed 0.155.1 experimental schema; read-only allowlist',rootThreads:agents.filter(a=>!a.parentId).length,descendants:agents.filter(a=>a.parentId).length,active:agents.filter(a=>a.status==='active').length,withModel:agents.filter(a=>a.model).length,withTask:agents.filter(a=>a.prompt).length,notifications:store.notificationCount,reconciliations:store.reconciliations,warning:store.warning||undefined,action:store.connected?undefined:'Check that your Codex shared daemon is running and this user can access the socket. The monitor will not start or restart it.'},null,2)+'\n');
    if(!store.connected)process.exitCode=1;
    quit();
  }else if(opts.once){
    // A deliberately privacy-safe snapshot. Full tasks stay in the interactive UI.
    const agents=[...store.agents.values()];
    process.stdout.write(JSON.stringify({connection:store.connection,agents:agents.map(a=>({id:a.id,parentId:a.parentId,role:a.role,status:a.status,model:a.model,effort:a.effort,hasTask:!!a.prompt,hasSpawnPrompt:!!a.spawnPrompt,lastTurnStatus:a.lastTurnStatus}))},null,2)+'\n');quit();
  }
}
main().catch(e=>{process.stderr.write((e instanceof Error?e.message:'Monitor failed')+'\n');process.exitCode=1;});
