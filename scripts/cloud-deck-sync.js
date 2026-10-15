import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {boundedJson,deckRevision} from '../src/chat/deck-library-data.js';

// Runs inside Claude Managed Agents' cloud sandbox. No deployment/admin token
// is present: the scoped vault credential permits only this database endpoint.
const endpoint='https://svwb-chat-bot.svwb-deckhelper.workers.dev/internal/deck-library';
async function run(){
  const token=process.env.SVWB_DECK_SYNC_TOKEN;
  if(!token)throw Error('Missing scoped sync credential');
  const headers={'X-SVWB-Deck-Sync':token};
  const read=await fetch(endpoint,{headers,redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!read.ok)throw Error(`Read cloud library HTTP ${read.status}`);
  const baseline=await boundedJson(read);
  if(baseline.schemaVersion!==1||!baseline.revision||!baseline.decks?.length)throw Error('Cloud seed unavailable');
  await mkdir('data',{recursive:true});
  await writeFile('data/deck-library.json',JSON.stringify(baseline));
  // A source outage preserves that site's old records while other successfully
  // validated sources can still add builds. The failure remains visible.
  process.argv.push('--allow-partial');
  await import('./sync-deck-library.js');
  if(process.exitCode)throw Error('Source sync failed; previous cloud library retained');
  const data=JSON.parse(await readFile('data/deck-library.json','utf8'));
  if(!['ok','partial'].includes(data.syncStatus)||data.revision!==await deckRevision(data.decks))throw Error('Invalid synchronized library');
  const updated=await fetch(endpoint,{method:'PUT',headers:{...headers,'Content-Type':'application/json','If-Match':baseline.revision},
    body:JSON.stringify(data),redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!updated.ok)throw Error(`Publish cloud library HTTP ${updated.status}`);
  const result=await updated.json();
  if(!['ok','partial'].includes(result.status)||result.revision!==data.revision)throw Error('Cloud publication was not verified');
  console.log(JSON.stringify({status:result.status,changed:result.changed,decks:result.count,revision:result.revision,lastCloudSyncAt:result.lastCloudSyncAt,sourceErrors:result.sourceErrors}));
}
run().catch(error=>{console.error(error.message);process.exitCode=1;});
