#!/usr/bin/env node
// Scriptable fake CLI for contract tests. Mode via FAKE_CLI_MODE env or argv[2].
//   echo-stdin  — read all of stdin, echo it to stdout
//   utf8-split  — emit 😀 (F0 9F 98 80) split across two writes
//   ansi-split  — emit ANSI-colored text with the CSI sequence split across writes
//   flood       — write FAKE_CLI_BYTES (default 500000) bytes of 'x'
//   hang        — never exit (until killed)
//   stderr-fail — write FAKE_CLI_STDERR (default 'quota exhausted') to stderr, exit 2
//   ok          — print 'ok' and exit 0
//   claude-sim  — emulate `claude -p --output-format stream-json`: reads the
//                 prompt from stdin, emits text_delta stream events + a result
//                 line with fixed real usage {input:7, output:9}. Remaining
//                 argv is the CLI arg list (logged to FAKE_CLI_LOG when set).
//                 FAKE_CLI_TEXT overrides the reply; FAKE_CLI_DELAY sleeps
//                 before the result; FAKE_CLI_STDERR + exit 1 when set.
//   agy-sim     — emulate agy: `models` subcommand lists FAKE_CLI_MODELS;
//                 `--print <prompt>` replies with ANSI-wrapped text.

const mode = process.env.FAKE_CLI_MODE || process.argv[2] || 'ok';
const simArgs = process.argv.slice(3);

// Multiline reply text survives shell quoting poorly — allow a file override.
function bakedText() {
  if (process.env.FAKE_CLI_TEXT) return process.env.FAKE_CLI_TEXT;
  if (process.env.FAKE_CLI_TEXT_FILE) {
    try { return require('fs').readFileSync(process.env.FAKE_CLI_TEXT_FILE, 'utf8'); } catch (_) { return null; }
  }
  return null;
}

function logInvocation() {
  if (process.env.FAKE_CLI_LOG) {
    require('fs').appendFileSync(process.env.FAKE_CLI_LOG, `${JSON.stringify(simArgs)}\n`);
  }
  // Separate file: FAKE_CLI_LOG lines are parsed as plain argv arrays by
  // existing tests; env assertions need the account-redirect variables too.
  if (process.env.FAKE_CLI_ENV_LOG) {
    require('fs').appendFileSync(process.env.FAKE_CLI_ENV_LOG, `${JSON.stringify({
      argv: simArgs,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || null,
      HOME: process.env.HOME || null,
    })}\n`);
  }
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (mode === 'echo-stdin') {
    let data = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) data += chunk;
    process.stdout.write(data);
    return;
  }
  if (mode === 'utf8-split') {
    process.stdout.write(Buffer.from([0xf0, 0x9f, 0x98]));
    await delay(120);
    process.stdout.write(Buffer.from([0x80, 0x0a]));
    return;
  }
  if (mode === 'ansi-split') {
    // "\x1b[32mgreen\x1b[0m done" with the reset sequence split mid-escape.
    process.stdout.write('\x1b[32mgreen\x1b[');
    await delay(120);
    process.stdout.write('0m done\n');
    return;
  }
  if (mode === 'flood') {
    const total = Number(process.env.FAKE_CLI_BYTES) || 500000;
    const chunk = 'x'.repeat(8192);
    let written = 0;
    while (written < total) {
      const n = Math.min(chunk.length, total - written);
      process.stdout.write(chunk.slice(0, n));
      written += n;
      // eslint-disable-next-line no-await-in-loop
      if (written % (8192 * 8) === 0) await delay(1);
    }
    return;
  }
  if (mode === 'hang') {
    setInterval(() => {}, 1 << 30);
    return;
  }
  if (mode === 'stderr-fail') {
    process.stderr.write(process.env.FAKE_CLI_STDERR || 'quota exhausted');
    process.exit(2);
  }
  if (mode === 'claude-sim') {
    logInvocation();
    if (simArgs[0] === '--version') { process.stdout.write('fake-claude 0.0.0\n'); return; }
    // Logged-out account: mirrors the real CLI (verified 2026-07-02) — a
    // result line with is_error:true and exit 0.
    if (process.env.FAKE_CLI_AUTH_FAIL) {
      await readStdin();
      process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`);
      process.stdout.write(`${JSON.stringify({
        type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login',
        stop_reason: 'stop_sequence', session_id: 'fake-session-authfail', usage: { input_tokens: 0, output_tokens: 0 },
      })}\n`);
      return;
    }
    if (process.env.FAKE_CLI_STDERR) {
      process.stderr.write(process.env.FAKE_CLI_STDERR);
      process.exit(1);
    }
    const prompt = await readStdin();
    let text = bakedText() || `[claude] replied to "${prompt.trim().slice(0, 24)}"`;
    // Stateful failure injection: first invocation replies garbage, later
    // ones reply the baked text — exercises the response_format repair retry.
    if (process.env.FAKE_CLI_GARBAGE_FIRST && process.env.FAKE_CLI_STATE_FILE) {
      const fsx = require('fs');
      if (!fsx.existsSync(process.env.FAKE_CLI_STATE_FILE)) {
        fsx.writeFileSync(process.env.FAKE_CLI_STATE_FILE, '1');
        text = 'Sure thing! Happy to help, but there is no JSON here at all.';
      }
    }
    if (process.env.FAKE_CLI_DELAY) await delay(Number(process.env.FAKE_CLI_DELAY));
    const mid = Math.ceil(text.length / 2);
    const ev = (t) => `${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } })}\n`;
    process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`);
    process.stdout.write(ev(text.slice(0, mid)));
    await delay(10);
    process.stdout.write(ev(text.slice(mid)));
    process.stdout.write(`${JSON.stringify({
      type: 'result', subtype: 'success', is_error: false, result: text, stop_reason: 'end_turn',
      session_id: 'fake-session-1',
      usage: { input_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 },
    })}\n`);
    return;
  }
  if (mode === 'agy-sim') {
    logInvocation();
    if (simArgs[0] === '--version') { process.stdout.write('fake-agy 0.0.0\n'); return; }
    if (simArgs[0] === 'models') {
      process.stdout.write(`${(process.env.FAKE_CLI_MODELS || 'Gemini 3.5 Flash (Medium)\nGemini 3.1 Pro (High)')}\n`);
      return;
    }
    if (process.env.FAKE_CLI_STDERR) {
      process.stderr.write(process.env.FAKE_CLI_STDERR);
      process.exit(1);
    }
    const i = simArgs.indexOf('--print');
    const prompt = i !== -1 ? String(simArgs[i + 1] || '') : '';
    const text = bakedText() || `[gemini] replied to "${prompt.trim().slice(0, 24)}"`;
    if (process.env.FAKE_CLI_DELAY) await delay(Number(process.env.FAKE_CLI_DELAY));
    process.stdout.write(`\x1b[32m${text}\x1b[0m\n`);
    return;
  }
  process.stdout.write('ok\n');
}

main();
