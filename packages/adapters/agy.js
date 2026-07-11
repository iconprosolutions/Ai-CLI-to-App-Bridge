'use strict';

const fs = require('fs');
const path = require('path');
const { runCli, BridgeError, createAnsiStripper, stripAnsi, collapseCarriageReturns } = require('@bridge/core');
const { geminiIdentity } = require('./identity');

// Antigravity model names are display names. (Moved from gemini-bridge.)
const CANDIDATE_MODELS = [
  { id: 'Gemini 3.5 Flash (Low)', name: 'Gemini 3.5 Flash (Low)', description: 'Fast Antigravity Gemini 3.5 Flash mode for routine app work.', contextWindow: 1000000, isFree: false },
  { id: 'Gemini 3.5 Flash (Medium)', name: 'Gemini 3.5 Flash (Medium)', description: 'Balanced Antigravity Gemini 3.5 Flash mode.', contextWindow: 1000000, isFree: false },
  { id: 'Gemini 3.5 Flash (High)', name: 'Gemini 3.5 Flash (High)', description: 'Higher-reasoning Antigravity Gemini 3.5 Flash mode.', contextWindow: 1000000, isFree: false },
  { id: 'Gemini 3.1 Pro (Low)', name: 'Gemini 3.1 Pro (Low)', description: 'Lower-latency Antigravity Gemini 3.1 Pro mode.', contextWindow: 1000000, isFree: false },
  { id: 'Gemini 3.1 Pro (High)', name: 'Gemini 3.1 Pro (High)', description: 'Most capable Antigravity Gemini 3.1 Pro mode available here.', contextWindow: 1000000, isFree: false },
];

const MODEL_ALIASES = {
  'gemini-1.5-pro': 'Gemini 3.5 Flash (Low)',
  'gemini-1.5-flash': 'Gemini 3.5 Flash (Low)',
  'gemini-2.0-flash': 'Gemini 3.5 Flash (Low)',
  'gemini-2.0-flash-thinking-exp': 'Gemini 3.5 Flash (Low)',
  'gemini-2.5-flash-8b': 'Gemini 3.5 Flash (Low)',
  'gemini-2.5-flash': 'Gemini 3.5 Flash (Low)',
  'gemini-2.5-pro': 'Gemini 3.1 Pro (Low)',
  'gemini-3-flash-preview': 'Gemini 3.5 Flash (Low)',
  'gemini-3.5-flash': 'Gemini 3.5 Flash (Low)',
  'gemini-3.1-pro': 'Gemini 3.1 Pro (Low)',
  'gemini-3.1-pro-preview': 'Gemini 3.1 Pro (Low)',
  'Gemini 3.5 Flash': 'Gemini 3.5 Flash (Low)',
  'Gemini 3.1 Pro': 'Gemini 3.1 Pro (Low)',
};

function classifyError(stderr, stdout) {
  const text = [stderr, stdout].map((p) => String(p || '').trim()).filter(Boolean).join('\n');
  if (/authentication failed|please sign in|not signed in|sign in to continue/i.test(text)) {
    return new BridgeError('auth', 'Antigravity is not signed in for this account. Complete the account login, then retry.', { detail: text.slice(0, 300) });
  }
  if (text.includes('You have exhausted your capacity on this model')
    || text.includes('You have exhausted your quota on this model')) {
    // stderr carries the real server error; stdout may be partial model prose
    // that could coincidentally contain reset-like wording. Prefer stderr.
    const fromStderr = agyCooldownUntilMs(String(stderr || ''));
    const until = fromStderr !== undefined ? fromStderr : agyCooldownUntilMs(text);
    return new BridgeError('quota', 'Antigravity capacity for this model is exhausted. Retry later or use a Flash mode.', {
      detail: text.slice(0, 300),
      ...(until !== undefined ? { cooldownUntilMs: until } : {}),
    });
  }
  if (text.includes('Requested entity was not found')) {
    return new BridgeError('model_not_found', 'The requested Gemini model is not available in this Antigravity session.', { detail: text.slice(0, 300) });
  }
  return null;
}

// "Resets in 2h3m57s" / "quota will reset after 146h52m11s" → seconds.
// The cli.log tail can hold several of these (one per failed run, freshest
// LAST) plus digitless prose like "reset after some time" — take the last
// match that actually carries digits. Null if none do.
function parseResetsIn(text) {
  const re = /\b(?:resets in|reset after)\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/gi;
  let m;
  let best = null;
  while ((m = re.exec(text))) {
    if (m[1] || m[2] || m[3]) best = m;
  }
  if (!best) return null;
  return (Number(best[1] || 0) * 3600) + (Number(best[2] || 0) * 60) + Number(best[3] || 0);
}

