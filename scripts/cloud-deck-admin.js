import {readFile,writeFile} from 'node:fs/promises';
import {claude,messageText} from '../src/chat/api.js';
const setup=JSON.parse(await readFile('.deck-sync-setup.json','utf8'));
const action=process.argv[2]||'status';
if(action==='run'){
 const run=await claude(process.env,`/deployments/${setup.deploymentId}/run`,'POST',{});
 setup.lastRunId=run.id;setup.lastSessionId=run.session_id;
 await writeFile('.deck-sync-setup.json',JSON.stringify(setup,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({runId:run.id,sessionId:run.session_id,error:run.error}));
}else if(action==='status'){
 const deployment=await claude(process.env,`/deployments/${setup.deploymentId}`);
 console.log(JSON.stringify({deploymentId:deployment.id,status:deployment.status,schedule:deployment.schedule,budget:deployment.budget}));
 if(setup.lastSessionId){
  const session=await claude(process.env,`/sessions/${setup.lastSessionId}`);
  console.log(JSON.stringify({sessionId:session.id,status:session.status,usage:session.usage}));
  if(session.status==='idle'){
   const events=await claude(process.env,`/sessions/${setup.lastSessionId}/events?order=desc&limit=50`);
   console.log(JSON.stringify({answer:events.data.filter(e=>e.type==='agent.message').map(e=>messageText(e.content)).join('\n').slice(0,1800),
    stops:events.data.filter(e=>e.type==='session.status_idle').map(e=>e.stop_reason)}));
  }
 }
}else throw Error('Use run or status');
