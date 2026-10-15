import { readFile, writeFile } from 'node:fs/promises';
import { claude, messageText } from '../src/chat/api.js';
import { userEvent, readCost } from '../src/chat/conversation.js';
import { loadImages } from '../src/chat/vision.js';
const setup = JSON.parse(await readFile('.chat-setup.json','utf8'));
const version = Number(process.argv[3] || setup.agentVersion);
const bytes = new Uint8Array(await readFile(process.argv[2] || '.wrangler/deck-preview.png'));
let session;
try {
  const descriptor = { id:'111', channelId:'456', messageId:'123', filename:'vision-fixture.png', source:'upload',
    url:'https://cdn.discordapp.com/attachments/456/111/vision-fixture.png' };
  // Exercise the production decoder with local test pixels; no Discord post.
  const loaded = await loadImages(process.env, { images:[descriptor] }, async () => new Response(bytes,{headers:{'Content-Type':'image/png'}}));
  if (loaded.report[0].status !== 'loaded') throw Error('Image preparation failed');
  session = await claude(process.env,'/sessions','POST', {
    agent:{type:'agent',id:setup.agentId,version}, environment_id:setup.environmentId,
    title:'SVWB image recognition regression',budget:{type:'limit',max_list_cost:{amount:'5',currency:'USD'}},
  });
  const replies=[];
  for (let turn=0;turn<2;turn++) {
    const event=userEvent({id:`vision-${turn}`,authorId:'test',authorName:'測試',
      text:turn===0?'只看附圖，不搜尋。請說出職業、總張數，以及從者、法術、護符各有幾張。看不清楚的地方不要猜。':'不搜尋，也不用重新看圖：剛才圖片中的法術總共有幾張？',
      ...(turn===0?{imageReport:loaded.report}:{}) });
    if(turn===0)event.content.push(...loaded.blocks);
    const sent=await claude(process.env,`/sessions/${session.id}/events`,'POST',{events:[event]});
    let finished=false;
    for(let i=0;i<60;i++) {
      const events=await claude(process.env,`/sessions/${session.id}/events?order=asc&limit=100`);
      const n=events.data.findIndex(e=>e.id===sent.data[0].id&&e.processed_at);
      const current=n<0?[]:events.data.slice(n),end=current.find(e=>e.type==='session.status_idle');
      if(end) {
        if(end.stop_reason?.type!=='end_turn')throw Error('Vision turn did not finish');
        replies.push(current.filter(e=>e.type==='agent.message').map(e=>messageText(e.content)).join('\n'));
        finished=true;break;
      }
      await new Promise(r=>setTimeout(r,3000));
    }
    if(!finished)throw Error('Vision timed out');
  }
  const result={agentVersion:version,replies,listCostCents:readCost(await claude(process.env,`/sessions/${session.id}`))};
  await writeFile('.wrangler/vision-check.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  if(!/龍族/.test(replies[0])||!replies[0].includes('40')||!replies[0].includes('32')||!replies[0].includes('8')||!/[8８八]/.test(replies[1])) throw Error('Image facts or follow-up memory did not match fixture');
  if(/8\s*種|八種|逐張.{0,15}核對/.test(replies[0])) throw Error('Unsupported card-by-card verification claim');
} catch(error) {console.error(error.status?`HTTP ${error.status}`:error.message);process.exitCode=1;}
finally {if(session)await claude(process.env,`/sessions/${session.id}`,'DELETE').catch(()=>console.error('Test session cleanup needs retry'));}
