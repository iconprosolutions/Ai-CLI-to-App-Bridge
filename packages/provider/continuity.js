'use strict';

const crypto = require('crypto');

// Session continuity store (gap fill #4). Every OpenAI-style request resends the
// whole history; a fresh CLI spawn would re-ingest all of it. Both facts are
// wasteful. This store lets the bridge resume the CLI's own conversation
// (claude --resume <session_id>) and send only the *new* trailing turn — prompt
// size per call stays flat regardless of conversation length.
//
// It is a pure accelerator: any mismatch (edited history, unknown account,
// disabled) falls back to a normal full-prompt spawn. Keyed by a hash of the
// exact prior transcript, so a false match is cryptographically implausible.
// In-memory only; a restart just means one full-prompt call per conversation.

function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}

// The comparable essence of a message: role + flattened text + tool linkage.
function normMessage(m, formatContent) {
  const content = typeof m.content === 'string'
    ? m.content
    : (formatContent ? formatContent(m.content) : JSON.stringify(m.content == null ? '' : m.content));
  return {
    role: m.role || 'user',
    content,
    tool_calls: m.tool_calls || null,
    tool_call_id: m.tool_call_id || null,
  };
}

function createContinuityStore({
  formatContent = null,
  max = Number(process.env.BRIDGE_SESSIONS_MAX) || 200,
  ttlMs = Number(process.env.BRIDGE_SESSIONS_TTL_MS) || 24 * 60 * 60 * 1000,
  enabled = process.env.BRIDGE_SESSIONS !== '0',
} = {}) {
  const map = new Map(); // hash → { sessionId, engine, account, at }

  const hashOf = (routeId, messages) => crypto.createHash('sha256')
    .update(stableStringify([routeId, messages.map((m) => normMessage(m, formatContent))]))
    .digest('hex');

  const prune = () => {
    const now = Date.now();
    for (const [k, v] of map) if (now - v.at > ttlMs) map.delete(k);
    while (map.size > max) map.delete(map.keys().next().value); // Map preserves insertion order → oldest first
  };

  return {
    get enabled() { return enabled; },

    // Does the conversation minus its trailing message match a stored session?
    // Returns { resumeId, engine, account, deltaMessages } or null. deltaMessages
    // is the single new trailing turn to actually send with --resume.
    lookup(routeId, messages) {
      if (!enabled || !Array.isArray(messages) || messages.length < 2) return null;
      const key = hashOf(routeId, messages.slice(0, -1));
      const hit = map.get(key);
      if (!hit) return null;
      map.delete(key); map.set(key, { ...hit, at: Date.now() }); // LRU: refresh recency
      return { resumeId: hit.sessionId, engine: hit.engine, account: hit.account, deltaMessages: messages.slice(-1) };
    },

    // After a completion, store the full transcript (input + assistant reply)
    // keyed to the engine's conversation handle, so the next extending request
    // resumes. No-op without a sessionId (agy has none → claude-only).
    remember(routeId, engine, account, messages, replyText, sessionId) {
      if (!enabled || !sessionId || !Array.isArray(messages)) return;
      const full = messages.concat([{ role: 'assistant', content: String(replyText == null ? '' : replyText) }]);
      map.set(hashOf(routeId, full), { sessionId, engine, account, at: Date.now() });
      prune();
    },

    // Drop everything for an engine (called when its accounts/routes reload).
    evictEngine(engine) {
      for (const [k, v] of map) if (v.engine === engine) map.delete(k);
    },

    size: () => map.size,
  };
}

module.exports = { createContinuityStore, stableStringify };
