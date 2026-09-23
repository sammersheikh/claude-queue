'use strict';

require('dotenv').config();
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { valuesGet, valuesBatchUpdate } = require('./gws');
const { parseEvent } = require('./streamParser');
const localModel = require('./localModel');
const { claudeExitMessage, combinedFailure } = require('./engineErrors');

const LOCK_PATH = path.join(__dirname, '.worker.lock');

const SHEET_ID = required('SHEET_ID');
const SHEET_NAME = process.env.SHEET_NAME || 'Queue';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '3000', 10);
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || '';
const CLAUDE_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_SEC || '300', 10) * 1000;
const WORKER_ID = `${os.hostname()}-${process.pid}`;

// Fallback policy. The local server and `claude -p` back each other up, so a
// row only ends in `error` when both engines are unavailable. Each direction is
// separately switchable.
//   LOCAL_FALLBACK_FROM_CLAUDE=1  claude fails/times out  -> retry on the local server
//   LOCAL_FALLBACK_TO_CLAUDE=1    local fails/unavailable -> retry on claude
const FALLBACK_FROM_CLAUDE = process.env.LOCAL_FALLBACK_FROM_CLAUDE !== '0';
const FALLBACK_TO_CLAUDE = process.env.LOCAL_FALLBACK_TO_CLAUDE !== '0';

