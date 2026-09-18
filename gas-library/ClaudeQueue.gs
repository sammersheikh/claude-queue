/**
 * ClaudeQueue.gs — drop-in helper for any GAS project.
 *
 * Setup (once per project):
 *   1. Add this file to your Apps Script project.
 *   2. In Project Settings → Script Properties, set:
 *        CLAUDE_QUEUE_SHEET_ID = <the Claude Queue sheet ID>
 *   3. Make sure the Apps Script is authorized to access that sheet (first
 *      call will prompt for auth).
 *
 * Usage:
 *   const { response } = ClaudeQueue.ask("summarize this in one sentence: ...");
 *   // or async:
 *   const id = ClaudeQueue.submit("draft a reply to ...");
 *   // ...later...
 *   const result = ClaudeQueue.poll(id);
 */

const ClaudeQueue = (function () {
  const SHEET_NAME = 'Queue';

  function sheet_() {
    const id = PropertiesService.getScriptProperties().getProperty('CLAUDE_QUEUE_SHEET_ID');
    if (!id) throw new Error('Set CLAUDE_QUEUE_SHEET_ID in Script Properties');
    const ss = SpreadsheetApp.openById(id);
    const sh = ss.getSheetByName(SHEET_NAME);
    if (!sh) throw new Error(`Tab "${SHEET_NAME}" not found in queue sheet`);
    return sh;
  }

  /**
   * Append a prompt to the queue. Returns the row id.
   *
   * opts:
   *   - model:   string, written to column H. Either a claude model name
   *              ("claude-sonnet-4-6") or a local alias ("local", "bonsai",
   *              "bonsai2") to run on the local llama-server. Leave blank to
   *              use the worker's DEFAULT_MODEL. A local row that fails falls
   *              back to claude, and vice versa, per the worker's fallback
   *              policy.
   *   - tools:   string, written to column J. When non-empty, the worker runs
   *              `claude -p` with --allowed-tools set to this value and
   *              --permission-mode bypassPermissions so tool use is auto-approved.
   *              Example: "Bash(gws sheets values get:*)"
   *              Tool-use rows always run on claude; a local model name with a
   *              tools value is rejected rather than silently dropped.
   *   - context: object, JSON-stringified into column L for the worker to pass
   *              through or for the prompt to reference.
   */
  function submit(prompt, opts) {
    opts = opts || {};
    const id = Utilities.getUuid();
    const now = new Date().toISOString();
    const contextJson = opts.context ? JSON.stringify(opts.context) : '';
    sheet_().appendRow([
      id,
      prompt,
      'pending',
      now,
      '',
      '',
      '',
      opts.model || '',
      '',
      opts.tools || '',
      '',
      contextJson,
    ]);
    return id;
  }

  /**
   * Check the status of a submitted prompt.
   * Returns: {
   *   status: 'pending'|'processing'|'done'|'error'|'missing',
   *   response?: string,
   *   error?: string,
   *   progress?: string,
   *   row?: number,
   * }
   */
  function status(id) {
    const data = sheet_().getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === id) {
        const s = (data[i][2] || '').toLowerCase();
        return {
          status: s,
          response: data[i][4] || '',
          error: data[i][8] || '',
          progress: data[i][10] || '',
          row: i + 1,
        };
      }
    }
    return { status: 'missing' };
  }

  /**
   * Poll until the row resolves or times out. Synchronous — watch the 6-min
   * GAS execution cap if you call this from a web-app entry point.
   */
  function poll(id, opts) {
    opts = opts || {};
    const timeoutMs = opts.timeoutMs || 120000;
    const intervalMs = opts.intervalMs || 1500;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const s = status(id);
      if (s.status === 'done' || s.status === 'error') return s;
      Utilities.sleep(intervalMs);
    }
    return { status: 'timeout' };
  }

  /**
   * Convenience: submit + poll in one call.
   */
  function ask(prompt, opts) {
    const id = submit(prompt, opts);
    return poll(id, opts);
  }

  return { submit, status, poll, ask };
})();
