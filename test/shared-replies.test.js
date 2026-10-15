import test from 'node:test';
import assert from 'node:assert/strict';
import {DiscordGateway} from '../src/chat/gateway.js';
import {discord,sendText} from '../src/chat/api.js';
import {FakeContext,env,message} from './helpers.js';

const botMessage=(id='bot-a',extra={})=>({id,channel_id:'456',author:{id:'999',bot:true},content:'這是原對話的答案',...extra});
const reply=(id,author,target)=>message({id,type:19,author:{id:author,username:author},content:'那繼續剛才的話題',mentions:[],
 message_reference:{message_id:target.id,channel_id:'456',guild_id:'123'},referenced_message:target});
const register=(gateway,id,key='123:456:789',ownerId='789')=>gateway.fetch(new Request('https://gateway/register-reply',{
 method:'POST',body:JSON.stringify({guildId:'123',channelId:'456',messageId:id,key,ownerId}),
}));

test('different speakers follow bot replies into the original context across gateway restarts',async t=>{
 const ctx=new FakeContext(),gateway=new DiscordGateway(ctx,env);await ctx.ready;gateway.state.botId='999';
 t.mock.method(globalThis,'fetch',async()=>Response.json({type:0}));
 await gateway.receive(message());await register(gateway,'bot-a');
 await gateway.receive(reply('b','person-b',botMessage()));
 assert.equal(gateway.state.pending.at(-1).key,'123:456:789');
 assert.equal(gateway.state.pending.at(-1).authorId,'person-b');
 assert.equal(gateway.state.pending.at(-1).sharedReply,true);
 await register(gateway,'bot-b');
 const restarted=new DiscordGateway(ctx,env);await ctx.ready;
 await restarted.receive(reply('c','person-c',botMessage('bot-b')));
 assert.equal(restarted.state.pending.at(-1).key,'123:456:789');
 await restarted.receive(message({id:'new-b',author:{id:'person-b'},content:'<@999> 新問題'}));
 assert.equal(restarted.state.pending.at(-1).key,'123:456:person-b');
});

test('legacy bot replies recover the original author through validated Discord reply links',async t=>{
 const ctx=new FakeContext(),gateway=new DiscordGateway(ctx,env);await ctx.ready;gateway.state.botId='999';
 const root=message({id:'root-a'}),old=botMessage('legacy-a',{type:19,message_reference:{message_id:'root-a',channel_id:'456'}});
 t.mock.method(globalThis,'fetch',async raw=>Response.json(new URL(raw).pathname.endsWith('/messages/root-a')?root:{type:0}));
 await gateway.receive(reply('legacy-join','person-b',old));
 const joined=gateway.state.pending.at(-1);
 assert.equal(joined.key,'123:456:789');assert.equal(joined.conversationOwnerId,'789');
 assert.equal(joined.replyContext.fullConversation,true);
 assert.ok(gateway.state.replyRoutes['123:456:legacy-a']);
});

test('unknown bot messages keep quoted context; cross-channel and webhook messages cannot supply inherited routes',async t=>{
 const ctx=new FakeContext(),gateway=new DiscordGateway(ctx,env);await ctx.ready;gateway.state.botId='999';
 t.mock.method(globalThis,'fetch',async()=>Response.json({type:0}));
 await gateway.receive(reply('unknown','person-b',botMessage('untracked')));
 assert.equal(gateway.state.pending.at(-1).key,'123:456:person-b');
 assert.equal(gateway.state.pending.at(-1).replyContext.fullConversation,false);
 assert.equal((await register(gateway,'bad','123:other:789')).status,400);
 assert.equal((await register(gateway,'bad','123:456:789','another-owner')).status,400);
 await register(gateway,'protected');assert.equal((await register(gateway,'protected','123:456:person-b','person-b')).status,400);
});

test('partial legacy bot references are completed from the exact channel before recovering their origin',async t=>{
 const ctx=new FakeContext(),gateway=new DiscordGateway(ctx,env);await ctx.ready;gateway.state.botId='999';
 t.mock.method(globalThis,'fetch',async raw=>{
  const path=new URL(raw).pathname;
  return Response.json(path.endsWith('/messages/legacy')?botMessage('legacy',{type:19,message_reference:{message_id:'root',channel_id:'456'}}):
    path.endsWith('/messages/root')?message({id:'root'}):{type:0});
 });
 await gateway.receive(reply('join','person-b',botMessage('legacy')));
 assert.equal(gateway.state.pending.at(-1).key,'123:456:789');
});

test('all text chunks, edits and image messages register the same context; registration loss is retryable',async t=>{
 const registered=[],posts=[];
 const scoped={...env,REPLY_CONTEXT:{guildId:'123',channelId:'456',key:'123:456:789',ownerId:'789'},
 GATEWAY:{getByName:()=>({fetch:async(_url,init)=>{registered.push(JSON.parse(init.body));return Response.json({accepted:true});}})}};
 t.mock.method(globalThis,'fetch',async(raw,init)=>{posts.push(init.body);return Response.json({id:'sent-'+posts.length});});
 await sendText(scoped,'456','甲'.repeat(2500),'chunks','original');
 await sendText(scoped,'456','更新後內容','edit','original','sent-1');
 const form=new FormData();form.set('payload_json',JSON.stringify({content:'卡圖'}));
 await discord(scoped,'/channels/456/messages','POST',form);
 assert.equal(registered.length,4);assert.ok(registered.every(r=>r.key==='123:456:789'));
 scoped.GATEWAY.getByName=()=>({fetch:async()=>new Response(null,{status:503})});
 await assert.rejects(sendText(scoped,'456','重試','stable','original'),/registration failed/);
});
