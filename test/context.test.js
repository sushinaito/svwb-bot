import test from 'node:test';
import assert from 'node:assert/strict';
import { compactionThreshold, requestContextTokens } from '../src/chat/context.js';

test('context accounting counts cached input and output, not cumulative session usage', () => {
  assert.equal(requestContextTokens({ type: 'span.model_request_end', model_usage: {
    input_tokens: 10, cache_creation_input_tokens: 20000, cache_read_input_tokens: 50000, output_tokens: 4000,
  } }), 74010);
  assert.equal(requestContextTokens({ type: 'session.usage', usage: { input_tokens: 200000 } }), null);
  assert.equal(requestContextTokens({ type: 'span.model_request_end', is_error: true, model_usage: { input_tokens: 90000 } }), null);
  assert.equal(compactionThreshold({}), 80000);
  assert.equal(compactionThreshold({ CONTEXT_COMPACT_TOKENS: '100000' }), 90000);
});
