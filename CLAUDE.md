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

- `worker/worker.js` — polling loop, claim + spawn + writeback, engine routing + fallback
- `worker/localModel.js` — HTTP client for a local OpenAI-compatible server (llama-server)
- `worker/gws.js` — wrapper for `gws sheets` calls
- `worker/submit.js` — CLI smoke test
- `gas-library/ClaudeQueue.gs` — `submit` / `status` / `poll` / `ask`

## Local model engine (Bonsai 2 27B)

Optional second engine, so a row only errors when both engines are down. Configured in `worker/.env`.

- Routes local when the model column (H) is `local` / `bonsai` / `bonsai2` / `bonsai-27b` / `bonsai2-27b` / `ternary-bonsai`, or anything prefixed `local:`. Everything else goes to `claude -p`.
- Fallback both ways: `LOCAL_FALLBACK_FROM_CLAUDE` (claude fails, retry local) and `LOCAL_FALLBACK_TO_CLAUDE` (local down, retry claude), both default on.
- Tool-use rows are claude-only; a local model name with a `tools` value is rejected, not silently run without the allowlist.
- Server: PrismML's Bonsai-demo at `~/Projects/bonsai-demo`, `PORT=8091` (8080 is taken by xteink-x3). Managed by launchd unit `com.bonsai.llama-server` so it starts at login and restarts on crash.
- On M5 Macs set `GGML_METAL_TENSOR_DISABLE=1` (in the plist) to skip a Metal tensor-API probe that fails to compile on macOS 26 headers; full Metal speed is kept.
- `LOCAL_MODEL_REASONING_BUDGET=0` by default. The model thinks by default and thinking eats the `max_tokens` budget; at ~13 tok/s on an M5 that is most of the wall time.
- ~13 tok/s decode on an M5 with 24 GB. Background queue work only, not interactive.

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
