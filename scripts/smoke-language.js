import {readFile,writeFile} from 'node:fs/promises';
import {claude,messageText} from '../src/chat/api.js';
import {userEvent,readCost} from '../src/chat/conversation.js';
const setup=JSON.parse(await readFile('.chat-setup.json','utf8'));
const version=Number(process.argv[2]||setup.agentVersion);
let session;
try{
 session=await claude(process.env,'/sessions','POST',{agent:{type:'agent',id:setup.agentId,version},environment_id:setup.environmentId,title:'SVWB Chinese search regression',budget:{type:'limit',max_list_cost:{amount:'20',currency:'USD'}}});
 const sent=await claude(process.env,`/sessions/${session.id}/events`,'POST',{events:[userEvent({id:'language-check',authorId:'test',authorName:'測試',text:'最近主教有什麼強牌嗎？請用網路搜尋查證，簡短整理並附來源。'})]});
 for(let i=0;i<60;i++){
  const e=await claude(process.env,`/sessions/${session.id}/events?order=asc&limit=100`);
  const n=e.data.findIndex(x=>x.id===sent.data[0].id&&x.processed_at);
  const current=n<0?[]:e.data.slice(n),end=current.find(x=>x.type==='session.status_idle');
  if(end){
   const reply=current.filter(x=>x.type==='agent.message').map(x=>messageText(x.content)).join('\n');
   const tools=current.filter(x=>x.type==='agent.tool_use').map(x=>x.name);
   const finished=await claude(process.env,`/sessions/${session.id}`);
   const prose=reply.replace(/https?:\/\/[^\s)]+/g,'');
   const longEnglish=/\b[A-Za-z]+(?:[ ,;:\-]+[A-Za-z]+){8,}/.test(prose);
   const result={agentVersion:version,tools,reply,longEnglish,listCostCents:readCost(finished),stopReason:end.stop_reason};
   console.log(JSON.stringify(result));await writeFile(`.wrangler/language-check-v${version}.json`,JSON.stringify(result));
   if(end.stop_reason?.type!=='end_turn'||!tools.includes('web_search')||longEnglish||!reply.includes('主教'))throw Error('Language/search regression failed');
   break;
  }
  if(i===59)throw Error('Timed out');
  await new Promise(r=>setTimeout(r,3000));
 }
}catch(e){console.error(e.status?`HTTP ${e.status}`:e.message);process.exitCode=1;}
finally{if(session)await claude(process.env,`/sessions/${session.id}`,'DELETE').catch(()=>console.error('Test session cleanup needs retry'));}