// "baseline quota will refresh on 3/24/2026, 5:04:50 PM" → epoch ms (V8 parses
// this US-locale form directly). The weekly-baseline lockout deadline.
function parseBaselineRefreshMs(text) {
  const m = /baseline quota will refresh on\s+([\d/]+,\s*[\d: ]+[AP]M)/i.exec(text);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}

// Deadline from any agy quota text: prefer the rolling-window duration
// (floored to 30s — the server has a known "reset after 1s" loop bug),
// else the weekly baseline date. Undefined when neither parses.
function agyCooldownUntilMs(text) {
  const sec = parseResetsIn(text);
  if (sec != null) return Date.now() + Math.max(sec, 30) * 1000;
  const baseline = parseBaselineRefreshMs(text);
  return baseline != null ? baseline : undefined;
}

// On quota exhaustion agy is COMPLETELY silent: exit 0, empty stdout, empty
// stderr (verified live 2026-07-10). The only evidence is its own log file
// ($HOME/.gemini/antigravity-cli/cli.log, a symlink to the newest log). When a
// run produces no output, read the log tail and classify — an empty reply is
// never a real answer, and returning it as a 200 poisons callers and skips the
// breaker + cross-model failover that a 429 would trigger.
function classifyEmptyOutput(home) {
  let tail = '';
  try {
    const logPath = path.join(home, '.gemini', 'antigravity-cli', 'cli.log');
    const fd = fs.openSync(logPath, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const want = Math.min(size, 16 * 1024);
      const buf = Buffer.alloc(want);
      fs.readSync(fd, buf, 0, want, size - want);
      tail = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) { /* no log — fall through to bad_output */ }

  if (/RESOURCE_EXHAUSTED|quota reached|Individual quota reached/i.test(tail)) {
    const retryAfterSec = parseResetsIn(tail);
    const until = agyCooldownUntilMs(tail);
    return new BridgeError('quota',
      `Antigravity quota for this Google account is exhausted.${retryAfterSec ? ` Resets in ~${Math.ceil(retryAfterSec / 60)} min.` : ''}`,
      {
        detail: 'agy exited 0 with no output; cli.log shows RESOURCE_EXHAUSTED',
        ...(retryAfterSec ? { retryAfterSec } : {}),
        ...(until !== undefined ? { cooldownUntilMs: until } : {}),
      });
  }
  if (/authentication failed|please sign in|not signed in|token.*(expired|revoked)/i.test(tail)) {
    return new BridgeError('auth', 'Antigravity is not signed in for this account. Complete the account login, then retry.', { detail: 'agy exited 0 with no output; cli.log shows an auth failure' });
  }
  return new BridgeError('bad_output', 'Antigravity returned no output for this request. Check the account on the dashboard (Probe) and retry.', { detail: 'agy exited 0 with empty stdout/stderr' });
}

function createAgyAdapter(opts = {}) {
  const bin = opts.bin || process.env.GEMINI_PATH || process.env.AGY_PATH || 'agy';
  const timeoutMs = opts.timeoutMs || Number(process.env.CLI_TIMEOUT_MS) || 5 * 60 * 1000;
  const maxBytes = opts.maxBytes || Number(process.env.MAX_CLI_OUTPUT_BYTES) || 10 * 1024 * 1024;
  const defaultModel = opts.defaultModel || process.env.GEMINI_MODEL || 'Gemini 3.5 Flash (Low)';
  // agy takes the prompt as a --print flag value (argv) — ARG_MAX applies.
  const maxPromptBytes = opts.maxPromptBytes || Number(process.env.MAX_PROMPT_BYTES) || 200 * 1024;

  let modelsCache = { at: 0, value: null };
  let health = { at: 0, value: null };

  const normalizeModel = (model) => {
    if (!model) return defaultModel;
    return MODEL_ALIASES[model] || model;
  };

  return {
    name: 'gemini',
    capabilities: { streaming: true, nativeUsage: false, sessions: false },

    async invoke({ prompt, model, signal, onDelta, env } = {}) {
      const selected = normalizeModel(model);
      const promptBytes = Buffer.byteLength(prompt || '', 'utf8');
      if (promptBytes > maxPromptBytes) {
        throw new BridgeError('invalid_request',
          `Prompt too large for the Antigravity (Gemini) CLI: ${promptBytes} bytes exceeds the ${maxPromptBytes}-byte cap (agy passes the prompt as a command-line argument, so ARG_MAX applies). Remedies: send this request to a Claude route (uses stdin, no cap), shorten the conversation history, or enable session continuity so only new turns are sent.`,
          { code: 'prompt_overflow' });
      }
      // Flag-injection guard: agy takes the prompt as the value of --print, so
      // it occupies one argv slot and can't add flags. But a prompt that
      // *starts* with '-' can be misread as an option by the CLI's parser — a
      // leading space (invisible to the model) keeps it a plain value.
      const safePrompt = /^\s*-/.test(prompt || '') ? ` ${prompt}` : (prompt || '');
      const args = ['--print', safePrompt, '--model', selected, '--print-timeout', `${Math.ceil(timeoutMs / 1000)}s`];
      const ansi = createAnsiStripper();
      const run = await runCli(bin, args, {
        signal,
        timeoutMs,
        maxBytes,
        classifyError,
        // runCli replaces the child env wholesale — spread process.env so an
        // account override (HOME) adds to, not erases, the base.
        env: env ? { ...process.env, ...env } : undefined,
        onDelta: typeof onDelta === 'function'
          ? (chunk) => {
            const cleaned = ansi.write(chunk);
            if (cleaned) onDelta(cleaned);
          }
          : null,
      });
      if (typeof onDelta === 'function') {
        const tail = ansi.end();
        if (tail) onDelta(tail);
      }
      // agy prints auth failures to stdout with EXIT 0 (verified live
      // 2026-07-02: "Error: authentication failed or timed out"), so the
      // classifier above never fires on them — catch it here rather than
      // returning the error line as the model's "answer". Length guard: a
      // long real reply that merely mentions signing in must pass through.
      // Quota gets the same treatment — a short quota-error line is never a real answer.
      const finalText = collapseCarriageReturns(stripAnsi(run.text)).trim();
      const stdoutErr = classifyError('', finalText);
      if (stdoutErr && (stdoutErr.kind === 'auth' || stdoutErr.kind === 'quota') && finalText.length < 200) throw stdoutErr;
      // Silent failure: exit 0 with no output at all (quota exhaustion does
      // this). Classify from the account's own agy log rather than handing an
      // empty "answer" to the caller.
      if (!finalText) {
        throw classifyEmptyOutput((env && env.HOME) || process.env.HOME || '');
      }
      return {
        text: finalText,
        usage: null, // agy reports no token counts — caller estimates
        stopReason: 'end_turn',
      };
    },

    // Which Google account is signed in for this spawn's HOME (no CLI call).
    identity(env) {
      return geminiIdentity((env && env.HOME) || process.env.HOME || null);
    },

    async listModels({ refresh = false } = {}) {
      if (!refresh && modelsCache.value && Date.now() - modelsCache.at < 60 * 60 * 1000) {
        return modelsCache.value;
      }
      try {
        const run = await runCli(bin, ['models'], { timeoutMs: 10000, maxBytes: 256 * 1024 });
        const names = stripAnsi(run.text).split('\n').map((s) => s.trim()).filter(Boolean);
        if (names.length) {
          const listed = names.map((id) => {
            const known = CANDIDATE_MODELS.find((m) => m.id === id);
            return known || { id, name: id, description: 'Reported by `agy models`.', contextWindow: 1000000, isFree: false };
          });
          modelsCache = { at: Date.now(), value: listed };
          return listed;
        }
      } catch (_) { /* fall through to candidates */ }
      return modelsCache.value || CANDIDATE_MODELS;
    },

    async healthCheck() {
      if (Date.now() - health.at < 60 * 1000 && health.value) return health.value;
      const started = Date.now();
      try {
        const run = await runCli(bin, ['--version'], { timeoutMs: 5000, maxBytes: 64 * 1024 });
        health = { at: Date.now(), value: { ok: true, status: 200, durationMs: Date.now() - started, detail: run.text.trim().slice(0, 80) } };
      } catch (err) {
        health = { at: Date.now(), value: { ok: false, status: 0, durationMs: Date.now() - started, detail: err.message } };
      }
      return health.value;
    },
  };
}

module.exports = { createAgyAdapter, CANDIDATE_MODELS, parseResetsIn, parseBaselineRefreshMs, classifyError };
