import { EventEmitter } from 'node:events';
import net from 'node:net';
import WebSocket from 'ws';
import { z } from 'zod';

const methods = ['initialize', 'thread/list', 'thread/loaded/list', 'thread/read', 'thread/turns/list'] as const;
type ReadMethod = typeof methods[number];
const envelope = z.object({id:z.union([z.number(),z.string()]).optional(),method:z.string().optional(),params:z.unknown().optional(),result:z.unknown().optional(),error:z.object({code:z.number()}).optional()});
export class RpcError extends Error {
  constructor(public code:number) { super(`App-server error ${code}`); }
}
export class Client extends EventEmitter {
  private ws:WebSocket|null=null;
  private serial=0;
  private pending=new Map<number,{resolve:(v:unknown)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  async connect(socket:string) {
    const ws=new WebSocket('ws://localhost/rpc',{perMessageDeflate:false,handshakeTimeout:5000,createConnection:()=>net.connect(socket),maxPayload:64*1024*1024});
    this.ws=ws;
    ws.on('message',data=>{
      try {
        const m=envelope.parse(JSON.parse(data.toString()));
        if(typeof m.id==='number') {
          const p=this.pending.get(m.id); if(!p)return;
          clearTimeout(p.timer);this.pending.delete(m.id);
          if(m.error)p.reject(new RpcError(m.error.code));else p.resolve(m.result);
        } else if(m.id===undefined && m.method) this.emit('notification',m.method,m.params);
        // Never answer server requests: this client does not own any thread.
      } catch { this.emit('protocolWarning'); }
    });
    ws.on('close',()=>{this.rejectPending();this.emit('disconnect');});
    ws.on('error',()=>{});
    await new Promise<void>((resolve,reject)=>{ws.once('open',resolve);ws.once('error',()=>reject(new Error('Cannot connect to daemon socket')));});
    const result=await this.request('initialize',{clientInfo:{name:'codex_agent_monitor',title:'Codex Agent Monitor',version:'0.1.0'},capabilities:{experimentalApi:true}});
    ws.send(JSON.stringify({method:'initialized'}));
    return z.object({userAgent:z.string().optional(),codexHome:z.string().optional()}).parse(result);
  }
  request(method:ReadMethod,params:object={}):Promise<unknown> {
    if(!methods.includes(method))return Promise.reject(new Error('Read-only method rejected'));
    const ws=this.ws;
    if(!ws || ws.readyState!==WebSocket.OPEN)return Promise.reject(new Error('Disconnected'));
    return new Promise((resolve,reject)=>{
      const id=++this.serial;
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Timed out: ${method}`));ws.terminate();},10000);
      this.pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));
    });
  }
  private rejectPending(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Disconnected'));}this.pending.clear();}
  close(){this.rejectPending();this.ws?.terminate();this.ws=null;}
}

const nullableText=z.string().nullish().transform(v=>v??'');
export const threadSchema=z.object({
  id:z.string(),parentThreadId:nullableText,name:nullableText,cwd:nullableText,
  agentRole:nullableText,agentNickname:nullableText,model:nullableText,reasoningEffort:nullableText,
  preview:nullableText,updatedAt:z.number().optional().default(0),recencyAt:z.number().nullish(),
  ephemeral:z.boolean().optional().default(false),source:z.unknown(),
  status:z.object({type:z.string(),activeFlags:z.array(z.string()).optional().default([])}),
});
export type Thread=z.infer<typeof threadSchema>;
export const spawnSource=z.object({subAgent:z.object({thread_spawn:z.object({parent_thread_id:z.string(),agent_role:nullableText,agent_nickname:nullableText,agent_path:nullableText})})});
export const pageSchema=z.object({data:z.array(z.unknown()),nextCursor:z.string().nullish()});
export const itemSchema=z.object({type:z.string(),content:z.array(z.object({type:z.string(),text:z.string().optional()})).optional(),tool:z.string().optional(),prompt:nullableText,receiverThreadIds:z.array(z.string()).optional(),model:nullableText,reasoningEffort:nullableText});
export const turnSchema=z.object({id:z.string(),status:z.string(),startedAt:z.number().nullish(),completedAt:z.number().nullish(),items:z.array(z.unknown()).optional().default([])});
