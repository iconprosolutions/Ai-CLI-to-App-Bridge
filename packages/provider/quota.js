'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Normalized per-window limit (ported from Orbit OS accounts.ts) ────────
// { kind:  'session' | 'weekly_all' | 'weekly_scoped' | <future>,
//   group: 'session' | 'weekly',
//   label: human string, percent: 0-100 USED, resetsAt: epoch ms | 0 }

const CLAUDE_LABELS = { session: 'Session (5h)', weekly_all: 'Weekly' };

// api.anthropic.com/api/oauth/usage — prefers the generic limits[] array so
// new limit kinds show up without code changes; falls back to the legacy
// five_hour/seven_day(+seven_day_<model>) shape.
function parseClaudeUsage(raw) {
  if (raw && Array.isArray(raw.limits)) {
    return raw.limits.filter(Boolean).map((l) => {
      const scopeName = l && l.scope && l.scope.model && l.scope.model.display_name;
      return {
        kind: String((l && l.kind) || 'unknown'),
        group: String((l && l.group) || ''),
        label: scopeName ? `${scopeName} weekly` : (CLAUDE_LABELS[(l || {}).kind] || String((l && l.kind) || 'unknown')),
        percent: Number(l && l.percent) || 0,
        resetsAt: l && l.resets_at ? (Date.parse(l.resets_at) || 0) : 0,
      };
    });
  }
  const out = [];
  const push = (w, kind, group, label) => {
    if (!w || typeof w !== 'object') return;
    out.push({ kind, group, label, percent: Number(w.utilization) || 0, resetsAt: w.resets_at ? (Date.parse(w.resets_at) || 0) : 0 });
  };
  push(raw && raw.five_hour, 'session', 'session', CLAUDE_LABELS.session);
  push(raw && raw.seven_day, 'weekly_all', 'weekly', CLAUDE_LABELS.weekly_all);
  for (const [k, w] of Object.entries(raw || {})) {
    const m = /^seven_day_(.+)$/.exec(k);
    if (m) push(w, 'weekly_scoped', 'weekly', `${m[1][0].toUpperCase()}${m[1].slice(1)} weekly`);
  }
  return out;
}

// cloudcode-pa retrieveUserQuotaSummary — buckets are per model FAMILY
// ("Gemini Models" / "Claude and GPT models"), each with a five-hour and a
// weekly entry. remainingFraction is 0..1 REMAINING → percent used.
function parseAgyQuotaSummary(raw) {
  const out = [];
  for (const g of (raw && raw.groups) || []) {
    for (const b of (g && g.buckets) || []) {
      const idText = String((b && b.bucketId) || '') + ' ' + String((b && b.displayName) || '');
      const isSession = /five|5.?hour|session/i.test(idText);
      const frac = b && b.remaining ? Number(b.remaining.remainingFraction) : NaN;
      const reset = b && b.resetTime
        ? (Date.parse(b.resetTime) || (Number(b.resetTime) ? Number(b.resetTime) * 1000 : 0))
        : 0;
      out.push({
        kind: isSession ? 'session' : 'weekly_all',
        group: isSession ? 'session' : 'weekly',
        label: `${(g && g.displayName) || 'Models'} · ${isSession ? 'Session (5h)' : 'Weekly'}`,
        percent: Number.isFinite(frac) ? Math.round((1 - frac) * 100) : 0,
        resetsAt: reset,
      });
    }
  }
  return out;
}

// Effective view: a window whose stored reset time has passed is 100%
// available again — restarts and closed windows read correctly without a
// fresh poll (Orbit's trick).
// NOTE: per-window `fresh` = "reset boundary passed", unrelated to snapshot
// recency (that's get()'s staleMinutes).
function effective(limits, now = Date.now()) {
  return (limits || []).map((l) => {
    const fresh = l.resetsAt > 0 && l.resetsAt <= now;
    return { ...l, percent: fresh ? 0 : l.percent, fresh };
  });
}

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const AGY_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
const AGY_TOKEN_REL = path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token');

