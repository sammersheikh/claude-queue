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

## License

MIT
