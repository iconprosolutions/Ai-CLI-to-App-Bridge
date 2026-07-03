'use strict';

const fs = require('fs');
const path = require('path');
const { createBreaker } = require('./breaker');
const { createSemaphore } = require('./semaphore');

const NAME_RE = /^[A-Za-z0-9._-]+$/;

// Validate a parsed accounts.json: { claude: [{name, dir, enabled?}], gemini: [...] }.
// Same philosophy as routes.json — throw precisely at boot, keep last good on reload.
function validateAccounts(data) {
  if (!data || typeof data !== 'object') throw new Error('accounts.json: root must be an object');
  for (const [engine, list] of Object.entries(data)) {
    if (!Array.isArray(list)) throw new Error(`accounts.json: "${engine}" must be an array`);
    const seen = new Set();
    for (const a of list) {
      if (!a || typeof a.name !== 'string' || !NAME_RE.test(a.name)) {
        throw new Error(`accounts.json: every ${engine} account needs a name matching ${NAME_RE}`);
      }
      if (seen.has(a.name)) throw new Error(`accounts.json: duplicate ${engine} account name "${a.name}"`);
      seen.add(a.name);
      if (typeof a.dir !== 'string' || !a.dir) throw new Error(`accounts.json: ${engine}/${a.name} needs a "dir"`);
    }
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
      implicit: Boolean(def.implicit),
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
          if (old) { old.enabled = def.enabled !== false; return old; } // keep breaker/needsLogin state
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

  function select(engine, { pin = null, exclude = null } = {}) {
    const eng = state[engine];
    if (!eng) return { ok: false, status: 400, message: `Unknown engine "${engine}"` };

    if (pin) {
      const acct = eng.accounts.find((a) => a.name === pin);
      if (!acct) return { ok: false, status: 400, message: `Unknown ${engine} account "${pin}"` };
      if (!acct.enabled) return { ok: false, status: 503, message: `Account "${engine}:${pin}" is disabled.` };
      if (acct.needsLogin) return { ok: false, status: 503, message: `Account "${engine}:${pin}" needs login. Run the account login step, then probe it from the dashboard.` };
      const gate = acct.breaker.allow();
      if (!gate.allowed) {
        return { ok: false, status: 429, message: `Account "${engine}:${pin}" circuit is open (${gate.reason || 'capacity'}).`, retryInSec: gate.retryInSec || 5 };
      }
      return { ok: true, account: acct, trial: Boolean(gate.trial) };
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
    account.breaker.recordFailure(err.kind);
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

module.exports = { createAccountPool, validateAccounts };