// Per-account usage snapshots for the pollable engines. One instance per
// process; accounts with usageSource 'reactive', implicit accounts, and
// engines this module doesn't know stay invisible (their quota knowledge is
// whatever the adapters parse out of limit errors).
function createQuotaService({
  pool,
  file,
  pollMinutes = Number(process.env.QUOTA_POLL_MINUTES) || 5,
  backoffBaseMs = Number(process.env.QUOTA_BACKOFF_BASE_MS) || 60_000,
  fetchImpl = globalThis.fetch,
  // Production: run `agy models` under the account HOME so the CLI refreshes
  // its own token file (no Google OAuth client secret in our code). Injected
  // for tests; wired in server.js.
  agyRefresh = null,
  claudeUserAgent = process.env.QUOTA_CLAUDE_UA || 'claude-code/2.1.206',
  logger = console,
  onChange = null,
} = {}) {
  const snapshots = new Map(); // 'engine:name' → { limits, takenAt, source, error }
  const reactive = new Set(); // accounts degraded at runtime (403 scope)
  const backoff = new Map(); // 'engine:name' → { until: epochMs, streak: n }
  const soonTimers = new Map();
  let interval = null;
  let persistTimer = null;
  let firstSweep = null;

  // ── persistence ─────────────────────────────────────────────────────────
  try {
    if (file && fs.existsSync(file)) {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) snapshots.set(k, v);
    }
  } catch (err) { logger.error(`[quota] snapshot file unreadable, starting empty: ${err.message}`); }

  const flushPersist = () => {
    if (!file) return;
    try {
      const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(snapshots)));
      fs.renameSync(tmp, file);
    } catch (err) { logger.error(`[quota] persist failed: ${err.message}`); }
  };

  const persist = () => {
    if (!file) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(flushPersist, 1000);
    persistTimer.unref();
  };

  const record = (engine, name, limits, source, error = null) => {
    const key = `${engine}:${name}`;
    const next = { limits, takenAt: Date.now(), source, ...(error ? { error } : {}) };
    const prev = snapshots.get(key);
    snapshots.set(key, next);
    persist();
    if (typeof onChange === 'function'
      && (!prev || JSON.stringify(prev.limits) !== JSON.stringify(limits) || prev.error !== next.error)) {
      onChange({ engine, account: name, limits: effective(limits), takenAt: next.takenAt, source, error });
    }
  };

  // ── per-engine pollers ──────────────────────────────────────────────────
  async function pollClaude(acct) {
    let token;
    try {
      token = JSON.parse(fs.readFileSync(path.join(acct.dir, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken;
    } catch (_) { return; } // no credential file yet — nothing to poll
    if (!token) return;
    const res = await fetchImpl(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': claudeUserAgent },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 403) {
      // Token lacks the usage scope (setup-token) — permanent for this process.
      reactive.add(`claude:${acct.name}`);
      const prev = snapshots.get(`claude:${acct.name}`);
      if (prev) record('claude', acct.name, prev.limits, 'reactive', 'scope');
      return;
    }
    if (res.status === 401) {
      // Access token stale; a real dispatch refreshes the file. Keep the last
      // snapshot, surface the state.
      const prev = snapshots.get(`claude:${acct.name}`);
      record('claude', acct.name, (prev && prev.limits) || [], 'oauth', 'auth-stale');
      return;
    }
    if (!res.ok) throw new Error(`usage endpoint ${res.status}`);
    record('claude', acct.name, parseClaudeUsage(await res.json()), 'oauth');
  }

  const readAgyToken = (dir) => JSON.parse(fs.readFileSync(path.join(dir, AGY_TOKEN_REL), 'utf8'));

  async function pollAgy(acct) {
    let tok;
    try { tok = readAgyToken(acct.dir); } catch (_) { return; } // no token file yet
    const expired = tok.token && tok.token.expiry && (Date.parse(tok.token.expiry) - Date.now() < 5 * 60 * 1000);
    if (expired && typeof agyRefresh === 'function') {
      try { await agyRefresh(acct); tok = readAgyToken(acct.dir); }
      catch (err) { logger.error(`[quota] gemini:${acct.name} token refresh failed: ${err.message}`); }
    }
    const access = tok.token && tok.token.access_token;
    if (!access) return;
    const res = await fetchImpl(AGY_QUOTA_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      const prev = snapshots.get(`gemini:${acct.name}`);
      record('gemini', acct.name, (prev && prev.limits) || [], 'oauth', 'auth-stale');
      return;
    }
    if (!res.ok) throw new Error(`quota summary ${res.status}`);
    record('gemini', acct.name, parseAgyQuotaSummary(await res.json()), 'oauth');
  }

  const POLLERS = { claude: pollClaude, gemini: pollAgy };

  const pollable = (engine, acct) => acct.enabled && !acct.needsLogin && acct.dir
    && acct.usageSource !== 'reactive' && !reactive.has(`${engine}:${acct.name}`);

  async function pollOne(engine, name) {
    const key = `${engine}:${name}`;
    const bo = backoff.get(key);
    if (bo && Date.now() < bo.until) return; // still backing off
    const acct = pool.accounts(engine).find((a) => a.name === name);
    if (!acct || !pollable(engine, acct) || !POLLERS[engine]) return;
    try {
      await POLLERS[engine](acct);
      backoff.delete(key); // success clears any backoff
    } catch (err) {
      const streak = ((bo && bo.streak) || 0) + 1;
      const wait = Math.min(backoffBaseMs * 2 ** (streak - 1), 30 * 60_000);
      backoff.set(key, { until: Date.now() + wait, streak });
      logger.error(`[quota] ${engine}:${name} poll failed (backoff ${Math.round(wait / 1000)}s): ${err.message}`);
    }
  }

  // ponytail: no overlap guard — a sweep that outlives the 5-min interval can
  // overlap the next one (idempotent records, bounded by per-call timeouts).
  // Add an in-flight flag if account count grows past ~10.
  async function pollAll() {
    for (const engine of Object.keys(POLLERS)) {
      let accounts = [];
      try { accounts = pool.accounts(engine); } catch (_) { continue; }
      for (const acct of accounts) {
        if (pollable(engine, acct)) await pollOne(engine, acct.name);
      }
    }
  }

  function pollSoon(engine, name) {
    const key = `${engine}:${name}`;
    if (soonTimers.has(key)) return;
    const t = setTimeout(() => { soonTimers.delete(key); pollOne(engine, name); }, 1000);
    t.unref();
    soonTimers.set(key, t);
  }

  function get(engine, name) {
    const snap = snapshots.get(`${engine}:${name}`);
    if (!snap) return null;
    return {
      limits: effective(snap.limits),
      takenAt: snap.takenAt,
      staleMinutes: Math.round((Date.now() - snap.takenAt) / 60_000),
      source: reactive.has(`${engine}:${name}`) ? 'reactive' : snap.source,
      error: snap.error || null,
    };
  }

  function start() {
    if (interval) return;
    firstSweep = setTimeout(() => { pollAll(); }, 5000);
    firstSweep.unref();
    interval = setInterval(pollAll, Math.max(1, pollMinutes) * 60_000);
    interval.unref();
  }

  function stop() {
    clearInterval(interval);
    interval = null;
    clearTimeout(firstSweep);
    firstSweep = null;
    clearTimeout(persistTimer);
    flushPersist();
    for (const t of soonTimers.values()) clearTimeout(t);
    soonTimers.clear();
    backoff.clear();
  }

  return { start, stop, pollAll, pollSoon, get };
}

module.exports = { parseClaudeUsage, parseAgyQuotaSummary, effective, createQuotaService };
