'use strict';

// Error text for rows that fail. Kept pure so it can be tested without the
// sheet, the lock file or a real `claude` binary.

// Longest slice of stdout copied into an error. The message lands in a sheet
// cell, and a runaway answer should not fill it.
const MAX_DETAIL = 500;

// `claude -p` prints its own failures (API errors, usage limits, auth problems)
// on STDOUT and exits 1 with stderr empty. Reporting only stderr turned every
// one of those into a bare "exited with code 1", so read stdout as a fallback.
//
// In tools mode (stream-json) stdout is drained line by line into the stream
// parser, so at exit it holds nothing useful, and the failure arrives as a
// stream error event instead. The caller passes that as streamError, and it
// wins: it is the most specific reason there is.
function claudeExitMessage(code, stderr, stdout, streamError) {
  const detail = String(streamError || '').trim().slice(0, MAX_DETAIL) ||
    String(stderr || '').trim() || String(stdout || '').trim().slice(0, MAX_DETAIL);
  return detail
    ? `claude exited with code ${code}: ${detail}`
    : `claude exited with code ${code}`;
}

// When the fallback engine fails too, both reasons belong in the row. Reporting
// only the second one blamed an unreachable local server for what was really a
// claude failure, and hid the claude reason entirely.
function combinedFailure(primaryName, primaryErr, fallbackName, fallbackErr) {
  return new Error(
    `${primaryName} failed: ${messageOf(primaryErr)}; ` +
    `${fallbackName} fallback failed: ${messageOf(fallbackErr)}`
  );
}

function messageOf(err) {
  return (err && err.message) || String(err);
}

module.exports = { claudeExitMessage, combinedFailure, MAX_DETAIL };