// Column layout (0-indexed reads, A1-letters for writes):
// A id | B prompt | C status | D created_at | E response
// F completed_at | G claimed_by | H model | I error_message
// J tools | K progress | L context
const COL = {
  id: 0, prompt: 1, status: 2, created: 3, response: 4,
  completed: 5, claimed: 6, model: 7, error: 8,
  tools: 9, progress: 10, context: 11,
};

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Refuse to start if another worker is already polling this queue. Two pollers
// double the Sheets read traffic (which can blow per-user read quota) and race
// the non-atomic claim step. Prefer a single long-running process (or one
// launchd/systemd unit) as the sole worker for a given sheet.
function acquireSingletonLock() {
  try {
    const pid = parseInt(fs.readFileSync(LOCK_PATH, 'utf8').trim(), 10);
    if (pid && pid !== process.pid) {
      let alive = true;
      try { process.kill(pid, 0); } catch (e) { alive = false; }
      if (alive) {
        log(`another worker is already running (pid ${pid}); exiting. ` +
            `Only one worker should poll a given queue sheet.`);
        process.exit(0);
      }
      log(`removing stale lock from dead pid ${pid}`);
    }
  } catch (e) {
    // No lock file yet (ENOENT) or unreadable — fall through and claim it.
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  const release = () => { try { fs.unlinkSync(LOCK_PATH); } catch (e) {} };
  process.on('exit', release);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

// Write a progress string to the K column for a row, throttled so we never
// hit the Sheets API more than once per MIN_INTERVAL_MS per row.
function makeProgressWriter(rowNumber, { minIntervalMs = 1000 } = {}) {
  let lastWriteAt = 0;
  let pending = null;
  let timer = null;

  async function flush() {
    timer = null;
    if (pending === null) return;
    const text = pending;
    pending = null;
    lastWriteAt = Date.now();
    try {
      await valuesBatchUpdate(SHEET_ID, [
        { range: `${SHEET_NAME}!K${rowNumber}`, values: [[text]] },
      ]);
    } catch (err) {
      log(`progress write failed row=${rowNumber}: ${err.message || err}`);
    }
  }

  function write(text) {
    pending = String(text || '');
    const since = Date.now() - lastWriteAt;
    if (since >= minIntervalMs) {
      void flush();
    } else if (!timer) {
      timer = setTimeout(flush, minIntervalMs - since);
    }
  }

  async function finalize() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await flush();
  }

  return { write, finalize };
}

async function fetchPending() {
  const rows = await valuesGet(SHEET_ID, `${SHEET_NAME}!A2:L`);
  return rows
    .map((row, idx) => ({ row, rowNumber: idx + 2 }))
    .filter(({ row }) => (row[COL.status] || '').toLowerCase() === 'pending');
}

async function claimRow(rowNumber) {
  await valuesBatchUpdate(SHEET_ID, [
    { range: `${SHEET_NAME}!C${rowNumber}`, values: [['processing']] },
    { range: `${SHEET_NAME}!G${rowNumber}`, values: [[WORKER_ID]] },
  ]);
  const check = await valuesGet(SHEET_ID, `${SHEET_NAME}!G${rowNumber}`);
  return check[0]?.[0] === WORKER_ID;
}

function runClaude(prompt, model, opts) {
  opts = opts || {};
  const tools = opts.tools || '';
  const rowNumber = opts.rowNumber;

  return new Promise((resolve, reject) => {
    const args = ['-p'];
    if (model) args.push('--model', model);
    if (tools) {
      args.push('--allowed-tools', tools);
      args.push('--permission-mode', 'bypassPermissions');
      args.push('--output-format', 'stream-json');
      args.push('--verbose');
    }
    args.push(prompt);

    const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdoutBuf = '';
    let stderr = '';
    let finalText = '';
    let sawFinal = false;
    let streamError = null;
    let killed = false;

    const progress = tools && rowNumber ? makeProgressWriter(rowNumber) : null;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, CLAUDE_TIMEOUT_MS);

    function handleLine(line) {
      if (!tools) return; // No stream-json when tools disabled; stdout is plain text.
      const evt = parseEvent(line);
      if (!evt) return;
      if (evt.kind === 'progress') {
        if (progress) progress.write(evt.message);
        return;
      }
      if (evt.kind === 'final') {
        finalText = evt.text;
        sawFinal = true;
        return;
      }
      if (evt.kind === 'error') {
        streamError = evt.message;
        return;
      }
    }

    child.stdout.on('data', (d) => {
      const chunk = d.toString();
      stdoutBuf += chunk;
      if (!tools) return;
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        handleLine(line);
      }
    });

    child.stderr.on('data', (d) => (stderr += d.toString()));

    child.on('error', (err) => {
      clearTimeout(timer);
      const done = progress ? progress.finalize() : Promise.resolve();
      done.then(() => reject(err), () => reject(err));
    });

    child.on('close', async (code) => {
      clearTimeout(timer);
      // Flush any remaining buffered line in tools mode.
      if (tools && stdoutBuf.trim()) handleLine(stdoutBuf.trim());
      if (progress) await progress.finalize();

      if (killed) return reject(new Error(`claude timed out after ${CLAUDE_TIMEOUT_MS}ms`));
      if (code !== 0) return reject(new Error(claudeExitMessage(code, stderr, stdoutBuf)));

      if (tools) {
        if (streamError) return reject(new Error(streamError));
        if (sawFinal) return resolve(finalText.trim());
        // stream-json ended without a result event — treat as error.
        return reject(new Error('claude stream ended without result event'));
      }

      // Plain mode: stdout is the answer.
      resolve(stdoutBuf.trim());
    });
  });
}

async function writeResponse(rowNumber, response) {
  await valuesBatchUpdate(SHEET_ID, [
    { range: `${SHEET_NAME}!C${rowNumber}`, values: [['done']] },
    { range: `${SHEET_NAME}!E${rowNumber}`, values: [[response]] },
    { range: `${SHEET_NAME}!F${rowNumber}`, values: [[new Date().toISOString()]] },
  ]);
}

async function writeError(rowNumber, message) {
  await valuesBatchUpdate(SHEET_ID, [
    { range: `${SHEET_NAME}!C${rowNumber}`, values: [['error']] },
    { range: `${SHEET_NAME}!F${rowNumber}`, values: [[new Date().toISOString()]] },
    { range: `${SHEET_NAME}!I${rowNumber}`, values: [[message]] },
  ]);
}

