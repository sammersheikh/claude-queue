'use strict';

const { spawn } = require('child_process');

const GWS_BIN = process.env.GWS_BIN || 'gws';

// 10s (was 30s): a healthy gws call is ~0.4s. When the Sheets read quota is
// throttling, gws retries with backoff and can hang for the full timeout. The
// poll loop is single-flight, so one hung read freezes the whole worker. Fail
// fast and let the next tick retry instead of blocking for 30s.
function runGws(args, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(GWS_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`gws ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(stderr.trim() || `gws exited ${code}`));
      }
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : {});
      } catch (e) {
        reject(new Error(`gws returned non-JSON output: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

async function valuesGet(spreadsheetId, range) {
  const res = await runGws([
    'sheets', 'spreadsheets', 'values', 'get',
    '--params', JSON.stringify({ spreadsheetId, range }),
    '--format', 'json',
  ]);
  return res.values || [];
}

async function valuesBatchUpdate(spreadsheetId, data) {
  return runGws([
    'sheets', 'spreadsheets', 'values', 'batchUpdate',
    '--params', JSON.stringify({ spreadsheetId }),
    '--json', JSON.stringify({ valueInputOption: 'RAW', data }),
    '--format', 'json',
  ]);
}

async function valuesAppend(spreadsheetId, range, values) {
  return runGws([
    'sheets', 'spreadsheets', 'values', 'append',
    '--params', JSON.stringify({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
    }),
    '--json', JSON.stringify({ values }),
    '--format', 'json',
  ]);
}

module.exports = { runGws, valuesGet, valuesBatchUpdate, valuesAppend };
