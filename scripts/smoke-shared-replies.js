import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Conversation} from '../src/chat/conversation.js';
import {DiscordGateway} from '../src/chat/gateway.js';
import {DailyBudget} from '../src/chat/budget.js';
import {claude} from '../src/chat/api.js';
import {FakeContext} from '../test/helpers.js';

const config=JSON.parse(await readFile('wrangler.chat.local.json','utf8'));
const secrets=JSON.parse(await readFile('.chat-secrets.json','utf8'));
const realFetch=globalThis.fetch,sessions=new Set(),objects=new Map(),messages=new Map(),replies=[];
const guildId=config.vars.ALLOWED_GUILD_IDS.split(',')[0];let sequence=0;
const env={...config.vars,...secrets,DAILY_BUDGET_CENTS:'100',MAINTENANCE_BUDGET_CENTS:'0'};
const budgetCtx=new FakeContext(),budget=new DailyBudget(budgetCtx,env);await budgetCtx.ready;
env.BUDGET={getByName:()=>({fetch:(url,init)=>budget.fetch(new Request(url,init))})};
const gatewayCtx=new FakeContext(),gateway=new DiscordGateway(gatewayCtx,env);await gatewayCtx.ready;
gateway.state.botId='999';gateway.state.enabled=true;
env.GATEWAY={getByName:()=>({fetch:(url,init)=>gateway.fetch(new Request(url,init))})};
env.CONVERSATIONS={getByName:key=>({fetch:async(url,init)=>{
 if(!objects.has(key)){const ctx=new FakeContext(),conversation=new Conversation(ctx,env);await ctx.ready;objects.set(key,conversation);}
 const body=JSON.parse(init.body);Object.assign(body,{decks:[],meta:null,cards:null,guides:null});
 return objects.get(key).fetch(new Request(url,{...init,body:JSON.stringify(body)}));
}})};
globalThis.fetch=async(raw,init={})=>{
 const u=new URL(raw);
 if(u.hostname==='discord.com'){
  if(u.pathname.endsWith('/typing'))return new Response(null,{status:204});
  if(init.method==='POST'&&u.pathname.endsWith('/messages')){
   const body=JSON.parse(init.body),id=`captured-${++sequence}`;
   const result={...body,id,type:19,channel_id:'456',guild_id:guildId,author:{id:'999',bot:true}};
   messages.set(id,result);replies.push(result);return Response.json(result);
  }
  const id=u.pathname.match(/\/messages\/([^/]+)$/)?.[1];
  return Response.json(id?messages.get(id):{type:0});
 }
 const response=await realFetch(raw,init);
 if(u.hostname==='api.anthropic.com'&&u.pathname==='/v1/sessions'&&init.method==='POST'&&response.ok)sessions.add((await response.clone().json()).id);
 if(init.method==='DELETE'&&response.ok)sessions.delete(u.pathname.split('/').at(-1));
 return response;
};
const message=(id,author,content,target)=>({id,guild_id:guildId,channel_id:'456',type:target?19:0,author:{id:author,username:author},content,
 mentions:target?[]:[{id:'999'}],...(target?{message_reference:{message_id:target.id,channel_id:'456'},referenced_message:target}:{})});
try{
 let originalSession;
 const turns=[['a','111','<@999> 這段牌組討論先約定名稱叫「星河龍族42」，職業是龍族。只是記住我們自訂的公開討論名稱，不用查資料或推薦牌組。請只回答「記住了」。'],
  ['b','222','我是新加入的人。原作者剛才約定的牌組討論名稱是什麼？這是同頻道公開遊戲討論，直接回答，不用查資料。'],
  ['c','333','我也是新加入的人，再說一次這段牌組討論的自訂名稱。直接回答，不用查資料。']];
 for(const [index,[id,author,text]]of turns.entries()){
  const m=message(id,author,text,index?replies.at(-1):undefined);messages.set(id,m);
  await gateway.receive(m);await gateway.drain();
  const key=`${guildId}:456:111`,conversation=objects.get(key);assert.ok(conversation,'Every reply must route to the original actor');
  for(let i=0;i<70&&(conversation.state.current||conversation.state.queue.length);i++){
   await conversation.alarm();if(conversation.state.current)await new Promise(r=>setTimeout(r,1500));
  }
  assert.equal(conversation.state.current,null);
  if(index)assert.equal(conversation.state.sessionId,originalSession);else originalSession=conversation.state.sessionId;
  if(index)assert.match(replies.at(-1).content,/星河龍族42/);
 }
 const fresh=message('fresh-b','222','<@999> 新問題');await gateway.receive(fresh);
 assert.equal(gateway.state.pending.at(-1).key,`${guildId}:456:222`);
 assert.equal(objects.size,1);
 console.log(JSON.stringify({passed:true,participants:3,sharedAgentSessions:1,freshMentionIsolated:true,realDiscordPosts:0,replies:replies.map(r=>r.content)}));
}finally{
 for(const id of sessions)await claude(env,`/sessions/${id}`,'DELETE').catch(()=>{});
 globalThis.fetch=realFetch;
}
