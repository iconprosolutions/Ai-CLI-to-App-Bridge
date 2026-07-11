'use strict';

const fs = require('fs');
const path = require('path');
const { createBreaker } = require('./breaker');
const { createSemaphore } = require('./semaphore');

const NAME_RE = /^[A-Za-z0-9._-]+$/;

// ── Headroom scoring (router Phase 2) ─────────────────────────────────────
// An account with no snapshot (or a stale one the caller filtered out) scores
// NEUTRAL — it neither hogs traffic nor gets starved before we know its state.
const NEUTRAL_SCORE = 50;

// A model-scoped weekly window ("Opus weekly") applies to a request only when
// its leading word (the model family) appears in the route's model string.
// weekly_all and session windows always apply.
function scopedApplies(limit, model) {
  if (!limit || limit.kind !== 'weekly_scoped') return true;
  const family = String(limit.label || '').split(/\s+/)[0].toLowerCase();
  return Boolean(family) && String(model || '').toLowerCase().includes(family);
}

// Bottleneck utilization (0-100+) for a request against one account: the
// most-consumed applicable WEEKLY window dominates; the busiest session window
// contributes a sub-integer tiebreak so among equal-weekly accounts the one
// with more session headroom is preferred. null/empty → NEUTRAL_SCORE.
function headroomScore(limits, model) {
  if (!limits || !limits.length) return NEUTRAL_SCORE;
  const weekly = limits.filter((l) => l.group === 'weekly' && scopedApplies(l, model)).map((l) => Number(l.percent) || 0);
  const session = limits.filter((l) => l.group === 'session').map((l) => Number(l.percent) || 0);
  const w = weekly.length ? Math.max(...weekly) : 0;
  const s = session.length ? Math.max(...session) : 0;
  return w + s / 1000;
}

// An account is "drained" for a request when a window it depends on is at/near
// its limit: session ≥ sessionMax OR any applicable weekly ≥ weeklyMax. Drained
// accounts are skipped unless ALL eligible accounts are drained. Unknown → not
// drained (we don't strand capacity we can't measure).
function isDrained(limits, model, { sessionMax = 90, weeklyMax = 95 } = {}) {
  if (!limits || !limits.length) return false;
  const weekly = limits.filter((l) => l.group === 'weekly' && scopedApplies(l, model));
  const session = limits.filter((l) => l.group === 'session');
  return session.some((l) => (Number(l.percent) || 0) >= sessionMax)
    || weekly.some((l) => (Number(l.percent) || 0) >= weeklyMax);
}

// Validate a parsed accounts.json: { claude: [{name, dir, enabled?, primary?}], gemini: [...] }.
// Same philosophy as routes.json — throw precisely at boot, keep last good on reload.
function validateAccounts(data) {
  if (!data || typeof data !== 'object') throw new Error('accounts.json: root must be an object');
  for (const [engine, list] of Object.entries(data)) {
    if (!Array.isArray(list)) throw new Error(`accounts.json: "${engine}" must be an array`);
    const seen = new Set();
    let primaries = 0;
    for (const a of list) {
      if (!a || typeof a.name !== 'string' || !NAME_RE.test(a.name)) {
        throw new Error(`accounts.json: every ${engine} account needs a name matching ${NAME_RE}`);
      }
      if (seen.has(a.name)) throw new Error(`accounts.json: duplicate ${engine} account name "${a.name}"`);
      seen.add(a.name);
      if (typeof a.dir !== 'string' || !a.dir) throw new Error(`accounts.json: ${engine}/${a.name} needs a "dir"`);
      if (a.usageSource !== undefined && !['oauth', 'reactive'].includes(a.usageSource)) {
        throw new Error(`accounts.json: ${engine}/${a.name} "usageSource" must be "oauth" or "reactive"`);
      }
      if (a.primary === true) primaries += 1;
    }
    if (primaries > 1) throw new Error(`accounts.json: "${engine}" has ${primaries} primary accounts — mark at most one`);
  }
  return data;
}

