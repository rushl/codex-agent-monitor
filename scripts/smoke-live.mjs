import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { MonitorStore } from '../dist/store.js';

const home=process.env.CODEX_HOME||path.join(os.homedir(),'.codex');
const store=new MonitorStore(path.join(home,'app-server-control','app-server-control.sock'),3);
try {
  await store.start();assert.equal(store.connected,true);
  const agents=[...store.agents.values()];
  const children=agents.filter(a=>a.parentId);
  assert.ok(agents.some(a=>!a.parentId),'Root session discovered');
  assert.ok(children.length,'Existing subagents discovered');
  assert.ok(children.every(a=>store.agents.has(a.parentId)),'Parents resolved');
  assert.ok(agents.some(a=>a.model),'Model metadata');
  assert.ok(agents.some(a=>a.prompt),'Task metadata');
  assert.ok(agents.every(a=>['active','idle','notLoaded','systemError','unknown'].includes(a.status)));
  const before=store.reconciliations;await store.refresh();assert.ok(store.reconciliations>before);
  const changes=new Set();const last=new Map(agents.map(a=>[a.id,a.status]));
  store.on('change',()=>{for(const a of store.agents.values()){if(last.has(a.id)&&last.get(a.id)!==a.status)changes.add(`${last.get(a.id)} -> ${a.status}`);last.set(a.id,a.status);}});
  await new Promise(resolve=>setTimeout(resolve,12000));
  console.log(JSON.stringify({passed:true,roots:agents.length-children.length,children:children.length,models:agents.filter(a=>a.model).length,tasks:agents.filter(a=>a.prompt).length,taskReferences:children.filter(a=>a.agentPath).length,spawnPrompts:children.filter(a=>a.spawnPrompt).length,statuses:[...new Set(agents.map(a=>a.status))],refreshes:store.reconciliations,notifications:store.notificationCount,observedTransitions:[...changes]}));
}finally{store.stop();}
