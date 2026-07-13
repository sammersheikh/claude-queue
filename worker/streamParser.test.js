'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEvent } = require('./streamParser');

test('returns null for empty line', () => {
  assert.equal(parseEvent(''), null);
  assert.equal(parseEvent('   \n'), null);
});

test('returns null for non-JSON line', () => {
  assert.equal(parseEvent('not json {'), null);
});

test('ignores system init event', () => {
  const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'x' });
  assert.equal(parseEvent(line), null);
});

test('extracts progress from assistant text block', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'Let me read the trial sheet first.\nThen I will filter.' }] },
  });
  const out = parseEvent(line);
  assert.equal(out.kind, 'progress');
  assert.match(out.message, /Let me read the trial sheet first/);
  assert.ok(out.message.length <= 200);
});

test('extracts progress from tool_use block', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: {
      content: [{
        type: 'tool_use',
        name: 'Bash',
        input: { command: "gws sheets values get 1Rf 'Trial Tracker Sheet'!A:Z --format json" },
      }],
    },
  });
  const out = parseEvent(line);
  assert.equal(out.kind, 'progress');
  assert.match(out.message, /Bash/);
  assert.match(out.message, /Trial Tracker Sheet/);
});

test('summarizes tool_result with content length', () => {
  const line = JSON.stringify({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'row\n'.repeat(500) }],
    },
  });
  const out = parseEvent(line);
  assert.equal(out.kind, 'progress');
  assert.match(out.message, /tool result/i);
  assert.match(out.message, /\d+/);
});

test('summarizes tool_result when content is non-string', () => {
  const line = JSON.stringify({
    type: 'user',
    message: {
      content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ text: 'structured payload' }] }],
    },
  });
  const out = parseEvent(line);
  assert.equal(out.kind, 'progress');
  assert.match(out.message, /tool result/i);
  assert.match(out.message, /\d+/);
});

test('returns final text from result event', () => {
  const line = JSON.stringify({
    type: 'result',
    subtype: 'success',
    result: 'Final report markdown here.',
  });
  const out = parseEvent(line);
  assert.deepEqual(out, { kind: 'final', text: 'Final report markdown here.' });
});

test('returns error on result subtype error', () => {
  const line = JSON.stringify({
    type: 'result',
    subtype: 'error_max_turns',
    error: 'Reached max turns',
  });
  const out = parseEvent(line);
  assert.equal(out.kind, 'error');
  assert.match(out.message, /max turns/i);
});

test('truncates long progress messages to 200 chars', () => {
  const line = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'x'.repeat(500) }] },
  });
  const out = parseEvent(line);
  assert.equal(out.kind, 'progress');
  assert.ok(out.message.length <= 200);
});
