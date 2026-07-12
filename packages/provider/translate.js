'use strict';

const crypto = require('crypto');

// OpenAI ⇄ engine translation, carried over from the legacy provider with
// the Phase 0 fixes intact. Phase 3 hardens this layer (tool-call hold-back,
// response_format repair, SSE hygiene).

function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.round(String(text).length / 4));
}

function formatContent(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        if (item.type === 'text') return item.text || '';
        if (item.type === 'image_url') return `[Image: ${item.image_url?.url || item.image_url}]`;
      }
      return JSON.stringify(item);
    }).join('\n');
  }
  return String(content);
}

function parseToolCallsFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];
  const candidate = (match[1] || text).trim();
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
      return parsed.tool_calls.map((tc) => ({
        id: tc.id || `call_${crypto.randomBytes(6).toString('hex')}`,
        type: tc.type || 'function',
        function: {
          name: tc.function?.name || tc.name || 'unknown_tool',
          arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
        },
      }));
    }
  } catch (_) { /* not a tool payload */ }
  return null;
}

function messagesToPrompt(messages, opts = {}) {
  const parts = [];
  if (opts.tools && Array.isArray(opts.tools) && opts.tools.length > 0) {
    // tool_choice steers how strongly the model is pushed toward a call:
    // auto = may call; required = must call; a named function = must call it.
    let choiceLine = 'If no tool call is needed, reply directly with plain text.';
    if (opts.toolChoice === 'required') {
      choiceLine = 'You MUST respond with a tool call — plain-text replies are not acceptable for this request.';
    }
    if (opts.forcedToolName) {
      choiceLine = `You MUST respond with a call to the tool "${opts.forcedToolName}" — no other tool and no plain-text reply is acceptable for this request.`;
    }
    parts.push(`[SYSTEM]\nYou have access to the following tools:\n${JSON.stringify(opts.tools, null, 2)}\n\nIf you decide to call a tool, respond ONLY with a JSON object inside a \`\`\`json\`\`\` code block matching this exact schema:\n{\n  "tool_calls": [\n    {\n      "id": "call_abc123",\n      "type": "function",\n      "function": {\n        "name": "tool_name",\n        "arguments": "{\\"arg\\": \\"val\\"}"\n      }\n    }\n  ]\n}\n\nComplete example — for a tool "get_weather" taking {"city": string}, a correct reply is EXACTLY:\n\`\`\`json\n{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\\"city\\": \\"Paris\\"}"}}]}\n\`\`\`\nCRITICAL: "arguments" MUST be a STRING containing escaped JSON (as shown), never a nested object. Do not add commentary before or after the code block.\n${choiceLine}`);
  } else if (opts.textOnlyTools) {
    parts.push('[SYSTEM]\nThe caller supplied tool/function metadata, but this bridge route is text-only. Do not emit tool calls. Answer directly from the conversation context.');
  }

  if (opts.responseFormat) {
    if (typeof opts.responseFormat === 'object' && opts.responseFormat.type === 'json_object') {
      parts.push('[SYSTEM]\nCRITICAL: You MUST output valid JSON only. Do not include introductory text or explanations outside JSON.');
    } else if (typeof opts.responseFormat === 'object' && opts.responseFormat.json_schema) {
      parts.push(`[SYSTEM]\nCRITICAL: You MUST output valid JSON strictly matching this schema:\n${JSON.stringify(opts.responseFormat.json_schema, null, 2)}`);
    }
  }

  for (const m of messages) {
    const roleStr = String(m.role || 'user').toUpperCase();
    let text = formatContent(m.content);
    if (m.tool_calls && Array.isArray(m.tool_calls)) {
      text += `\n[TOOL CALLS]\n${JSON.stringify(m.tool_calls, null, 2)}`;
    }
    if (m.role === 'tool') {
      text = `[TOOL RESULT for call_id=${m.tool_call_id || 'unknown'}]\n${text}`;
    }
    parts.push(`[${roleStr}]\n${text}`);
  }
  return parts.join('\n\n');
}

function openaiErrorBody(message, type, param) {
  return { error: { message, type, param: param === undefined ? null : param, code: null } };
}

// ── Output shaping: stop sequences + max_tokens ────────────────────────────
// The CLIs run to completion — they honor neither param — so the bridge
// enforces both after the fact, matching OpenAI semantics: the earliest stop
// sequence truncates the reply (the sequence itself removed, finish_reason
// "stop"); max_tokens caps completion length (finish_reason "length"). Token
// accounting is the same ~4-chars/token estimate used everywhere else.

