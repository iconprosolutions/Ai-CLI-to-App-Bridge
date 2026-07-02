'use strict';

const { runCli, BridgeError } = require('@bridge/core');

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

function classifyError(stderr, stdout) {
  const text = [stderr, stdout].map((p) => String(p || '').trim()).filter(Boolean).join('\n');
  if (/usage limit|limit reached|limit will reset|rate limit/i.test(text)) {
    return new BridgeError('quota', 'Claude subscription capacity is exhausted for now. Retry after the limit window resets.', { detail: text.slice(0, 300) });
  }
  if (text.includes("There's an issue with the selected model") || text.includes('deprecated and will reach end-of-life')) {
    return new BridgeError('model_not_found', 'The requested Claude model is not available in this Claude Code install.', { detail: text.slice(0, 300) });
  }
  return null;
}

function createClaudeAdapter(opts = {}) {
  const bin = opts.bin || process.env.CLAUDE_PATH || 'claude';
  const timeoutMs = opts.timeoutMs || Number(process.env.CLI_TIMEOUT_MS) || 5 * 60 * 1000;
  const maxBytes = opts.maxBytes || Number(process.env.MAX_CLI_OUTPUT_BYTES) || 10 * 1024 * 1024;
  const defaultModel = opts.defaultModel || process.env.CLAUDE_MODEL || null;

  // Once the installed CLI rejects stream-json flags, stop trying (log once).
  let streamJsonBroken = false;
  let health = { at: 0, value: null };

  const normalizeModel = (model) => {
    if (!model || model === 'default') return defaultModel;
    return MODEL_ALIASES[model] || model;
  };

  async function invokeStreamJson({ prompt, model, signal, onDelta }) {
    // --verbose is mandatory with -p + stream-json (verified live 2026-07-02).
    const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
    if (model) args.push('--model', model);

    let buffer = '';
    let deltaText = '';
    let resultLine = null;
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
      onDelta: (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) handleLine(line);
      },
    });
    if (buffer.trim()) handleLine(buffer);

    if (!resultLine) {
      throw new BridgeError('bad_output', 'claude did not emit a stream-json result event', { detail: deltaText.slice(0, 200) });
    }
    if (resultLine.is_error) {
      const msg = String(resultLine.result || resultLine.subtype || 'Claude request failed');
      const kind = /usage limit|limit reached|rate limit/i.test(msg) ? 'quota' : 'bad_output';
      throw new BridgeError(kind, msg);
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

  async function invokeText({ prompt, model, signal, onDelta }) {
    const args = ['-p'];
    if (model) args.push('--model', model);
    const run = await runCli(bin, args, { stdin: prompt, signal, timeoutMs, maxBytes, onDelta, classifyError });
    return { text: run.text.trim(), usage: null, stopReason: 'end_turn' };
  }

  return {
    name: 'claude',
    capabilities: { streaming: true, nativeUsage: true, sessions: false },

    async invoke({ prompt, model, signal, onDelta } = {}) {
      const selected = normalizeModel(model);
      if (!streamJsonBroken) {
        try {
          return await invokeStreamJson({ prompt, model: selected, signal, onDelta });
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
      return invokeText({ prompt, model: selected, signal, onDelta });
    },

    async listModels() {
      return KNOWN_MODELS;
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

module.exports = { createClaudeAdapter, KNOWN_MODELS };