// Run one prompt on the local OpenAI-compatible server. Reports the answer on
// success, or throws with a message that says why it could not be used.
async function runLocal(prompt, opts) {
  opts = opts || {};
  if (!(await localModel.isAvailable())) {
    throw new Error(`local model server not reachable at ${localModel.baseUrl()}`);
  }
  return localModel.generate(prompt, {
    systemPrompt: opts.systemPrompt,
    maxTokens: opts.maxTokens,
  });
}

// Run a prompt with whichever engine applies, applying the fallback policy.
// Returns { response, engine } where engine is the one that produced the answer.
async function runWithFallback(prompt, model, opts) {
  opts = opts || {};
  const wantedLocal = localModel.isLocalModel(model);
  const tools = opts.tools || '';

  // Tool-use rows stay on claude: the local server has no tool loop here, and
  // silently dropping an allowlist would be worse than not running the row.
  if (wantedLocal && tools) {
    throw new Error(
      `model "${model}" routes to the local server, which does not support the tools column; ` +
      `use a claude model for tool-use rows`
    );
  }

  if (wantedLocal) {
    try {
      return { response: await runLocal(prompt, opts), engine: 'local' };
    } catch (localErr) {
      if (!FALLBACK_TO_CLAUDE) throw localErr;
      log(`local model failed (${localErr.message}); falling back to claude`);
      try {
        const response = await runClaude(prompt, '', { tools: '', rowNumber: opts.rowNumber });
        return { response, engine: 'claude (local fallback)' };
      } catch (claudeErr) {
        throw combinedFailure('local', localErr, 'claude', claudeErr);
      }
    }
  }

  try {
    const response = await runClaude(prompt, model, { tools, rowNumber: opts.rowNumber });
    return { response, engine: 'claude' };
  } catch (claudeErr) {
    if (!FALLBACK_FROM_CLAUDE) throw claudeErr;
    if (tools) throw claudeErr; // local cannot honour the tools allowlist
    log(`claude failed (${claudeErr.message}); falling back to local model`);
    try {
      const response = await runLocal(prompt, opts);
      return { response, engine: 'local (claude fallback)' };
    } catch (localErr) {
      throw combinedFailure('claude', claudeErr, 'local', localErr);
    }
  }
}

async function tick() {
  const pending = await fetchPending();
  if (!pending.length) return;
  for (const { row, rowNumber } of pending) {
    const id = row[COL.id];
    const prompt = row[COL.prompt];
    const model = row[COL.model] || DEFAULT_MODEL || '';
    const tools = row[COL.tools] || '';
    log(`claiming row ${rowNumber} (id=${id}, tools=${tools ? 'yes' : 'no'})`);
    const won = await claimRow(rowNumber);
    if (!won) {
      log(`row ${rowNumber} already claimed, skipping`);
      continue;
    }
    try {
      const { response, engine } = await runWithFallback(prompt, model, { tools, rowNumber });
      await writeResponse(rowNumber, response);
      log(`row ${rowNumber} done (id=${id}, engine=${engine})`);
    } catch (err) {
      const msg = err.message || String(err);
      await writeError(rowNumber, msg);
      log(`row ${rowNumber} error (id=${id}): ${msg}`);
    }
  }
}

async function main() {
  acquireSingletonLock();
  log(`worker ${WORKER_ID} polling ${SHEET_ID}/${SHEET_NAME} every ${POLL_INTERVAL}ms`);
  log(`fallback policy: claude->local ${FALLBACK_FROM_CLAUDE ? 'on' : 'off'}, ` +
      `local->claude ${FALLBACK_TO_CLAUDE ? 'on' : 'off'}, ` +
      `local server ${localModel.baseUrl()}`);
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick();
    } catch (err) {
      log('tick failed:', err.message || err);
    } finally {
      running = false;
    }
  }, POLL_INTERVAL);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