// OpenAI accepts stop as a string or an array of up to 4; normalize to a
// clean string[] (empty strings dropped — they'd match everywhere).
function normalizeStops(stop) {
  const arr = Array.isArray(stop) ? stop : (stop === undefined || stop === null ? [] : [stop]);
  return arr.filter((s) => typeof s === 'string' && s.length > 0).slice(0, 4);
}

// Cut `text` to at most `maxTokens` tokens using the char/token estimate,
// landing on the last whole token so we don't cut mid-character.
function truncateToTokens(text, maxTokens) {
  const maxChars = maxTokens * 4; // inverse of estimateTokens
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

// Apply stop then max_tokens to a complete reply. Returns the possibly-cut
// text and a finish_reason ('stop' by default; 'length' iff max_tokens did
// the cutting). Stop wins ties: a stop cut keeps finish_reason 'stop'.
function applyStopAndMax(text, { stop, maxTokens } = {}) {
  let out = String(text == null ? '' : text);
  let finishReason = 'stop';
  const stops = normalizeStops(stop);
  let earliest = -1;
  for (const s of stops) {
    const i = out.indexOf(s);
    if (i !== -1 && (earliest === -1 || i < earliest)) earliest = i;
  }
  if (earliest !== -1) out = out.slice(0, earliest);
  if (maxTokens && estimateTokens(out) > maxTokens) {
    out = truncateToTokens(out, maxTokens);
    finishReason = 'length';
  }
  return { text: out, finishReason, truncated: out.length !== String(text == null ? '' : text).length };
}

// Streaming counterpart: fed incremental chunks, it emits only the text that
// is safe to release now, holds back a tail that might be the start of a stop
// sequence spanning a chunk boundary, and reports when the reply is complete
// (a stop sequence matched or the token cap was reached) so the caller stops
// the stream. finish_reason reflects which limit ended it.
function createOutputLimiter({ stop, maxTokens } = {}) {
  const stops = normalizeStops(stop);
  const maxStopLen = stops.reduce((m, s) => Math.max(m, s.length), 0);
  let pending = ''; // not-yet-safe tail (could begin a stop sequence)
  let emittedTokens = 0;
  let done = false;
  let finishReason = null;

  // Given the running buffer, return the index of the earliest stop match.
  const earliestStop = (buf) => {
    let e = -1;
    for (const s of stops) {
      const i = buf.indexOf(s);
      if (i !== -1 && (e === -1 || i < e)) e = i;
    }
    return e;
  };

  return {
    // Returns the text to emit for this chunk ('' if all held back). Sets
    // done/finishReason when a limit ends the reply.
    push(chunk) {
      if (done) return '';
      pending += String(chunk || '');
      let emit = '';

      const si = earliestStop(pending);
      if (si !== -1) {
        emit = pending.slice(0, si);
        pending = '';
        done = true;
        finishReason = 'stop';
      } else if (maxStopLen > 1) {
        // Hold back a tail that could be the prefix of a stop sequence.
        const keep = Math.min(maxStopLen - 1, pending.length);
        emit = pending.slice(0, pending.length - keep);
        pending = pending.slice(pending.length - keep);
      } else {
        emit = pending;
        pending = '';
      }

      if (maxTokens) {
        const remaining = maxTokens - emittedTokens;
        if (remaining <= 0) { done = true; finishReason = finishReason || 'length'; return ''; }
        if (estimateTokens(emit) > remaining) {
          emit = truncateToTokens(emit, remaining);
          done = true;
          finishReason = 'length';
        }
      }
      emittedTokens += estimateTokens(emit);
      return emit;
    },
    // Flush the held-back tail at stream end (no stop matched).
    end() {
      if (done) return '';
      let emit = pending;
      pending = '';
      if (maxTokens) {
        const remaining = maxTokens - emittedTokens;
        if (remaining <= 0) return '';
        if (estimateTokens(emit) > remaining) { emit = truncateToTokens(emit, remaining); finishReason = 'length'; }
      }
      emittedTokens += estimateTokens(emit);
      return emit;
    },
    get done() { return done; },
    get finishReason() { return finishReason; },
  };
}

module.exports = {
  estimateTokens,
  formatContent,
  parseToolCallsFromText,
  messagesToPrompt,
  openaiErrorBody,
  normalizeStops,
  applyStopAndMax,
  createOutputLimiter,
};
