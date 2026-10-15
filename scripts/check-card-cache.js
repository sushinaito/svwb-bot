import { cardCache } from '../src/chat/card-cache.js';
if (!cardCache.metadata.available) throw Error('Complete private card snapshot required. Run npm run cards:cache first.');
console.log(JSON.stringify(cardCache.metadata));
