'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isLocalModel } = require('./localModel');

test('routes known local aliases', () => {
  for (const name of ['local', 'bonsai', 'bonsai2', 'bonsai-27b', 'Ternary-Bonsai']) {
    assert.equal(isLocalModel(name), true, `${name} should route local`);
  }
});

test('routes any local: prefix', () => {
  assert.equal(isLocalModel('local:bonsai-27b'), true);
  assert.equal(isLocalModel('LOCAL:anything'), true);
});

test('leaves claude models alone', () => {
  for (const name of ['claude-sonnet-4-6', 'claude-opus-4-7', 'gpt-5', '']) {
    assert.equal(isLocalModel(name), false, `${name} should not route local`);
  }
});

test('handles empty and undefined', () => {
  assert.equal(isLocalModel(undefined), false);
  assert.equal(isLocalModel(null), false);
  assert.equal(isLocalModel('   '), false);
});

test('does not match a claude model that merely contains "local"', () => {
  assert.equal(isLocalModel('claude-local-experiment'), false);
});
