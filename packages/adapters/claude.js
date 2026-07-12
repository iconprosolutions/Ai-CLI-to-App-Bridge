'use strict';

const { runCli, BridgeError } = require('@bridge/core');
const { claudeIdentity } = require('./identity');

// Static catalogue — Claude Code has no free model-listing command; this
// mirrors what the CLI accepts. (Moved from claude-bridge KNOWN_MODELS.)
const KNOWN_MODELS = [
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', description: 'Current recommended Claude Code default for most work.', contextWindow: 200000, isFree: false },
  { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', description: 'Balanced Claude model with strong reasoning and speed.', contextWindow: 200000, isFree: false },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', description: 'Fast Claude model for quick responses and lightweight tasks.', contextWindow: 200000, isFree: false },
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', description: 'Next-generation frontier reasoning Opus model.', contextWindow: 200000, isFree: false },
  { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', description: 'Highest-capability Claude model available in this bridge.', contextWindow: 200000, isFree: false },
  { id: 'claude-opus-4-1', name: 'Claude Opus 4.1', description: 'Previous Opus generation still available in Claude Code.', contextWindow: 200000, isFree: false },
];

const MODEL_ALIASES = {
  'claude-3-5-haiku-20241022': 'claude-haiku-4-5',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-4-5',
  'claude-3-7-sonnet-20250219': 'claude-sonnet-4-6',
  'claude-opus-4.8': 'claude-opus-4-8',
  'claude-subscription-opus-4.8': 'claude-opus-4-8',
};

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const NOT_MY_LIMIT_RE = /not your usage limit/i;

// Parse a reset instant out of Claude limit-error text. Two generations:
// legacy "…usage limit reached|<epoch>" and current human wording
// ("resets 3:45pm", "resets Mon 12:00am", "resets Jul 14 at 4pm (Europe/Berlin)").
// Returns epoch ms or null.
// ponytail: good enough — times are read in THIS process's zone, so a tz-suffixed
// wording can drift hours on a UTC host; bounded by the breaker clamp. Phase 2
// wires poll-derived resets_at to correct open breakers.
function parseClaudeResetMs(text, now = Date.now()) {
  const s = String(text || '');
  const epoch = /\|(\d{10,13})\b/.exec(s);
  if (epoch) { const n = Number(epoch[1]); return n < 1e12 ? n * 1000 : n; }
  const m = /resets?\s+(?:at\s+)?([^·\n().,]+)/i.exec(s);
  if (!m) return null;
  const phrase = m[1].trim().toLowerCase();
  const t = /(\d{1,2})(?::(\d{2}))?\s*([ap]m)/.exec(phrase);
  if (!t) return null;
  const hour = (Number(t[1]) % 12) + (t[3] === 'pm' ? 12 : 0);
  const minute = Number(t[2] || 0);
  const d = new Date(now);
  d.setSeconds(0, 0);
  const mon = new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\s+(\\d{1,2})\\b`).exec(phrase);
  const wd = new RegExp(`\\b(${WEEKDAYS.join('|')})[a-z]*\\b`).exec(phrase);
  if (mon) {
    d.setMonth(MONTHS.indexOf(mon[1]), Number(mon[2]));
    d.setHours(hour, minute);
    if (d.getTime() <= now) d.setFullYear(d.getFullYear() + 1);
  } else if (wd) {
    d.setHours(hour, minute);
    let delta = (WEEKDAYS.indexOf(wd[1]) - d.getDay() + 7) % 7;
    if (delta === 0 && d.getTime() <= now) delta = 7;
    d.setDate(d.getDate() + delta);
  } else {
    d.setHours(hour, minute);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

// One quota-wording decision for all three classification sites (exit-time
// stderr/stdout, mid-stream isApiErrorMessage events, result-line errors).
// The server throttle explicitly says it is NOT the subscription limit —
// retryable on the same account, never a quota signal.
function isQuotaText(text) {
  const s = String(text || '');
  if (NOT_MY_LIMIT_RE.test(s)) return false;
  return /usage limit|limit reached|limit will reset|rate limit|hit your \S+ limit/i.test(s);
}

function classifyError(stderr, stdout) {
  const text = [stderr, stdout].map((p) => String(p || '').trim()).filter(Boolean).join('\n');
  if (isQuotaText(text)) {
    const until = parseClaudeResetMs(text);
    return new BridgeError('quota', 'Claude subscription capacity is exhausted for now. Retry after the limit window resets.', {
      detail: text.slice(0, 300),
      ...(until ? { cooldownUntilMs: until } : {}),
    });
  }
  if (text.includes("There's an issue with the selected model") || text.includes('deprecated and will reach end-of-life')) {
    return new BridgeError('model_not_found', 'The requested Claude model is not available in this Claude Code install.', { detail: text.slice(0, 300) });
  }
  return null;
}

// Claude Code is an agentic CLI: in -p mode it can still execute read-only
// tools (Read/Glob/Grep) against the LOCAL filesystem and load the user's MCP
// servers. A bridge request must behave like a remote model, not a local
// agent, so we deny the built-ins and skip MCP unless explicitly re-enabled
// (CLAUDE_LOCAL_TOOLS=1). Note: tool *definitions* stay in Claude Code's
// context (~15k prompt tokens of harness overhead) — no CLI flag removes
// them; this lockdown prevents execution, which is the safety boundary.
const LOCKDOWN_TOOLS = 'Task,Bash,Glob,Grep,Read,Edit,Write,NotebookEdit,WebFetch,WebSearch,TodoWrite,SlashCommand,Skill';

// Newer CLIs hard-fail when a deny rule names a tool that no longer exists
// (e.g. 2.1.201 dropped SlashCommand). Detect that error, prune the name, retry.
const UNKNOWN_DENY_RULE_RE = /deny rule "([^"]+)" matches no known tool/i;

function createClaudeAdapter(opts = {}) {
  const bin = opts.bin || process.env.CLAUDE_PATH || 'claude';
  const timeoutMs = opts.timeoutMs || Number(process.env.CLI_TIMEOUT_MS) || 5 * 60 * 1000;
  const maxBytes = opts.maxBytes || Number(process.env.MAX_CLI_OUTPUT_BYTES) || 10 * 1024 * 1024;
  const defaultModel = opts.defaultModel || process.env.CLAUDE_MODEL || null;
  const allowLocalTools = opts.allowLocalTools || process.env.CLAUDE_LOCAL_TOOLS === '1';
  // Mutable: names the installed CLI rejects as unknown are pruned at runtime.
  let lockdownTools = allowLocalTools ? [] : LOCKDOWN_TOOLS.split(',');
  const lockdownArgs = () => {
    if (allowLocalTools) return [];
    return lockdownTools.length
      ? ['--disallowedTools', lockdownTools.join(','), '--strict-mcp-config']
      : ['--strict-mcp-config'];
  };

  // Once the installed CLI rejects stream-json flags, stop trying (log once).
  let streamJsonBroken = false;
  let health = { at: 0, value: null };

  const normalizeModel = (model) => {
    if (!model || model === 'default') return defaultModel;
    return MODEL_ALIASES[model] || model;
  };

  async function invokeStreamJson({ prompt, model, signal, onDelta, env, resumeId }) {
    // --verbose is mandatory with -p + stream-json (verified live 2026-07-02).
    const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', ...lockdownArgs()];
    // Session continuity: resume the CLI's conversation and send only the new
    // turn (verified live: --resume carries prior context). Account-specific.
    if (resumeId) args.push('--resume', resumeId);
    if (model) args.push('--model', model);

    let buffer = '';
    let deltaText = '';
    let resultLine = null;
    let apiError = null;
    const handleLine = (line) => {
      if (!line.trim()) return;
      let obj;
      try { obj = JSON.parse(line); } catch (_) { return; } // hook noise / partials
      if (obj.type === 'stream_event' && obj.event) {
        const ev = obj.event;
        // Only text deltas — thinking/signature deltas interleave and are not
        // part of the answer.
        if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta' && ev.delta.text) {
          deltaText += ev.delta.text;
          if (typeof onDelta === 'function') onDelta(ev.delta.text);
        }
      } else if (obj.type === 'assistant' && obj.isApiErrorMessage) {
        // A mid-stream limit arrives as a synthetic assistant turn whose
        // stop_reason looks like a clean completion (claude-code#68816) —
        // isApiErrorMessage is the only reliable flag.
        const blocks = (obj.message && obj.message.content) || [];
        apiError = { error: String(obj.error || ''), text: blocks.map((b) => (b && b.text) || '').join(' ').trim() };
      } else if (obj.type === 'result') {
        resultLine = obj;
      }
    };

    await runCli(bin, args, {
      stdin: prompt,
      signal,
      timeoutMs,
      maxBytes,
      classifyError,
      // runCli replaces the child env wholesale — spread process.env so an
      // account override (CLAUDE_CONFIG_DIR) adds to, not erases, the base.
      env: env ? { ...process.env, ...env } : undefined,
      onDelta: (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) handleLine(line);
      },
    });
    if (buffer.trim()) handleLine(buffer);

    if (apiError) {
      const throttle = NOT_MY_LIMIT_RE.test(apiError.text);
      const isQuota = !throttle && (apiError.error === 'rate_limit' || isQuotaText(apiError.text));
      const until = isQuota ? parseClaudeResetMs(apiError.text) : null;
      throw new BridgeError(isQuota ? 'quota' : 'bad_output',
        apiError.text || 'Claude reported an API error mid-stream',
        { ...(until ? { cooldownUntilMs: until } : {}) });
    }
    if (!resultLine) {
      throw new BridgeError('bad_output', 'claude did not emit a stream-json result event', { detail: deltaText.slice(0, 200) });
    }
    if (resultLine.is_error) {
      const msg = String(resultLine.result || resultLine.subtype || 'Claude request failed');
      let kind = 'bad_output';
      if (isQuotaText(msg)) kind = 'quota';
      else if (/not logged in|please run \/login|authentication_failed|oauth token (?:expired|revoked)|invalid api key/i.test(msg)) kind = 'auth';
      const until = kind === 'quota' ? parseClaudeResetMs(msg) : null;
      throw new BridgeError(kind, msg, { ...(until ? { cooldownUntilMs: until } : {}) });
    }
    const u = resultLine.usage || {};
    return {
      text: resultLine.result !== undefined && resultLine.result !== null ? String(resultLine.result) : deltaText,
      usage: {
        promptTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
        completionTokens: u.output_tokens || 0,
        source: 'real',
      },
      stopReason: resultLine.stop_reason || 'end_turn',
      sessionId: resultLine.session_id,
    };
  }

  async function invokeText({ prompt, model, signal, onDelta, env, resumeId }) {
    const args = ['-p', ...lockdownArgs()];
    if (resumeId) args.push('--resume', resumeId);
    if (model) args.push('--model', model);
    const run = await runCli(bin, args, {
      stdin: prompt, signal, timeoutMs, maxBytes, onDelta, classifyError,
      env: env ? { ...process.env, ...env } : undefined,
    });
    return { text: run.text.trim(), usage: null, stopReason: 'end_turn' };
  }

  return {
    name: 'claude',
    capabilities: { streaming: true, nativeUsage: true, sessions: true },

    async invoke({ prompt, model, signal, onDelta, env, resumeId } = {}) {
      const selected = normalizeModel(model);
      // Bounded by the lockdown list length: each pass either succeeds, prunes
      // one unknown deny-rule name and retries, or throws.
      for (;;) {
        try {
          if (!streamJsonBroken) {
            try {
              return await invokeStreamJson({ prompt, model: selected, signal, onDelta, env, resumeId });
            } catch (err) {
              const msg = String(err.message || '');
              if (err.kind === 'bad_output' && /unknown option|output-format|stream-json|--verbose|--include-partial-messages/i.test(msg)) {
                streamJsonBroken = true;
                console.warn('[claude-adapter] installed CLI rejects stream-json; falling back to text mode (estimated usage)');
              } else {
                throw err;
              }
            }
          }
          return await invokeText({ prompt, model: selected, signal, onDelta, env, resumeId });
        } catch (err) {
          const m = UNKNOWN_DENY_RULE_RE.exec(`${err.message || ''} ${(err.data && err.data.detail) || ''}`);
          if (m && lockdownTools.includes(m[1])) {
            lockdownTools = lockdownTools.filter((t) => t !== m[1]);
            console.warn(`[claude-adapter] installed CLI does not know tool "${m[1]}"; pruned from the lockdown deny list`);
            continue;
          }
          throw err;
        }
      }
    },

    async listModels() {
      return KNOWN_MODELS;
    },

    // Which account is signed in for this spawn's config dir (no CLI call).
    identity(env) {
      return claudeIdentity((env && env.CLAUDE_CONFIG_DIR) || process.env.CLAUDE_CONFIG_DIR || null);
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

module.exports = { createClaudeAdapter, KNOWN_MODELS, parseClaudeResetMs, classifyError, isQuotaText };
