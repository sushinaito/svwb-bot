import {deckCache} from '../src/chat/deck-cache.js';
if(!deckCache.metadata.available)throw Error('Complete private deck library required. Run npm run decks:sync first.');
console.log(JSON.stringify(deckCache.metadata));
