import assert from 'node:assert/strict';
import {deckCache,simpleDeckRequest} from '../src/chat/deck-cache.js';
import {Conversation} from '../src/chat/conversation.js';
import {FakeContext,env,input} from '../test/helpers.js';

assert.ok(deckCache.metadata.available);
const text='來一套有帶ハウリングウルフマン的妖精';
const result=deckCache.search({...simpleDeckRequest(text),limit:1});
assert.equal(result.filters.card_ids[0],'10612120');assert.ok(result.total>0);
assert.equal(result.decks[0].cards.find(c=>c.id==='10612120').quantity,3);
let external=0;const delivered=[];
globalThis.fetch=async(url,options={})=>{
 const u=new URL(url);
 if(u.hostname==='discord.com'){
  if(u.pathname.endsWith('/typing'))return new Response(null,{status:204});
  delivered.push(options.body instanceof FormData?JSON.parse(options.body.get('payload_json')):JSON.parse(options.body));
  return Response.json({id:'sent-'+delivered.length});
 }
 assert.ok(delivered.length,'Useful text must precede image/code requests');
 assert.equal(u.hostname,'shadowverse-wb.com','No AI or research requests allowed');external++;
 return new Response(null,{status:503});
};
const ctx=new FakeContext(),conversation=new Conversation(ctx,env);await ctx.ready;
await conversation.fetch(new Request('https://conversation/',{method:'POST',body:JSON.stringify(input('cache-smoke',{text}))}));
const start=performance.now();await conversation.tick();
assert.equal(conversation.state.current,null);assert.equal(delivered.length,2);
assert.match(delivered[0].content,/3 張嚎聲狼人/);assert.match(delivered[0].content,/官方牌表/);
assert.match(delivered[1].content,/暫時無法取得牌組代碼/);
assert.equal(conversation.state.lastCompletedAnswer.question,text);
console.log(JSON.stringify({passed:true,decks:deckCache.metadata.count,matched:result.total,requiredCopies:3,aiRequests:0,researchRequests:0,deliveryRequests:external,elapsedMs:Math.round(performance.now()-start)}));
