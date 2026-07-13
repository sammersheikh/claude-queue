'use strict';

const MAX_PROGRESS_CHARS = 200;

function truncate(s) {
  const oneLine = String(s).replace(/\s+/g, ' ').trim();
  if (oneLine.length <= MAX_PROGRESS_CHARS) return oneLine;
  return oneLine.slice(0, MAX_PROGRESS_CHARS - 1) + '…';
}

function summarizeToolUse(block) {
  const name = block.name || 'tool';
  const input = block.input || {};
  const detail = input.command || input.file_path || JSON.stringify(input);
  return truncate(`Running ${name}: ${detail}`);
}

function summarizeToolResult(block) {
  const content = typeof block.content === 'string'
    ? block.content
    : JSON.stringify(block.content || '');
  return truncate(`Got tool result (${content.length} chars)`);
}

function summarizeAssistantText(block) {
  return truncate(`Thinking: ${block.text || ''}`);
}

function parseEvent(line) {
  if (!line || !line.trim()) return null;
  let evt;
  try {
    evt = JSON.parse(line);
  } catch (e) {
    return null;
  }
  if (!evt || typeof evt !== 'object') return null;

  if (evt.type === 'system') return null;

  if (evt.type === 'assistant' && evt.message && Array.isArray(evt.message.content)) {
    for (const block of evt.message.content) {
      // tool_use takes priority; text blocks in the same message are intentionally dropped.
      if (block && block.type === 'tool_use') {
        return { kind: 'progress', message: summarizeToolUse(block) };
      }
      if (block && block.type === 'text') {
        return { kind: 'progress', message: summarizeAssistantText(block) };
      }
    }
    return null;
  }

  if (evt.type === 'user' && evt.message && Array.isArray(evt.message.content)) {
    for (const block of evt.message.content) {
      if (block && block.type === 'tool_result') {
        return { kind: 'progress', message: summarizeToolResult(block) };
      }
    }
    return null;
  }

  if (evt.type === 'result') {
    if (evt.subtype === 'success') {
      return { kind: 'final', text: String(evt.result || '') };
    }
    const msg = evt.error || evt.subtype || 'claude result error';
    return { kind: 'error', message: String(msg) };
  }

  return null;
}

module.exports = { parseEvent };
