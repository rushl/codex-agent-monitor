import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { Client, pageSchema, threadSchema, spawnSource, itemSchema, turnSchema, type Thread } from './protocol.js';

export interface Agent {
  id:string; parentId:string|null; name:string; cwd:string; role:string; nickname:string;
  model:string; effort:string; prompt:string; spawnPrompt:string; promptSource:string;
  status:string; flags:string[]; lastActivity:number; lastTurnStatus:string;
}
const threadResult=z.object({thread:threadSchema});
const eventSchema=z.object({threadId:z.string().optional(),thread:z.unknown().optional(),status:z.unknown().optional(),turn:z.unknown().optional(),item:z.unknown().optional()});
export class MonitorStore extends EventEmitter {
  agents=new Map<string,Agent>(); connected=false; connection='Connecting'; warning='';
  serverVersion='unknown'; notificationCount=0; reconciliations=0;
  private client:Client|null=null;
  private stopped=false;
  private interval:NodeJS.Timeout|null=null;
  private retry:NodeJS.Timeout|null=null;
  private debounce:NodeJS.Timeout|null=null;
  private refreshing:Promise<void>|null=null;
  private revisions=new Map<string,number>();
  private historyAt=new Map<string,number>();
  private seenSpawn=new Set<string>();
  constructor(public socket:string,public refreshSeconds:number){super();}
  async start(){await this.connect();this.interval=setInterval(()=>void this.refresh(),this.refreshSeconds*1000);}
  private async connect(){
    if(this.stopped)return;
    const client=new Client();this.client=client;
    client.on('notification',(method:string,params:unknown)=>this.notification(method,params));
    client.on('protocolWarning',()=>{this.warning='Unrecognized protocol message';});
    client.on('disconnect',()=>this.disconnected(client));
    try{
      const init=await client.connect(this.socket);
      if(this.stopped)return;
      this.serverVersion=init.userAgent?.match(/codex[^/]*\/([^ ]+)/)?.[1]??'unknown';
      this.connected=true;this.connection='Connected';this.emit('change');await this.refresh();
    }catch{client.close();this.disconnected(client);}
  }
  private disconnected(client:Client){
    if(this.client!==client || this.stopped)return;
    this.connected=false;this.connection='Disconnected / reconnecting';
    for(const a of this.agents.values()){a.status='unknown';a.flags=[];}
    this.emit('change');
    if(!this.retry)this.retry=setTimeout(()=>{this.retry=null;void this.connect();},3000);
  }
  refresh():Promise<void>{
    if(this.refreshing)return this.refreshing;
    if(!this.connected || !this.client)return Promise.resolve();
    const client=this.client;
    this.refreshing=this.reconcile(client).catch(()=>{this.warning='Refresh incomplete; retrying. Metadata may be unavailable.';}).finally(()=>{this.refreshing=null;this.emit('change');});
    return this.refreshing;
  }
  private merge(t:Thread){
    const source=spawnSource.safeParse(t.source);
    if(t.ephemeral || (typeof t.source==='object' && t.source!==null && 'subAgent' in t.source && !source.success))return;
    const old=this.agents.get(t.id);
    const parent=t.parentThreadId || (source.success?source.data.subAgent.thread_spawn.parent_thread_id:null);
    this.agents.set(t.id,{
      id:t.id,parentId:parent,name:t.name,cwd:t.cwd,role:t.agentRole||(source.success?source.data.subAgent.thread_spawn.agent_role:''),nickname:t.agentNickname||(source.success?source.data.subAgent.thread_spawn.agent_nickname:''),
      model:t.model,effort:t.reasoningEffort,prompt:old?.prompt||t.preview,spawnPrompt:old?.spawnPrompt??'',promptSource:old?.promptSource||(t.preview?'session preview':'unavailable'),status:t.status.type,flags:t.status.activeFlags,
      lastActivity:Math.max(old?.lastActivity??0,t.recencyAt??t.updatedAt),lastTurnStatus:old?.lastTurnStatus??'',
    });
  }
  private async list(client:Client,params:object,max=Infinity){
    const threads:Thread[]=[];let cursor:string|null|undefined;const cursors=new Set<string>();
    do{
      const page=pageSchema.parse(await client.request('thread/list',{...params,cursor,limit:100,useStateDbOnly:true,modelProviders:[],archived:false,sortKey:'updated_at'}));
      for(const raw of page.data){const t=threadSchema.safeParse(raw);if(t.success)threads.push(t.data);}
      cursor=page.nextCursor;if(cursor){if(cursors.has(cursor))break;cursors.add(cursor);}
    }while(cursor && threads.length<max);
    return threads.slice(0,max);
  }
  private async reconcile(client:Client){
    this.warning='';const loaded=new Set<string>();let cursor:string|null|undefined;
    do{const p=pageSchema.parse(await client.request('thread/loaded/list',{cursor,limit:100}));for(const id of p.data)if(typeof id==='string')loaded.add(id);cursor=p.nextCursor;}while(cursor);
    const recent=await this.list(client,{sourceKinds:['cli','vscode','exec','appServer','unknown']},20);
    // List metadata is historical; every retained row gets an authoritative read below.
    for(const t of recent)if(!this.agents.has(t.id))this.merge({...t,status:{type:'unknown',activeFlags:[]}});
    const ids=new Set([...loaded,...this.agents.keys()]);
    for(const id of ids)await this.read(client,id);
    // Resolve ancestry of loaded agents even when the root is old or unloaded.
    for(const a of this.agents.values())if(a.parentId && !this.agents.has(a.parentId))await this.read(client,a.parentId);
    const roots=[...this.agents.values()].filter(a=>!a.parentId);
    for(const root of roots){
      const children=await this.list(client,{ancestorThreadId:root.id,sourceKinds:['subAgentThreadSpawn']});
      for(const t of children){if(!this.agents.has(t.id))this.merge({...t,status:{type:'unknown',activeFlags:[]}});if(!ids.has(t.id))await this.read(client,t.id);}
    }
    for(const a of this.agents.values()){
      if(!this.connected)break;
      if(a.status==='active'||!this.historyAt.has(a.id)||Date.now()-(this.historyAt.get(a.id)??0)>60000)await this.history(client,a);
    }
    this.reconciliations++;this.connection='Connected';
  }
  private async read(client:Client,id:string){
    const revision=this.revisions.get(id)??0;
    try{const {thread}=threadResult.parse(await client.request('thread/read',{threadId:id,includeTurns:false}));
      if(!this.connected || this.client!==client)return;
      const before=this.agents.get(id);this.merge(thread);
      if(before && revision!==(this.revisions.get(id)??0)){const current=this.agents.get(id);if(current){current.status=before.status;current.flags=before.flags;}}
    }catch{const a=this.agents.get(id);if(a){a.status='unknown';a.flags=[];}this.warning='Some thread metadata is unavailable';}
  }
  private async history(client:Client,a:Agent){
    try{
      const page=pageSchema.parse(await client.request('thread/turns/list',{threadId:a.id,limit:1,itemsView:this.historyAt.has(a.id)?'summary':'full',sortDirection:'desc'}));
      const turn=turnSchema.safeParse(page.data[0]);
      if(turn.success){
        a.lastTurnStatus=turn.data.status;
        a.lastActivity=Math.max(a.lastActivity,turn.data.completedAt??turn.data.startedAt??0);
        let prompt='';
        for(const raw of turn.data.items){const item=itemSchema.safeParse(raw);if(!item.success)continue;
          if(item.data.type==='userMessage')prompt=(item.data.content??[]).filter(c=>c.type==='text').map(c=>c.text??'').join('\n');
          this.assignment(item.data);
        }
        if(prompt){a.prompt=prompt;a.promptSource=turn.data.status==='inProgress'?'current turn':'latest user input';}
        else if(a.spawnPrompt){a.prompt=a.spawnPrompt;a.promptSource='spawn assignment';}
      }
      if(a.parentId && !this.seenSpawn.has(a.id)){
        const first=pageSchema.parse(await client.request('thread/turns/list',{threadId:a.id,limit:1,itemsView:'full',sortDirection:'asc'}));
        const initial=turnSchema.safeParse(first.data[0]);
        if(initial.success && !a.spawnPrompt && !a.prompt){for(const raw of initial.data.items){const item=itemSchema.safeParse(raw);if(item.success && item.data.type==='userMessage'){a.prompt=(item.data.content??[]).filter(c=>c.type==='text').map(c=>c.text??'').join('\n');a.promptSource='first child input (historical; may be inherited)';break;}}}
        this.seenSpawn.add(a.id);
      }
      if(!a.prompt && a.spawnPrompt){a.prompt=a.spawnPrompt;a.promptSource='spawn assignment';}
    }catch{/* Empty or unsupported histories retain the thread preview. */}
    this.historyAt.set(a.id,Date.now());
  }
  private assignment(item:z.infer<typeof itemSchema>){
    if(item.type!=='collabAgentToolCall' || !item.prompt)return;
    for(const id of item.receiverThreadIds??[]){const a=this.agents.get(id);if(!a)continue;
      if(item.tool==='spawnAgent'){a.spawnPrompt=item.prompt;if(!a.prompt){a.prompt=item.prompt;a.promptSource='spawn assignment';}}
      else if(item.tool==='followupTask'||item.tool==='sendInput'){a.prompt=item.prompt;a.promptSource='recorded follow-up assignment';}
    }
  }
  private notification(method:string,params:unknown){
    this.notificationCount++;
    const parsed=eventSchema.safeParse(params);if(!parsed.success)return;
    const p=parsed.data;let id=p.threadId;
    if(method==='thread/started'){const t=threadSchema.safeParse(p.thread);if(t.success){this.merge(t.data);id=t.data.id;}}
    if(!id)return;
    this.revisions.set(id,(this.revisions.get(id)??0)+1);
    const a=this.agents.get(id);
    if(method==='thread/deleted'||method==='thread/archived')this.agents.delete(id);
    if(a){
      if(method==='thread/status/changed'){const s=z.object({type:z.string(),activeFlags:z.array(z.string()).optional().default([])}).safeParse(p.status);if(s.success){a.status=s.data.type;a.flags=s.data.activeFlags;}}
      if(method==='thread/closed'){a.status='notLoaded';a.flags=[];}
      if(method==='turn/started'||method==='turn/completed'){const t=turnSchema.safeParse(p.turn);if(t.success)a.lastTurnStatus=t.data.status;this.historyAt.delete(id);}
      if(method.startsWith('turn/')||method.startsWith('item/'))a.lastActivity=Date.now()/1000;
      const item=itemSchema.safeParse(p.item);if(item.success)this.assignment(item.data);
    }
    this.emit('change');
    if(!this.debounce && /^(thread\/|turn\/)/.test(method))this.debounce=setTimeout(()=>{this.debounce=null;void this.refresh();},750);
  }
  stop(){this.stopped=true;if(this.interval)clearInterval(this.interval);if(this.retry)clearTimeout(this.retry);if(this.debounce)clearTimeout(this.debounce);this.client?.close();}
}
