import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupTerminology, relevantTerminology, TERMINOLOGY_GUIDANCE } from '../src/chat/terminology.js';
import { executeResearchTool } from '../src/chat/research.js';

test('official terminology is served offline in any language without fetching or returning unrelated entries', async () => {
  const noNetwork = () => { throw Error('Network must not be used'); };
  for (const query of ['Invoke', '直接召喚', '瞬念召喚']) {
    const result = await executeResearchTool('query_svwb_data', { resource: 'terminology', query, view: 'definitions' }, noNetwork);
    assert.equal(result.verification, 'official_snapshot');
    assert.deepEqual(result.terms.map(t => t.cht), ['瞬念召喚']);
    assert.match(result.terms[0].definition, /牌堆/);
  }
  assert.deepEqual(lookupTerminology('Super-Evolve').terms.map(t => t.cht), ['超進化時']);
  assert.deepEqual(lookupTerminology('On Spellboost').terms.map(t => t.cht), ['魔力增幅時']);
  assert.equal(lookupTerminology('unknown future keyword').status, 'not_found');
});

test('compact terminology pages cover every saved term without dumping definitions into normal prompts', () => {
  let offset = 0; const names = [];
  do {
    const page = lookupTerminology('', { offset, limit: 30 });
    assert.ok(page.terms.every(t => !Object.hasOwn(t, 'definition')));
    names.push(...page.terms.map(t => t.cht)); offset = page.nextOffset;
  } while (offset !== null);
  assert.equal(names.length, 81); assert.equal(new Set(names).size, 81);
  assert.equal(relevantTerminology('你好'), undefined);
  assert.deepEqual(relevantTerminology('Fanfare, Last Words, Invoke').terms.map(t => t.cht), ['入場曲', '謝幕曲', '瞬念召喚']);
  assert.ok(TERMINOLOGY_GUIDANCE.length < 400);
  assert.throws(() => lookupTerminology('', { limit: 1000 }));
});
