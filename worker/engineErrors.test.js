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

test('in tools mode the stream error wins, because stdout was consumed as JSON lines', () => {
  // Code review 2026-09-28: in tools mode the stdout buffer is drained line by
  // line into the stream parser, so by exit it is empty or a JSON fragment, and
  // the usage-limit text arrives as a stream error event instead. Reporting
  // stderr/stdout there gave a bare "exited with code 1" for a session limit.
  assert.equal(
    claudeExitMessage(1, '', '', 'Claude AI usage limit reached|1759092000'),
    'claude exited with code 1: Claude AI usage limit reached|1759092000'
  );
  assert.equal(
    claudeExitMessage(1, 'a warning on stderr', '{"type":"sys', 'API Error: 401 OAuth token expired'),
    'claude exited with code 1: API Error: 401 OAuth token expired'
  );
});

test('with no stream error the old order holds', () => {
  assert.equal(claudeExitMessage(1, 'boom', 'x', ''), 'claude exited with code 1: boom');
  assert.equal(claudeExitMessage(1, '', 'x', undefined), 'claude exited with code 1: x');
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
