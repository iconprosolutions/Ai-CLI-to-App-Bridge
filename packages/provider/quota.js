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
    return raw.limits.map((l) => {
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
function effective(limits, now = Date.now()) {
  return (limits || []).map((l) => {
    const fresh = l.resetsAt > 0 && l.resetsAt <= now;
    return { ...l, percent: fresh ? 0 : l.percent, fresh };
  });
}

module.exports = { parseClaudeUsage, parseAgyQuotaSummary, effective };
