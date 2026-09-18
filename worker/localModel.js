'use strict';

// Client for a local OpenAI-compatible server (llama.cpp `llama-server`).
// Used as an optional engine for queue rows: either because a caller asked for
// it by name in the model column, or as a fallback when `claude -p` fails.
//
// Nothing here shells out to a CLI — it is a plain HTTP call, so the worker
// stays dependency-free. Configure with env vars (see .env.example).

const http = require('http');
const https = require('https');

const BASE_URL = (process.env.LOCAL_MODEL_URL || 'http://127.0.0.1:8091').replace(/\/+$/, '');
const MODEL_ID = process.env.LOCAL_MODEL_NAME || 'local';
const TIMEOUT_MS = parseInt(process.env.LOCAL_MODEL_TIMEOUT_SEC || '300', 10) * 1000;
const MAX_TOKENS = parseInt(process.env.LOCAL_MODEL_MAX_TOKENS || '2048', 10);
const ENABLED = process.env.LOCAL_MODEL_ENABLED !== '0';
const REASONING_BUDGET = process.env.LOCAL_MODEL_REASONING_BUDGET;

// Aliases a caller may put in the model column (H) to route to the local
// server. A "local:" prefix routes local regardless of what follows, which
// leaves room for a future multi-model setup without a code change.
const ALIASES = new Set([
  'local', 'bonsai', 'bonsai2', 'bonsai-27b', 'bonsai2-27b', 'ternary-bonsai',
]);

function isLocalModel(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return false;
  return n.startsWith('local:') || ALIASES.has(n);
}

function baseUrl() {
  return BASE_URL;
}

function call(method, pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE_URL + pathname);
    const transport = url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { Accept: 'application/json' };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    let timer = null;
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          if (timer) clearTimeout(timer);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`local model HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
          }
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch (e) {
            reject(new Error(`local model returned non-JSON: ${data.slice(0, 200)}`));
          }
        });
      }
    );

    timer = setTimeout(() => {
      req.destroy(new Error(`local model request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    req.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    if (payload !== null) req.write(payload);
    req.end();
  });
}

// Health is cached briefly: the worker checks once per candidate row, and a
// down server should not cost a connection attempt on every row.
let healthCache = { at: 0, ok: false };

async function isAvailable({ ttlMs = 15000 } = {}) {
  if (!ENABLED) return false;
  const now = Date.now();
  if (now - healthCache.at < ttlMs) return healthCache.ok;
  let ok = false;
  try {
    // A server still loading its model answers 503, which call() rejects.
    await call('GET', '/health', undefined, 3000);
    ok = true;
  } catch (e) {
    ok = false;
  }
  healthCache = { at: now, ok };
  return ok;
}

async function generate(prompt, opts) {
  opts = opts || {};
  const messages = [];
  if (opts.systemPrompt) messages.push({ role: 'system', content: opts.systemPrompt });
  messages.push({ role: 'user', content: String(prompt) });

  const body = {
    model: MODEL_ID,
    messages,
    temperature: opts.temperature != null ? opts.temperature : 1.0,
    top_p: 0.95,
    top_k: 20,
    max_tokens: opts.maxTokens || MAX_TOKENS,
    stream: false,
  };

  // These models think by default. Thinking at laptop decode speeds is most of
  // the wall time, so the budget is explicit and defaults to off.
  if (REASONING_BUDGET !== undefined && REASONING_BUDGET !== '') {
    const n = parseInt(REASONING_BUDGET, 10);
    if (!Number.isNaN(n)) body.thinking_budget_tokens = n;
  }

  const res = await call('POST', '/v1/chat/completions', body, TIMEOUT_MS);
  const choice = (res.choices && res.choices[0]) || {};
  const text = String((choice.message && choice.message.content) || '').trim();
  if (text) return text;

  if (choice.finish_reason === 'length') {
    const hint = body.thinking_budget_tokens === undefined
      ? '; set LOCAL_MODEL_REASONING_BUDGET=0 to stop thinking from eating the budget'
      : '';
    throw new Error(`local model hit max_tokens (${body.max_tokens}) before answering${hint}`);
  }
  throw new Error('local model returned an empty response');
}

module.exports = { isLocalModel, isAvailable, generate, baseUrl };
