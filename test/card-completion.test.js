import test from 'node:test';
import assert from 'node:assert/strict';
import {Conversation} from '../src/chat/conversation.js';
import {FakeContext,env,input} from './helpers.js';

async function cardCompletion(t,{text='幫我做一張莉亞的卡片，先搜尋人物，再設計職業和能力，做強一點',failedVision=false}={}){
 const ctx=new FakeContext(),renders=[],posts=[],requests=[];
 const localEnv={...env,FUN_API_TOKEN:'test-renderer',FUN:{fetch:async(_url,init)=>{
  const card=JSON.parse(init.body);renders.push(card);
  const bytes=new Uint8Array(1024);bytes.set([137,80,78,71,13,10,26,10]);
  return new Response(bytes,{headers:{'Content-Type':'image/png'}});
 }},BUDGET:{getByName:()=>({fetch:async()=>Response.json({})})}};
 let completion,sequence=0;
 const event=e=>({...e,id:`event-${++sequence}`,processed_at:`2026-10-15T15:21:${String(sequence).padStart(2,'0')}Z`});
 t.mock.method(globalThis,'fetch',async(raw,init={})=>{
  const url=new URL(raw),body=init.body instanceof FormData?JSON.parse(init.body.get('payload_json')):init.body?JSON.parse(init.body):undefined;
  requests.push({path:url.pathname,method:init.method,body});
  if(url.hostname==='cdn.discordapp.com')return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC','base64'),{headers:{'Content-Type':'image/png'}});
  if(url.hostname==='discord.com'){posts.push({body,multipart:init.body instanceof FormData});return Response.json({id:'card-message'});}
  if(url.pathname==='/v1/sessions'&&init.method==='POST'){
   completion={id:'completion',status:'idle',usage:{list_cost:{amount:'1',currency:'USD'}},events:[],tools:body.agent.tools};
   return Response.json({id:completion.id});
  }
  if(url.pathname.startsWith('/v1/sessions/completion')){
   if(init.method==='DELETE')return new Response(null,{status:204});
   if(url.pathname.endsWith('/events')){
    if(init.method==='POST'){
     const submitted=body.events.map(event);completion.events.push(...submitted);
     const allowed=completion.tools.some(tool=>tool.name==='make_custom_card');
     completion.events.push(event({type:'agent.message',content:[{type:'text',text:allowed?'以她保護同伴的設定，設計為主教。':'莉亞：4費4/4，守護。要配立繪的話，再把 PNG 傳給我。'}]}));
     if(allowed)completion.events.push(event({type:'agent.custom_tool_use',name:'make_custom_card',input:{name:'莉亞',craft:6,cost:4,type:'follower',attack:4,defense:4,effect:'入場曲 抽取1張卡片。\n守護',artwork_index:1}}));
     completion.events.push(event({type:'session.status_idle',stop_reason:{type:allowed?'requires_action':'end_turn'}}));
     return Response.json({data:submitted});
    }
    return Response.json({data:completion.events});
   }
   return Response.json(completion);
  }
  if(url.pathname.endsWith('/events'))return Response.json({data:[
   {id:'own',type:'user.message',processed_at:'2026-10-15T15:21:00Z',content:[{type:'text',text}]},
   {id:'facts',type:'user.custom_tool_result',processed_at:'2026-10-15T15:21:01Z',content:[{type:'text',text:JSON.stringify({status:'ok',source:'https://example.com/profile',text:'莉亞是虛構學院角色，保護同伴並治癒隊友。'})}]},
  ]});
  return Response.json({id:'research',status:'idle',usage:{list_cost:{amount:'9',currency:'USD'}}});
 });
 const conversation=new Conversation(ctx,localEnv);await ctx.ready;
 conversation.state.sessionId='research';
 conversation.state.current={phase:'complete-prepare',startedAt:Date.now(),input:input('card',{text,
  images:[{id:'123',channelId:'456',messageId:'card',url:'https://cdn.discordapp.com/attachments/456/123/art.png',filename:'art.png',mediaType:'image/png',source:'upload'}],
  imageReport:[{filename:'art.png',source:'upload',status:failedVision?'unavailable':'loaded'}],
  memory:'先前另一張卡的圖片失敗，請使用者重新上傳 PNG。',
 }),userEventId:'own',seenEvents:[],toolResults:{},baseline:0,priorCents:6,capCents:12,answerReserve:4,
  reservation:{allowance:20},finalizationAttempted:true,outputChars:0};
 for(let i=0;i<8&&conversation.state.current;i++)await conversation.tick();
 return {conversation,renders,posts,requests,completion};
}

test('budget completion still renders the requested card with the current successfully loaded attachment',async t=>{
 const h=await cardCompletion(t);
 assert.equal(h.renders.length,1,'The budget handoff must produce the requested PNG, not just a text design');
 assert.ok(h.renders[0].artwork.startsWith('data:image/png;base64,'));
 assert.ok(h.posts.some(p=>p.multipart));
 assert.equal(h.conversation.state.current,null);
 assert.ok(h.completion.tools.some(tool=>tool.name==='make_custom_card'));
 assert.ok(!h.completion.tools.some(tool=>tool.name==='read_svwb_source'||tool.type==='agent_toolset_20260401'));
 assert.doesNotMatch(h.posts.at(-1).body.content,/再.*PNG|重新.*上傳/);
});

test('a vision failure does not remove an attachment that the renderer can still load',async t=>{
 const h=await cardCompletion(t,{failedVision:true});
 assert.equal(h.renders.length,1);assert.ok(h.renders[0].artwork);
});

test('capability questions and explicitly text-only designs do not gain rendering permission',async t=>{
 for(const text of ['你能做卡片嗎？','幫我設計一張卡片，只要文字，不要出圖']){
  const h=await cardCompletion(t,{text});assert.equal(h.renders.length,0);
 }
});
