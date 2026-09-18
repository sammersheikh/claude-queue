# claude-queue

A Google Sheet is the message queue. A local Node worker polls for pending rows, runs each prompt through `claude -p`, and writes the response back. Any [Google Apps Script](https://developers.google.com/apps-script) project can submit work with one helper call.

No public endpoints, no tunnels, no API keys in code. Auth happens through the `gws` CLI OAuth session and Apps Script's native Sheet access.

```
GAS web app  ──append row──▶  Queue sheet  ◀──poll / update──  worker (your machine)
     ▲                              │                                  │
     └──────── poll status ─────────┘                                  └── claude -p
```

## Why

Apps Script can call cloud LLM APIs, but that means keys in Script Properties, per-token billing, and another vendor to manage. If you already pay for Claude Code (or Claude CLI) on a laptop that stays online, this queue lets internal tools reuse that session: submit a prompt from GAS, get a response when the worker finishes.

Good for: summarization, email drafts, classification, structured extraction.  
Not for: interactive chat, streaming UIs, or high-QPS production traffic.

## Pieces

| Path | What it is |
|------|-----------|
| `worker/worker.js` | Node process that polls the sheet and runs `claude -p` |
| `worker/submit.js` | CLI to submit a prompt and wait for the response (smoke test) |
| `worker/gws.js` | Thin wrapper around the `gws` CLI for Sheets calls |
| `gas-library/ClaudeQueue.gs` | Drop-in Apps Script helper: `submit` / `status` / `poll` / `ask` |

## Sheet schema

Create a Google Sheet with a tab named `Queue` and this header row (freeze row 1):

| A | B | C | D | E | F | G | H | I | J | K | L |
|---|---|---|---|---|---|---|---|---|---|---|---|
| id | prompt | status | created_at | response | completed_at | claimed_by | model | error_message | tools | progress | context |

Status values: `pending` → `processing` → `done` | `error`.

## First-time setup

### Prerequisites

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) (`claude`) on `PATH`, authenticated
- [Google Workspace CLI (`gws`)](https://github.com/googleworkspace/cli) on `PATH`, authenticated to a Google account that can edit the queue sheet

### Worker

```sh
git clone https://github.com/sammersheikh/claude-queue.git
cd claude-queue/worker
cp .env.example .env
# Edit .env and set SHEET_ID to your queue spreadsheet ID
npm install
npm start
```

Leave the worker running. Default poll interval is 3 seconds.

### Smoke test

In another terminal:

```sh
cd claude-queue/worker
node submit.js "say hi in one word"
```

The worker should pick up the row within a few seconds and print the response.

### Use from a GAS project

1. Copy `gas-library/ClaudeQueue.gs` into your Apps Script project.
2. In **Project Settings → Script Properties**, set:
   - `CLAUDE_QUEUE_SHEET_ID` = your queue spreadsheet ID
3. First call triggers an OAuth consent prompt for that sheet; once accepted it is silent.

```javascript
// Synchronous (blocks until done or timeout; default 2 min)
const result = ClaudeQueue.ask("summarize this: " + text);
if (result.status === 'done') Logger.log(result.response);
if (result.status === 'error') throw new Error(result.error);

// Async (preferred for web apps under the 6-minute execution cap)
const id = ClaudeQueue.submit(prompt);
// return id to the client; client polls ClaudeQueue.status(id)
```

## Tool-using prompts (v2)

Callers may include a `tools` value (column J) listing a Claude Code allowlist, for example `Bash(gws sheets values get:*)`. When present, the worker invokes:

```text
claude -p --allowed-tools <tools> --permission-mode bypassPermissions \
  --output-format stream-json --verbose <prompt>
```

and streams parsed progress events into column K so callers can show live status. The final text comes from the `result` stream event and lands in column E like plain-mode responses.

Column L (`context`) is an optional JSON blob the caller can use to keep the prompt DRY (for example, a sheet ID the prompt can reference).

Tool-use prompts are still single-turn and stateless from Claude's side.

**Security:** `--permission-mode bypassPermissions` auto-approves every tool call Claude emits. Safety depends entirely on the `tools` allowlist the caller supplies. Keep it narrow (e.g. `Bash(gws sheets values get:*)`). Broad patterns like `Bash(*)` grant Claude arbitrary shell access on the worker machine. Anyone with write access to the queue sheet can enqueue work, so do not widen the sheet's share scope beyond trusted callers.

## Local model (optional)

The worker can also run prompts on a local OpenAI-compatible server instead of `claude -p`. This is useful for offline work, for prompts you would rather not send to a hosted API, and as a second engine so a row only fails when both are down.

The intended server is [PrismML's Bonsai 2 27B](https://github.com/PrismML-Eng/Bonsai-demo) on `llama-server`, but anything exposing `POST /v1/chat/completions` works.

### Routing

A row routes local when the **model** column (H) holds one of:

- `local`
- `bonsai`, `bonsai2`, `bonsai-27b`, `bonsai2-27b`, `ternary-bonsai`
- anything prefixed `local:` (e.g. `local:bonsai-27b`)

Any other value, including an empty cell, goes to `claude -p` as before.

### Fallback

Both directions are on by default, so a row errors only when both engines are unavailable:

| Direction | Env var | Behavior |
|-----------|---------|----------|
| claude to local | `LOCAL_FALLBACK_FROM_CLAUDE` | `claude -p` fails or times out, retry on the local server |
| local to claude | `LOCAL_FALLBACK_TO_CLAUDE` | local server down or errors, retry on `claude -p` |

Set either to `0` to disable. Each response is logged with the engine that produced it, so `worker.log` shows which path ran.

**Tool-use rows are claude-only.** The local path here has no tool loop, so a row with a `tools` value and a local model name is rejected rather than silently run without the allowlist. A claude tool row that fails does not fall back to local for the same reason.

### Running the server

```sh
cd ~/Projects/bonsai-demo
PORT=8091 BONSAI_CTX=32768 ./scripts/start_llama_server.sh
```

Port 8091 is the convention here because 8080 is often taken. The worker defaults to `http://127.0.0.1:8091`.

On an M5 Mac the Metal tensor-API probe can fail to compile against the OS headers. The server still runs at full Metal speed, but set `GGML_METAL_TENSOR_DISABLE=1` to skip the probe and avoid the error. `scripts/` in the demo repo and the launchd unit below both set it.

To keep the server always up, install a launchd unit (see `com.bonsai.llama-server.plist` in `~/Library/LaunchAgents/`), which starts it at login and restarts it if it dies.

### Latency expectations

On an M5 with 24 GB, Bonsai 2 27B decodes at roughly 13 tok/s. Fine for background queue work, not for interactive chat. The model thinks by default, and thinking consumes the `max_tokens` budget, so `LOCAL_MODEL_REASONING_BUDGET=0` is the default here: it is much faster and is the right setting for classification, extraction, and short answers. Raise it for prompts that need reasoning.

## Operational notes

- **Run one worker at a time** for a given sheet. The claim step is verify-after-write, not atomic; two workers can race the same row.
- The sheet has no TTL. Archive or delete old rows periodically.
- If the machine sleeps, the worker pauses. On wake it continues; nothing is lost, only delayed.
- `claude -p` starts a fresh session per row. No conversation memory across rows unless you bake prior turns into the prompt.
- Typical end-to-end latency is about 5–15 seconds. Not suitable for interactive chat.

## Environment variables

See `worker/.env.example`. Required:

| Variable | Description |
|----------|-------------|
| `SHEET_ID` | Google Spreadsheet ID of the queue |

Optional: `SHEET_NAME` (default `Queue`), `POLL_INTERVAL` (ms), `DEFAULT_MODEL`, `CLAUDE_TIMEOUT_SEC`, `GWS_BIN`.

Local model: `LOCAL_MODEL_ENABLED`, `LOCAL_MODEL_URL`, `LOCAL_MODEL_NAME`, `LOCAL_MODEL_TIMEOUT_SEC`, `LOCAL_MODEL_MAX_TOKENS`, `LOCAL_MODEL_REASONING_BUDGET`, `LOCAL_FALLBACK_FROM_CLAUDE`, `LOCAL_FALLBACK_TO_CLAUDE`. See `.env.example` for the full list and defaults.

## License

MIT
