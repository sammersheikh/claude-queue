# CLAUDE.md — claude-queue

## What this is

A Google-Sheet-backed job queue. Callers (typically Google Apps Script projects) write a row with a prompt; a local Node worker polls, runs `claude -p`, and writes the response back. Lets internal tools use Claude Code without putting API keys in cloud projects or exposing a public endpoint.

## Architecture

```
Caller (GAS / CLI)  ──append──▶  Queue sheet  ◀──poll/update──  worker.js
       ▲                              │                              │
       └──────── poll status ─────────┘                              └── claude -p
```

Auth:
- **Worker:** shells out to `gws` (OAuth session on the host machine).
- **GAS callers:** native `SpreadsheetApp`; first access prompts for sheet auth.

## Sheet

Create your own spreadsheet. Put the ID only in `worker/.env` (`SHEET_ID`) and in each caller's Script Property `CLAUDE_QUEUE_SHEET_ID`. Do not commit real IDs.

- **Tab:** `Queue`
- **Headers (row 1):** `id, prompt, status, created_at, response, completed_at, claimed_by, model, error_message, tools, progress, context`

## Key files

- `worker/worker.js` — polling loop, claim + spawn + writeback
- `worker/gws.js` — wrapper for `gws sheets` calls
- `worker/submit.js` — CLI smoke test
- `gas-library/ClaudeQueue.gs` — `submit` / `status` / `poll` / `ask`

## Running

```sh
cd worker
cp .env.example .env   # set SHEET_ID
npm install
npm start              # polls every POLL_INTERVAL ms (default 3000)
```

## Gotchas

- Only one worker at a time per sheet. Two workers can race the non-atomic claim.
- `claude -p` spin-up is ~1–3s; end-to-end is often 5–15s.
- GAS web apps cap at 6 minutes. Prefer async submit + client poll over `ClaudeQueue.ask` on long prompts.
- Sheet grows forever. Archive old rows when volume matters.
- Tool-use mode uses `--permission-mode bypassPermissions`. Keep the `tools` allowlist narrow.

## Status values

- `pending` — submitted
- `processing` — claimed, `claude -p` running
- `done` — response column set
- `error` — error_message column set
