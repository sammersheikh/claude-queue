'use strict';
// Builds the `claude` CLI argument list for one queue row. Pure, so it is
// node-tested (claudeArgs.test.js).
//
// tools    - the row's tools column. Non-empty: tool use with that allowlist,
//            auto-approved, streamed as JSON for the progress column.
// noTools  - from the row's context JSON (`{"noTools": true}`). Only applies
//            when tools is empty: disables every built-in tool and ignores the
//            user's MCP servers, so a row built from untrusted text (a coworker
//            typing into a help chat) cannot read files, run commands or reach
//            Gmail/Slack through the host's Claude Code settings. Rows without
//            the flag keep the old behaviour.
function buildClaudeArgs(prompt, model, opts) {
  opts = opts || {};
  const tools = opts.tools || '';
  const args = ['-p'];
  if (model) args.push('--model', model);
  if (tools) {
    args.push('--allowed-tools', tools);
    args.push('--permission-mode', 'bypassPermissions');
    args.push('--output-format', 'stream-json');
    args.push('--verbose');
  } else if (opts.noTools) {
    args.push('--tools', '');
    args.push('--strict-mcp-config');
  }
  args.push(prompt);
  return args;
}

// The row's context column is optional free-form JSON. Anything unparseable
// means "no flags".
function rowFlags(contextCell) {
  if (!contextCell) return { noTools: false };
  try {
    const ctx = JSON.parse(String(contextCell));
    return { noTools: !!(ctx && ctx.noTools === true) };
  } catch (_) {
    return { noTools: false };
  }
}

module.exports = { buildClaudeArgs, rowFlags };
