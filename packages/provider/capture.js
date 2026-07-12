'use strict';

const crypto = require('crypto');

// Opt-in debug capture: a ring buffer of the last N full exchanges, in
// memory only — never written to disk, cleared on restart and on toggle-off.
// The documented default stays metadata-only.
function createCapture({ max = 50 } = {}) {
  let enabled = false;
  let ring = [];

  function setEnabled(next) {
    enabled = Boolean(next);
    if (!enabled) ring = [];
    return enabled;
  }

  function start(meta) {
    if (!enabled) return null;
    const entry = {
      id: crypto.randomBytes(6).toString('hex'),
      meta, // {reqId, appId, routeId, engine, model, streaming}
      startedAt: new Date().toISOString(),
      stages: {}, // {queuedMs, firstByteMs, totalMs}
      sentPrompt: null,
      rawOutput: '',
      parsed: null,
      error: null,
      status: null,
    };
    ring.unshift(entry);
    if (ring.length > max) ring.length = max;
    return entry;
  }

  function list() {
    return ring.map((e) => ({
      id: e.id,
      ...e.meta,
      startedAt: e.startedAt,
      stages: e.stages,
      status: e.status,
      hasError: Boolean(e.error),
      promptBytes: e.sentPrompt ? Buffer.byteLength(e.sentPrompt) : 0,
      outputBytes: e.rawOutput ? Buffer.byteLength(e.rawOutput) : 0,
    }));
  }

  function get(id) {
    return ring.find((e) => e.id === id) || null;
  }

  return {
    setEnabled,
    start,
    list,
    get,
    get enabled() { return enabled; },
    get size() { return ring.length; },
  };
}

module.exports = { createCapture };
