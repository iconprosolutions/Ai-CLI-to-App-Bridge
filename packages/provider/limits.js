'use strict';

// Per-key usage limits — the SaaS boundary between users sharing one bridge.
// A key record may carry `limits: { rpm, tokensPerDay, usdPerMonth }`; this
// guard enforces them at request time and accounts usage as requests finish.
//
// State is in-memory (a sliding request window + day/month counters) and is
// seeded from the durable ledger at boot, so restarts don't reset budgets.
// Counters key off local calendar boundaries — the same `today`/`month`
// cutoffs the ledger's aggregate() uses.

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function monthKey(d = new Date()) {
  return dayKey(d).slice(0, 7);
}

function secondsToNextDay() {
  const d = new Date();
  const next = new Date(d);
  next.setHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next - d) / 1000));
}

function secondsToNextMonth() {
  const d = new Date();
  const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return Math.max(1, Math.ceil((next - d) / 1000));
}

function createLimitGuard() {
  // keyName → { window: [ts...], day: {key, tokens}, month: {key, usd} }
  const perKey = new Map();

  function row(name) {
    let r = perKey.get(name);
    if (!r) {
      r = { window: [], day: { key: dayKey(), tokens: 0 }, month: { key: monthKey(), usd: 0 } };
      perKey.set(name, r);
    }
    // Roll counters over calendar boundaries.
    const dk = dayKey();
    if (r.day.key !== dk) r.day = { key: dk, tokens: 0 };
    const mk = monthKey();
    if (r.month.key !== mk) r.month = { key: mk, usd: 0 };
    return r;
  }

  // Seed budgets from the ledger's rollups so a restart mid-day/mid-month
  // doesn't grant everyone a fresh allowance. Additive: live traffic that
  // raced the (async) seed is kept.
  function seed({ today, month } = {}) {
    for (const k of (today && today.perKey) || []) {
      if (!k.keyName || k.keyName === 'legacy') continue;
      row(k.keyName).day.tokens += (k.promptTokens || 0) + (k.completionTokens || 0);
    }
    for (const k of (month && month.perKey) || []) {
      if (!k.keyName || k.keyName === 'legacy') continue;
      row(k.keyName).month.usd += k.apiEquivalentUsd || 0;
    }
  }

  // Called before dispatch. Consumes one rpm slot on success so bursts are
  // counted at start time, not completion time.
  function check(name, limits) {
    if (!name || !limits) return { ok: true };
    const r = row(name);
    const now = Date.now();

    if (limits.rpm) {
      r.window = r.window.filter((t) => now - t < 60000);
      if (r.window.length >= limits.rpm) {
        const retryAfterSec = Math.max(1, Math.ceil((r.window[0] + 60000 - now) / 1000));
        return {
          ok: false,
          reason: 'rpm',
          retryAfterSec,
          message: `Rate limit exceeded for key "${name}": ${limits.rpm} requests/minute. Retry in ${retryAfterSec}s.`,
        };
      }
    }
    if (limits.tokensPerDay && r.day.tokens >= limits.tokensPerDay) {
      return {
        ok: false,
        reason: 'tokensPerDay',
        retryAfterSec: secondsToNextDay(),
        message: `Daily token budget exhausted for key "${name}": ${r.day.tokens.toLocaleString('en-US')} of ${limits.tokensPerDay.toLocaleString('en-US')} tokens used today. Resets at midnight.`,
      };
    }
    if (limits.usdPerMonth && r.month.usd >= limits.usdPerMonth) {
      return {
        ok: false,
        reason: 'usdPerMonth',
        retryAfterSec: secondsToNextMonth(),
        message: `Monthly spend budget exhausted for key "${name}": $${r.month.usd.toFixed(2)} of $${limits.usdPerMonth} (API-equivalent) used this month. Resets on the 1st.`,
      };
    }

    if (limits.rpm) r.window.push(now);
    return { ok: true };
  }

  // Called from the request-finish path with what the request actually used.
  function record(name, tokens, usd) {
    if (!name) return;
    const r = row(name);
    r.day.tokens += tokens || 0;
    r.month.usd += usd || 0;
  }

  // Dashboard: current consumption for a key (for the Connect tab display).
  function snapshot(name) {
    const r = perKey.get(name);
    if (!r) return { tokensToday: 0, usdThisMonth: 0 };
    const fresh = row(name); // applies rollover
    return { tokensToday: fresh.day.tokens, usdThisMonth: Math.round(fresh.month.usd * 100) / 100 };
  }

  return { check, record, seed, snapshot };
}

module.exports = { createLimitGuard };
