import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {deflateSync} from 'node:zlib';
import {Conversation,readCost} from '../src/chat/conversation.js';
import {claude} from '../src/chat/api.js';
import {FakeContext} from '../test/helpers.js';

// Fresh fictional test data only: never replay/export a real Discord trace.
function fixturePng(){
 const crc=b=>{let n=0xffffffff;for(const v of b){n^=v;for(let i=0;i<8;i++)n=n&1?(n>>>1)^0xedb88320:n>>>1;}return (n^0xffffffff)>>>0;};
 const chunk=(name,data)=>{const type=Buffer.from(name),bytes=Buffer.concat([type,data]),head=Buffer.alloc(4),tail=Buffer.alloc(4);head.writeUInt32BE(data.length);tail.writeUInt32BE(crc(bytes));return Buffer.concat([head,bytes,tail]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(64,0);header.writeUInt32BE(64,4);header[8]=8;header[9]=2;
 const raw=Buffer.alloc(64*(1+64*3));for(let y=0;y<64;y++)for(let x=0;x<64;x++){const p=y*193+1+x*3;raw[p]=120+x*2;raw[p+1]=100+y*2;raw[p+2]=220;}
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
const config=JSON.parse(await readFile('wrangler.chat.local.json','utf8'));
const secrets=JSON.parse(await readFile('.chat-secrets.json','utf8'));
const fun=JSON.parse(await readFile('C:/dev/svwb-fun-cards/.fun-secrets.json','utf8'));
const realFetch=globalThis.fetch,sessions=new Set(),posts=[],png=fixturePng();let rendererCalls=0,completionCents=0;
const env={...config.vars,...secrets,FUN_API_TOKEN:fun.RENDER_API_TOKEN,
 FUN:{fetch:async(url,init)=>{rendererCalls++;return realFetch('https://svwb-fun-bot.svwb-deckhelper.workers.dev'+new URL(url).pathname,init);}},
 BUDGET:{getByName:()=>({fetch:async()=>Response.json({})})}};
globalThis.fetch=async(raw,init={})=>{
 const url=new URL(raw);
 if(url.hostname==='cdn.discordapp.com'){assert.equal(url.pathname,'/attachments/456/123/fixture.png');return new Response(png,{headers:{'Content-Type':'image/png'}});}
 if(url.hostname==='discord.com'){
  const multipart=init.body instanceof FormData,body=multipart?JSON.parse(init.body.get('payload_json')):JSON.parse(init.body);
  posts.push({method:init.method,body,multipart});
  if(multipart)await writeFile('.wrangler/card-completion-live.png',new Uint8Array(await init.body.get('files[0]').arrayBuffer()));
  return Response.json({id:'captured-card'});
 }
 if(url.pathname.startsWith('/v1/sessions/fixture-research')){
  if(url.pathname.endsWith('/events'))return Response.json({data:[{id:'own',type:'user.message',processed_at:'2026-10-15T15:21:00Z',content:[{type:'text',text:'此為全新虛構人物測試。使用者提供的人物設定：莉亞保護同伴，能治癒隊友，不引用任何真實人物資料。'}]}]});
  return Response.json({id:'fixture-research',status:'idle',usage:{list_cost:{amount:'9',currency:'USD'}}});
 }
 if(url.hostname==='api.anthropic.com'&&init.method==='DELETE'){
  completionCents=readCost(await claude(env,`/sessions/${url.pathname.split('/').at(-1)}`));
 }
 const response=await realFetch(raw,init);
 if(url.hostname==='api.anthropic.com'&&url.pathname==='/v1/sessions'&&init.method==='POST'&&response.ok)sessions.add((await response.clone().json()).id);
 if(init.method==='DELETE'&&response.ok)sessions.delete(url.pathname.split('/').at(-1));
 return response;
};
try{
 const ctx=new FakeContext(),conversation=new Conversation(ctx,env);await ctx.ready;
 conversation.state.sessionId='fixture-research';
 conversation.state.current={phase:'complete-prepare',startedAt:Date.now(),input:{id:'synthetic-card',guildId:env.ALLOWED_GUILD_IDS.split(',')[0],channelId:'456',authorId:'test',
  text:'幫我做一張莉亞的卡片，依已提供的虛構人物設定設計職業和能力，做強一點。',
  images:[{id:'123',channelId:'456',messageId:'synthetic-card',url:'https://cdn.discordapp.com/attachments/456/123/fixture.png',filename:'fixture.png',mediaType:'image/png',source:'upload'}],
  imageReport:[{filename:'fixture.png',source:'upload',status:'loaded'}],memory:'先前另一張測試卡的立繪失敗，當時曾要求重傳。'},
  userEventId:'own',seenEvents:[],toolResults:{},baseline:0,priorCents:6,capCents:12,answerReserve:4,reservation:{allowance:20},finalizationAttempted:true,outputChars:0};
 for(let i=0;i<60&&conversation.state.current;i++){
  await conversation.alarm();if(conversation.state.current)await new Promise(r=>setTimeout(r,1500));
 }
 assert.equal(conversation.state.current,null,'Completion must finish');
 assert.equal(rendererCalls,1);assert.equal(posts.filter(p=>p.multipart).length,1);
 assert.equal(conversation.state.lastFunCard.artwork.id,'123');
 assert.doesNotMatch(posts.at(-1).body.content,/再.*PNG|重新.*上傳|尚未製作完成/);
 console.log(JSON.stringify({passed:true,rendererCalls,completionCents,realDiscordPosts:0,image:'.wrangler/card-completion-live.png',final:posts.at(-1).body.content}));
}finally{
 for(const id of sessions)await claude(env,`/sessions/${id}`,'DELETE').catch(()=>{});
 globalThis.fetch=realFetch;
}
