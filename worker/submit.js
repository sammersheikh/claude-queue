'use strict';

require('dotenv').config();
const { randomUUID } = require('crypto');
const { valuesGet, valuesAppend } = require('./gws');

const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || 'Queue';
if (!SHEET_ID) { console.error('SHEET_ID env required'); process.exit(2); }

function parseArgs(argv) {
  const out = { model: '', tools: '', prompt: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model') out.model = argv[++i] || '';
    else if (a === '--tools') out.tools = argv[++i] || '';
    else rest.push(a);
  }
  out.prompt = rest.join(' ');
  return out;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const { model, tools, prompt } = parseArgs(process.argv.slice(2));
  if (!prompt) {
    console.error('usage: submit.js [--model M] [--tools T] "<prompt>"');
    process.exit(2);
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  await valuesAppend(SHEET_ID, `${SHEET_NAME}!A:L`, [
    [id, prompt, 'pending', now, '', '', '', model, '', tools, '', ''],
  ]);
  console.log(id);

  const start = Date.now();
  let lastProgress = '';
  while (Date.now() - start < 180000) {
    const rows = await valuesGet(SHEET_ID, `${SHEET_NAME}!A2:L`);
    const row = rows.find((r) => r[0] === id);
    if (!row) { await sleep(1500); continue; }
    const status = (row[2] || '').toLowerCase();
    const progress = row[10] || '';
    if (progress && progress !== lastProgress) {
      process.stderr.write(`  [progress] ${progress}\n`);
      lastProgress = progress;
    }
    if (status === 'done') { console.log('---'); console.log(row[4] || ''); return; }
    if (status === 'error') { console.error('ERROR:', row[8] || ''); process.exit(1); }
    await sleep(2000);
  }
  console.error('timeout');
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