// Live multi-account pool: per-account breaker + semaphore, round-robin
// selection, needs-login exclusion, hot reload preserving state by name.
// No accounts.json (or an engine absent from it) → one implicit "default"
// account that leaves the CLI environment untouched — the zero-config path.
function createAccountPool({
  file,
  baseDir,
  engines,
  watch = true,
  logger = console,
  breakerOpts = {},
  semaphoreOpts = {},
  onChange = null,
} = {}) {
  const state = {}; // engine → { accounts: [], cursor: 0 }

  const emit = (event) => { if (typeof onChange === 'function') onChange(event); };

  const makeAccount = (engine, def) => {
    const acct = {
      engine,
      name: def.name,
      dir: def.dir ? path.resolve(baseDir, def.dir) : null,
      enabled: def.enabled !== false,
      primary: def.primary === true,
      implicit: Boolean(def.implicit),
      // 'oauth' → the quota service polls this account's provider usage
      // endpoint; 'reactive' → never poll (setup-token / shared credentials),
      // quota knowledge comes only from parsed limit errors.
      usageSource: def.usageSource || 'oauth',
      needsLogin: false,
      breaker: createBreaker({
        engine: `${engine}:${def.name}`,
        ...breakerOpts,
        onChange: (s) => emit({ kind: 'breaker', engine, account: def.name, breaker: s }),
      }),
      semaphore: createSemaphore(semaphoreOpts),
    };
    if (acct.dir) { try { fs.mkdirSync(acct.dir, { recursive: true }); } catch (_) { /* surfaces at spawn */ } }
    return acct;
  };

  const build = (data) => {
    for (const engine of engines) {
      const defs = (data && Array.isArray(data[engine]) && data[engine].length > 0)
        ? data[engine]
        : [{ name: 'default', dir: null, implicit: true }];
      const prev = state[engine] ? state[engine].accounts : [];
      state[engine] = {
        cursor: state[engine] ? state[engine].cursor : 0,
        accounts: defs.map((def) => {
          const old = prev.find((p) => p.name === def.name && p.dir === (def.dir ? path.resolve(baseDir, def.dir) : null));
          if (old) { old.enabled = def.enabled !== false; old.primary = def.primary === true; old.usageSource = def.usageSource || 'oauth'; return old; } // keep breaker/needsLogin state
          return makeAccount(engine, def);
        }),
      };
    }
  };

  const load = () => {
    if (!fs.existsSync(file)) { build(null); return; }
    build(validateAccounts(JSON.parse(fs.readFileSync(file, 'utf8'))));
  };
  load();

  if (watch && fs.existsSync(file)) {
    let timer = null;
    try {
      fs.watch(file, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          try { load(); logger.log(`[accounts] reloaded from ${file}`); emit({ kind: 'reload' }); }
          catch (err) { logger.error(`[accounts] reload rejected, keeping previous config: ${err.message}`); }
        }, 300);
        timer.unref();
      });
    } catch (_) { /* best-effort, as with routes.json */ }
  }

  const eligible = (a) => a.enabled && !a.needsLogin;
  const maxSlots = semaphoreOpts.max || 1;

  // pinMode 'hard' (default): a pinned request fails loud if its account can't
  // take it. pinMode 'soft': the pin is a *preference* — an app's assigned
  // account — and an unusable assignment falls back to the rest of the pool.
  function select(engine, { pin = null, pinMode = 'hard', exclude = null } = {}) {
    const eng = state[engine];
    if (!eng) return { ok: false, status: 400, message: `Unknown engine "${engine}"` };

    if (pin) {
      const acct = eng.accounts.find((a) => a.name === pin);
      if (pinMode === 'soft') {
        if (acct && eligible(acct)) {
          const gate = acct.breaker.allow();
          if (gate.allowed) return { ok: true, account: acct, trial: Boolean(gate.trial) };
        }
        // Assigned account unusable → the pool absorbs it (skip the failed pin).
        return select(engine, { exclude: pin });
      }
      if (!acct) return { ok: false, status: 400, message: `Unknown ${engine} account "${pin}"` };
      if (!acct.enabled) return { ok: false, status: 503, message: `Account "${engine}:${pin}" is disabled.` };
      if (acct.needsLogin) return { ok: false, status: 503, message: `Account "${engine}:${pin}" needs login. Run the account login step, then probe it from the dashboard.` };
      const gate = acct.breaker.allow();
      if (!gate.allowed) {
        return { ok: false, status: 429, message: `Account "${engine}:${pin}" circuit is open (${gate.reason || 'capacity'}).`, retryInSec: gate.retryInSec || 5 };
      }
      return { ok: true, account: acct, trial: Boolean(gate.trial) };
    }

    // Primary preference: the designated main account takes traffic while it
    // is healthy AND has a free CLI slot; overflow and outages spill to the
    // rest of the pool (rotation below naturally skips a broken primary).
    const primary = eng.accounts.find((a) => a.primary && eligible(a) && a.name !== exclude);
    if (primary && primary.semaphore.active < maxSlots) {
      const gate = primary.breaker.allow();
      if (gate.allowed) return { ok: true, account: primary, trial: Boolean(gate.trial) };
    }

    const n = eng.accounts.length;
    let soonest = null;
    for (let i = 0; i < n; i += 1) {
      const acct = eng.accounts[(eng.cursor + i) % n];
      if (!eligible(acct) || acct.name === exclude) continue;
      const gate = acct.breaker.allow();
      if (gate.allowed) {
        eng.cursor = (eng.cursor + i + 1) % n;
        return { ok: true, account: acct, trial: Boolean(gate.trial) };
      }
      if (gate.retryInSec && (soonest === null || gate.retryInSec < soonest)) soonest = gate.retryInSec;
    }
    if (soonest !== null) {
      return { ok: false, status: 429, message: `All ${engine} accounts are cooling down — circuit is open. Retry in ~${soonest}s.`, retryInSec: soonest };
    }
    return { ok: false, status: 503, message: `No usable ${engine} account (all disabled or logged out).` };
  }

  // Credential redirection per engine (verified live 2026-07-02): claude
  // reads CLAUDE_CONFIG_DIR; agy keeps all state under $HOME/.antigravity.
  function envFor(engine, account) {
    if (!account || !account.dir) return null;
    return engine === 'claude' ? { CLAUDE_CONFIG_DIR: account.dir } : { HOME: account.dir };
  }

  function feedback(engine, account, err) {
    if (!account) return;
    if (!err) {
      account.needsLogin = false;
      account.breaker.recordSuccess();
      return;
    }
    if (err.kind === 'aborted') return; // says nothing about the account
    if (err.kind === 'auth') {
      if (!account.needsLogin) {
        account.needsLogin = true;
        emit({ kind: 'needs-login', engine, account: account.name });
      }
      return;
    }
    account.breaker.recordFailure(err.kind, {
      until: err.data && Number.isFinite(err.data.cooldownUntilMs) ? err.data.cooldownUntilMs : undefined,
    });
  }

  function clearNeedsLogin(engine, name) {
    const acct = state[engine] && state[engine].accounts.find((a) => a.name === name);
    if (acct) acct.needsLogin = false;
    return acct || null;
  }

  function resetBreakers(engine) {
    for (const a of (state[engine] ? state[engine].accounts : [])) a.breaker.reset();
  }

  // Runtime enable/disable, mirroring engine-level disable. In-memory: an
  // accounts.json reload reasserts the file's `enabled` value (file is truth).
  function setEnabled(engine, name, enabled) {
    const acct = state[engine] && state[engine].accounts.find((a) => a.name === name);
    if (!acct) return null;
    acct.enabled = Boolean(enabled);
    emit({ kind: 'enabled', engine, account: name, enabled: acct.enabled });
    return acct;
  }

  // Engine-level aggregate kept for the existing dashboard/status contract:
  // closed while any account can take traffic; open (min retry) when none can.
  function engineBreakerStatus(engine) {
    const accounts = state[engine] ? state[engine].accounts : [];
    const usable = accounts.filter(eligible);
    const statuses = usable.map((a) => a.breaker.status());
    if (statuses.some((s) => s.state !== 'open')) {
      return { engine, state: 'closed', reason: null, openedAt: null, retryInSec: 0 };
    }
    const min = statuses.reduce((m, s) => (m === null || s.retryInSec < m.retryInSec ? s : m), null);
    return min ? { ...min, engine } : { engine, state: 'open', reason: 'auth', openedAt: null, retryInSec: 0 };
  }

  const sums = (engine, prop) => (state[engine] ? state[engine].accounts : []).reduce((t, a) => t + a.semaphore[prop], 0);

  function snapshot() {
    const out = {};
    for (const engine of engines) {
      out[engine] = state[engine].accounts.map((a) => ({
        engine,
        name: a.name,
        dir: a.dir,
        implicit: a.implicit,
        enabled: a.enabled,
        primary: a.primary === true,
        usageSource: a.usageSource,
        needsLogin: a.needsLogin,
        breaker: a.breaker.status(),
        inflight: a.semaphore.active,
        queued: a.semaphore.queued,
      }));
    }
    return out;
  }

  return {
    select, envFor, feedback, clearNeedsLogin, resetBreakers, setEnabled, engineBreakerStatus, snapshot,
    inflight: (engine) => sums(engine, 'active'),
    queued: (engine) => sums(engine, 'queued'),
    accounts: (engine) => (state[engine] ? state[engine].accounts.slice() : []),
    reload: () => { load(); },
    file,
  };
}

module.exports = { createAccountPool, validateAccounts, headroomScore, isDrained, scopedApplies, NEUTRAL_SCORE };
