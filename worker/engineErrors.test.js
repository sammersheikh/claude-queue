'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { claudeExitMessage, combinedFailure, MAX_DETAIL } = require('./engineErrors');

test('prefers stderr when claude wrote one', () => {
  assert.equal(
    claudeExitMessage(1, 'boom on stderr\n', 'ignored stdout'),
    'claude exited with code 1: boom on stderr'
  );
});

test('falls back to stdout when stderr is empty, which is how claude -p reports API errors', () => {
  assert.equal(
    claudeExitMessage(1, '', 'API Error: 529 overloaded\n'),
    'claude exited with code 1: API Error: 529 overloaded'
  );
});

test('treats whitespace-only stderr as empty', () => {
  assert.equal(
    claudeExitMessage(1, '  \n', 'usage limit reached'),
    'claude exited with code 1: usage limit reached'
  );
});

test('caps the stdout detail so a sheet cell cannot fill up', () => {
  const msg = claudeExitMessage(1, '', 'x'.repeat(MAX_DETAIL * 3));
  assert.equal(msg, 'claude exited with code 1: ' + 'x'.repeat(MAX_DETAIL));
});

test('keeps the bare exit code when there is nothing else to say', () => {
  assert.equal(claudeExitMessage(1, '', ''), 'claude exited with code 1');
  assert.equal(claudeExitMessage(2, undefined, undefined), 'claude exited with code 2');
});

test('a double failure names both engines and both reasons, primary first', () => {
  const err = combinedFailure(
    'claude', new Error('claude exited with code 1: API Error: 500'),
    'local', new Error('local model server not reachable at http://127.0.0.1:8091')
  );
  assert.ok(err instanceof Error);
  assert.equal(
    err.message,
    'claude failed: claude exited with code 1: API Error: 500; ' +
    'local fallback failed: local model server not reachable at http://127.0.0.1:8091'
  );
});

test('a double failure tolerates a non-Error throw', () => {
  const err = combinedFailure('local', 'plain string', 'claude', new Error('timed out'));
  assert.equal(err.message, 'local failed: plain string; claude fallback failed: timed out');
});
