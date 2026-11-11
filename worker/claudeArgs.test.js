'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildClaudeArgs, rowFlags } = require('./claudeArgs');

test('plain row keeps the old argument list', () => {
  assert.deepStrictEqual(buildClaudeArgs('hi', 'haiku', {}), ['-p', '--model', 'haiku', 'hi']);
});

test('noTools row disables tools and MCP servers, prompt stays last', () => {
  assert.deepStrictEqual(buildClaudeArgs('hi', 'haiku', { noTools: true }),
    ['-p', '--model', 'haiku', '--tools', '', '--strict-mcp-config', 'hi']);
});

test('a tools allowlist wins over noTools', () => {
  const a = buildClaudeArgs('hi', '', { tools: 'Bash(ls:*)', noTools: true });
  assert.ok(a.includes('--allowed-tools'));
  assert.ok(!a.includes('--strict-mcp-config'));
  assert.strictEqual(a[a.length - 1], 'hi');
});

test('rowFlags reads only a literal true', () => {
  assert.deepStrictEqual(rowFlags('{"noTools":true,"source":"rt-help-chat"}'), { noTools: true });
  assert.deepStrictEqual(rowFlags('{"noTools":"yes"}'), { noTools: false });
  assert.deepStrictEqual(rowFlags(''), { noTools: false });
  assert.deepStrictEqual(rowFlags('not json'), { noTools: false });
});
