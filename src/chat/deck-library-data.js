// A stable digest excludes check timestamps, which change on every daily run.
export function deckRevisionContent(decks) {
  return JSON.stringify([...decks].sort((a,b)=>a.id.localeCompare(b.id)).map(d=>({
    id:d.id,deckUrl:d.deckUrl,classId:d.classId,format:d.format,cards:d.cards,archetype:d.archetype,
    sources:d.sources.map(({checkedAt,...source})=>source).sort((a,b)=>a.url.localeCompare(b.url)),
  })));
}

export async function deckRevision(decks) {
  const bytes = new TextEncoder().encode(deckRevisionContent(decks));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
}

export async function boundedJson(response, limit = 10 * 1024 * 1024) {
  if (!response.body) throw Error('Missing body');
  const reader=response.body.getReader(), parts=[];let length=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>limit)throw Error('Body too large');parts.push(value);}
  } catch(error){await reader.cancel();throw error;}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;
  for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}
