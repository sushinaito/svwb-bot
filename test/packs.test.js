import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupPacks,packMetadata } from '../src/chat/packs.js';
import { executeResearchTool } from '../src/chat/research.js';
import { completionEvidence } from '../src/chat/completion.js';
import { localizeReplyLabels } from '../src/chat/labels.js';

test('historical packs resolve by ID, language, ordinal and full year without network',async()=>{
  const noNetwork=async()=>{throw Error('Unexpected network');};
  for(const query of ['10004','第4彈','蒼空六龍','Skybound','蒼空の六竜']) {
    const r=await executeResearchTool('query_svwb_data',{resource:'packs',query},noNetwork);
    assert.equal(r.packs.length,1);assert.equal(r.packs[0].releasedOn,'2025-10-29');
    assert.equal(r.packs[0].releaseDateEvidence.verification,'community_reported');
  }
  assert.equal(lookupPacks('2026').total,4);
  assert.equal(lookupPacks().total,9);assert.equal(packMetadata.latestReleasedInSnapshot.ordinal,9);
  assert.equal(packMetadata.latestReleasedInSnapshot.releasedOn,'2026-08-27');
  assert.equal(lookupPacks('第10彈').total,0);
  assert.match(lookupPacks().caveat,/不是即時公告清單/);
});

test('editing preserves a completed date conclusion instead of replacing it with an older table',()=>{
  const answer='10月29日是2025年第4彈的歷史排程；下一包尚未查到官方確切日期。';
  const result=completionEvidence({text:'下次新版本更新是幾時？'},[],{completedAnswer:answer});
  assert.equal(result.completed_research_answer,answer);
  assert.equal(result.pack_database.latestReleasedInSnapshot.ordinal,9);
});

test('known Japanese labels use full card names before generic terms and never change URLs',()=>{
  const index={'10011111':{names:{'zh-Hant':'測試從者‧甲',ja:'テストのフォロワー・甲'}}};
  const text='テストのフォロワー甲是フォロワー。ランプドラゴン https://example.com/エルフ';
  assert.equal(localizeReplyLabels(text,{},index),'測試從者‧甲是從者。跳費龍 https://example.com/エルフ');
  assert.equal(localizeReplyLabels('獲得克雷斯特。',{},index),'獲得紋章。');
});
