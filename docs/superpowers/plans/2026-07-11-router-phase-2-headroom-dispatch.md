# Router Phase 2 — Headroom-Aware Dispatch + Orbit Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make unpinned account selection pick the account with the most remaining subscription headroom (draining near-exhausted windows last) instead of blind round-robin; let real poll data correct breaker deadlines that were parsed wrong; back off pollers per-account on failure; import the operator's Orbit-vaulted Claude accounts into the pool; and show a fleet headroom summary on the dashboard Overview.

**Architecture:** Phase 1 collected per-account quota snapshots (`quota.js`) but selection ignored them. Phase 2 adds pure scoring helpers to `accounts.js` and rewrites ONLY the unpinned branch of `pool.select()` to order candidates by a bottleneck-utilization score — gated behind an injected `headroom(engine, name)` function so the pool stays decoupled from the quota service and every existing test (which passes no headroom fn) keeps its round-robin behavior unchanged. `server.js` supplies that function from `quota.get`, and wires a `quota.change`→breaker-correction hook. A standalone Mac-operator script imports Orbit's credential vault.

**Tech Stack:** Node 22 CommonJS, no new deps (the import script shells to the `sqlite3` and `security` CLIs already on macOS), plain-assert suites run via `node tests/<file>.test.js`.

**Conventions:** work from repo root `/Users/waqar/Projects/experiments/ai-cli-bridge`, branch `feat/dashboard-overhaul`, commit directly (no new branches). New selection/scoring tests go in **`tests/headroom.test.js`** (created in Task 1, extended by Tasks 2). Commit after every green task. Phase 1 is committed through `3169562`; the quota service, `usageSource`, reset-precise breakers, and dashboard bars all exist.

---

### Task 1: accounts.js — pure headroom scoring helpers

Extract the scoring math as pure, exported functions before touching `select()`. This is the testable core; Task 2 wires it in.

**Files:**
- Modify: `packages/provider/accounts.js`
- Create: `tests/headroom.test.js`
- Modify: `package.json` (add the new suite to `test` and `check` chains)

- [ ] **Step 1: Create the failing test suite**

Create `tests/headroom.test.js`:

```js
'use strict';
// Router Phase 2: headroom scoring + headroom-aware account selection.
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO = path.resolve(__dirname, '..');
let passed = 0;
function ok(cond, msg) { assert(cond, msg); passed += 1; console.log(`  ok - ${msg}`); }

(async () => {
  console.log('## H1 — headroom scoring helpers');
  {
    const { headroomScore, isDrained, scopedApplies, NEUTRAL_SCORE } =
      require(path.join(REPO, 'packages/provider/accounts.js'));

    // Unknown / empty limits → neutral (neither hog nor starve).
    ok(headroomScore(null, 'claude-sonnet-4-6') === NEUTRAL_SCORE, 'H1: null limits → neutral score');
    ok(headroomScore([], 'claude-sonnet-4-6') === NEUTRAL_SCORE, 'H1: empty limits → neutral score');

    // Bottleneck = worst applicable weekly; session is a fractional tiebreak.
    const lo = headroomScore([
      { group: 'session', kind: 'session', label: 'Session (5h)', percent: 80 },
      { group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 20 },
    ], 'claude-sonnet-4-6');
    const hi = headroomScore([
      { group: 'session', kind: 'session', label: 'Session (5h)', percent: 10 },
      { group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 60 },
    ], 'claude-sonnet-4-6');
    ok(lo < hi, 'H1: weekly dominates the score (20%-weekly beats 60%-weekly despite higher session)');

    // Session tiebreak: equal weekly, busier session sorts higher (worse).
    const a = headroomScore([{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 40 }, { group: 'session', kind: 'session', label: 'Session (5h)', percent: 10 }], 'm');
    const b = headroomScore([{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 40 }, { group: 'session', kind: 'session', label: 'Session (5h)', percent: 90 }], 'm');
    ok(a < b && Math.floor(a) === Math.floor(b), 'H1: session is a sub-integer tiebreak on equal weekly');

    // scopedApplies: a model-scoped weekly counts only for its model family.
    const opusWk = { group: 'weekly', kind: 'weekly_scoped', label: 'Opus weekly', percent: 99 };
    ok(scopedApplies(opusWk, 'claude-opus-4-5') === true, 'H1: Opus-scoped window applies to an opus model');
    ok(scopedApplies(opusWk, 'claude-sonnet-4-6') === false, 'H1: Opus-scoped window ignored for a sonnet model');
    ok(scopedApplies({ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 5 }, 'anything') === true, 'H1: weekly_all always applies');

    // A 99% Opus window makes an opus request score high, a sonnet request low.
    const withOpus = [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 10 }, opusWk];
    ok(headroomScore(withOpus, 'claude-opus-4-5') > 90, 'H1: opus request sees the exhausted Opus window');
    ok(headroomScore(withOpus, 'claude-sonnet-4-6') < 20, 'H1: sonnet request ignores the Opus window');

    // isDrained: session ≥90 OR any applicable weekly ≥95; unknown never drained.
    ok(isDrained(null, 'm') === false, 'H1: unknown limits never drained');
    ok(isDrained([{ group: 'session', kind: 'session', label: 's', percent: 92 }], 'm') === true, 'H1: session ≥90 → drained');
    ok(isDrained([{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 96 }], 'm') === true, 'H1: weekly ≥95 → drained');
    ok(isDrained([{ group: 'weekly', kind: 'weekly_scoped', label: 'Opus weekly', percent: 99 }], 'claude-sonnet-4-6') === false, 'H1: an exhausted Opus window does NOT drain a sonnet request');
    ok(isDrained([{ group: 'session', kind: 'session', label: 's', percent: 50 }, { group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 50 }], 'm') === false, 'H1: mid-usage not drained');
  }

  console.log(`\nheadroom.test.js: all ${passed} assertions passed`);
})().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/headroom.test.js`
Expected: FAIL — `headroomScore` is not a function (not exported yet).

- [ ] **Step 3: Add the helpers to `packages/provider/accounts.js`**

Read the file first. Add these near the top, after the `NAME_RE` const (~line 8):

```js
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
```

Extend the exports at the bottom of the file — change:

```js
module.exports = { createAccountPool, validateAccounts };
```

to:

```js
module.exports = { createAccountPool, validateAccounts, headroomScore, isDrained, scopedApplies, NEUTRAL_SCORE };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/headroom.test.js`
Expected: PASS — all H1 assertions.

- [ ] **Step 5: Add the suite to both chains**

In `package.json`: append `&& node tests/headroom.test.js` to the `test` script (after `quota.test.js`), and add `node --check tests/headroom.test.js` to the `check` script alongside the other `--check` entries.

- [ ] **Step 6: Full suite + commit**

Run: `npm test` → all suites green (adds headroom.test.js).

```bash
git add packages/provider/accounts.js tests/headroom.test.js package.json
git commit -m "feat(accounts): pure headroom scoring helpers (bottleneck utilization, drain threshold, model-scoped weekly)"
```

---

### Task 2: accounts.js — headroom-aware `select()`

Rewrite ONLY the unpinned branch. Pins (hard/soft), the auth/needs-login/disabled paths, breaker gating, `exclude`, and the round-robin cursor are all preserved. When no `headroom` function is passed, behavior is byte-for-byte the old round-robin (this is what keeps every existing test green).

**Files:**
- Modify: `packages/provider/accounts.js`
- Test: `tests/headroom.test.js` (append H2 block)

- [ ] **Step 1: Append the failing H2 block**

Insert before the final summary line in `tests/headroom.test.js`:

```js
  console.log('\n## H2 — headroom-aware select()');
  {
    const { createAccountPool } = require(path.join(REPO, 'packages/provider/accounts.js'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h2-'));
    const mk = (names) => {
      const file = path.join(tmp, `${names.join('-')}.json`);
      fs.writeFileSync(file, JSON.stringify({ claude: names.map((n) => ({ name: n, dir: n })) }));
      return createAccountPool({ file, baseDir: tmp, engines: ['claude'], watch: false });
    };

    // Headroom map keyed by account name → effective limits array (or null).
    const scen = {
      a: [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 80 }],
      b: [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 10 }],
      c: [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 40 }],
    };
    const headroom = (engine, name) => scen[name] || null;

    // Least-utilized account wins regardless of round-robin order.
    const p1 = mk(['a', 'b', 'c']);
    const s1 = p1.select('claude', { model: 'claude-sonnet-4-6', headroom });
    ok(s1.ok && s1.account.name === 'b', `H2: lowest-utilization account chosen (got ${s1.account && s1.account.name})`);

    // With NO headroom fn, selection is the old round-robin (first eligible).
    const p2 = mk(['a', 'b', 'c']);
    const s2 = p2.select('claude', {});
    ok(s2.ok && s2.account.name === 'a', 'H2: no headroom fn → round-robin (unchanged legacy behavior)');

    // Drain threshold: a 96%-weekly account is skipped while others have room.
    const drainScen = {
      a: [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 96 }],
      b: [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 70 }],
    };
    const p3 = mk(['a', 'b']);
    const s3 = p3.select('claude', { model: 'm', headroom: (e, n) => drainScen[n] || null });
    ok(s3.ok && s3.account.name === 'b', 'H2: drained account (96%) skipped for a non-drained one');

    // All drained → least-utilized still serves (never refuse existing capacity).
    const allDrain = {
      a: [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 99 }],
      b: [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 96 }],
    };
    const p4 = mk(['a', 'b']);
    const s4 = p4.select('claude', { model: 'm', headroom: (e, n) => allDrain[n] || null });
    ok(s4.ok && s4.account.name === 'b', 'H2: all drained → least-utilized (96%) still serves');

    // Unknown (null) accounts score neutral 50: chosen over a 60% account,
    // skipped in favor of a 20% account.
    const mixScen = { a: null, b: [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 60 }] };
    const p5 = mk(['a', 'b']);
    const s5 = p5.select('claude', { model: 'm', headroom: (e, n) => mixScen[n] });
    ok(s5.ok && s5.account.name === 'a', 'H2: unknown (neutral 50) beats a known 60%-used account');

    // A drained primary spills to the pool; a healthy primary is preferred.
    const prFile = path.join(tmp, 'primary.json');
    fs.writeFileSync(prFile, JSON.stringify({ claude: [{ name: 'main', dir: 'main', primary: true }, { name: 'alt', dir: 'alt' }] }));
    const p6 = createAccountPool({ file: prFile, baseDir: tmp, engines: ['claude'], watch: false });
    const drainedPrimary = { main: [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 97 }], alt: [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 30 }] };
    const s6 = p6.select('claude', { model: 'm', headroom: (e, n) => drainedPrimary[n] || null });
    ok(s6.ok && s6.account.name === 'alt', 'H2: a drained primary spills to the pool');
    const healthyPrimary = { main: [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 20 }], alt: [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 10 }] };
    const s6b = p6.select('claude', { model: 'm', headroom: (e, n) => healthyPrimary[n] || null });
    ok(s6b.ok && s6b.account.name === 'main', 'H2: a healthy primary is still preferred even if not the lowest-scored');
  }
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/headroom.test.js`
Expected: FAIL at H2 (`select` ignores headroom — picks round-robin `a`).

- [ ] **Step 3: Rewrite the unpinned branch of `select()`**

In `packages/provider/accounts.js`, the `select` function signature and its unpinned tail change. Change the signature line from:

```js
  function select(engine, { pin = null, pinMode = 'hard', exclude = null } = {}) {
```

to:

```js
  function select(engine, { pin = null, pinMode = 'hard', exclude = null, model = null, headroom = null, drainThresholds } = {}) {
```

Leave everything from `const eng = state[engine];` through the end of the `if (pin) { ... }` block EXACTLY as is. Then replace everything from the `// Primary preference:` comment to the end of the function (the primary block + the round-robin `for` loop + the two trailing returns) with:

```js
    // ── Unpinned selection ────────────────────────────────────────────────
    const eligibleAccts = eng.accounts.filter((a) => eligible(a) && a.name !== exclude);
    if (!eligibleAccts.length) {
      return { ok: false, status: 503, message: `No usable ${engine} account (all disabled or logged out).` };
    }

    // Primary preference: still first choice while healthy, NOT drained, and
    // with a free CLI slot; a drained or full primary spills to the pool.
    const primary = eligibleAccts.find((a) => a.primary);
    if (primary && primary.semaphore.active < maxSlots
      && !(headroom && isDrained(headroom(engine, primary.name), model, drainThresholds))) {
      const gate = primary.breaker.allow();
      if (gate.allowed) return { ok: true, account: primary, trial: Boolean(gate.trial) };
    }

    // Order candidates. With a headroom fn (Phase 2): non-drained first, then
    // ascending bottleneck score, then round-robin distance as the tiebreak —
    // unless EVERY eligible account is drained, in which case drain rank is
    // dropped so the least-utilized still serves (never refuse real capacity).
    // Without a headroom fn: the original cursor-relative round-robin order.
    let ordered;
    if (headroom) {
      const scored = eligibleAccts.map((a) => ({
        a,
        drained: isDrained(headroom(engine, a.name), model, drainThresholds),
        score: headroomScore(headroom(engine, a.name), model),
        dist: (eng.accounts.indexOf(a) - eng.cursor + eng.accounts.length) % eng.accounts.length,
      }));
      const allDrained = scored.every((x) => x.drained);
      scored.sort((x, y) =>
        (allDrained ? 0 : ((x.drained ? 1 : 0) - (y.drained ? 1 : 0)))
        || (x.score - y.score)
        || (x.dist - y.dist));
      ordered = scored.map((x) => x.a);
    } else {
      const n = eng.accounts.length;
      ordered = [];
      for (let i = 0; i < n; i += 1) {
        const acct = eng.accounts[(eng.cursor + i) % n];
        if (eligible(acct) && acct.name !== exclude) ordered.push(acct);
      }
    }

    // Gate the chosen order on breakers; first account whose circuit admits
    // wins and advances the cursor. Track the soonest reopen for the 429 hint.
    let soonest = null;
    for (const acct of ordered) {
      const gate = acct.breaker.allow();
      if (gate.allowed) {
        eng.cursor = (eng.accounts.indexOf(acct) + 1) % eng.accounts.length;
        return { ok: true, account: acct, trial: Boolean(gate.trial) };
      }
      if (gate.retryInSec && (soonest === null || gate.retryInSec < soonest)) soonest = gate.retryInSec;
    }
    if (soonest !== null) {
      return { ok: false, status: 429, message: `All ${engine} accounts are cooling down — circuit is open. Retry in ~${soonest}s.`, retryInSec: soonest };
    }
    return { ok: false, status: 503, message: `No usable ${engine} account (all disabled or logged out).` };
```

- [ ] **Step 4: Run headroom + the full pool suite**

Run: `node tests/headroom.test.js`
Expected: PASS through H2.

Run: `node tests/provider2.test.js`
Expected: PASS — the existing pool/select tests (P27 primary/soft-pin etc.) pass no `headroom`, so they exercise the round-robin branch and stay green.

- [ ] **Step 5: Full suite + commit**

Run: `npm test` → all green.

```bash
git add packages/provider/accounts.js tests/headroom.test.js
git commit -m "feat(accounts): headroom-aware unpinned selection (drain threshold, primary spill; round-robin fallback when no snapshots)"
```

---

### Task 3: server.js — wire headroom into dispatch + poll→breaker correction

Supply `quota.get` as the headroom source at all three `select()` call sites, filtering out stale snapshots; and add the `quota.change`→breaker-correction hook (must-remember #1/#2: a poll showing recovered headroom clears a quota breaker whose parsed deadline was wrong, e.g. TZ-naive error text on a UTC host).

**Files:**
- Modify: `packages/provider/accounts.js` (add `refreshQuotaBreaker`)
- Modify: `packages/provider/server.js` (headroom fn + 3 select sites + quota.change hook)
- Test: `tests/headroom.test.js` (append H3 block for `refreshQuotaBreaker`); `tests/provider2.test.js` (headroom routing assertion)

- [ ] **Step 1: Append H3 (refreshQuotaBreaker) to headroom.test.js**

```js
  console.log('\n## H3 — refreshQuotaBreaker (poll corrects a wrong deadline)');
  {
    const { createAccountPool, headroomScore } = require(path.join(REPO, 'packages/provider/accounts.js'));
    const { BridgeError } = require(path.join(REPO, 'packages/core/errors.js'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h3-'));
    const file = path.join(tmp, 'a.json');
    fs.writeFileSync(file, JSON.stringify({ claude: [{ name: 'x', dir: 'x' }] }));
    const pool = createAccountPool({ file, baseDir: tmp, engines: ['claude'], watch: false });
    const sel = pool.select('claude', {});
    // Trip a quota breaker with an 8-hour deadline (simulating a wrong parse).
    pool.feedback('claude', sel.account, new BridgeError('quota', 'limit', { cooldownUntilMs: Date.now() + 8 * 3600 * 1000 }));
    ok(pool.select('claude', {}).ok === false, 'H3: account is cooling after the quota trip');

    // A fresh poll shows the account is NOT drained → the quota breaker clears.
    const changed = pool.refreshQuotaBreaker('claude', 'x', [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 5, fresh: true }]);
    ok(changed === true, 'H3: refreshQuotaBreaker returns true when it cleared a quota breaker');
    ok(pool.select('claude', {}).ok === true, 'H3: account is usable again after the correction');

    // It must NOT clear a still-drained account, nor a non-quota breaker.
    const sel2 = pool.select('claude', {});
    pool.feedback('claude', sel2.account, new BridgeError('quota', 'limit', { cooldownUntilMs: Date.now() + 3600 * 1000 }));
    const noClear = pool.refreshQuotaBreaker('claude', 'x', [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 98 }]);
    ok(noClear === false && pool.select('claude', {}).ok === false, 'H3: a still-drained account is NOT cleared');
  }
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/headroom.test.js`
Expected: FAIL — `pool.refreshQuotaBreaker` is not a function.

- [ ] **Step 3: Add `refreshQuotaBreaker` to `packages/provider/accounts.js`**

Add this function inside `createAccountPool` next to `resetBreakers` (~line 195):

```js
  // Phase 2 poll→breaker correction: when a fresh usage snapshot shows an
  // account is no longer near ANY limit, clear a breaker that was opened for
  // quota — the parsed reset deadline may have been wrong (e.g. a timezone-
  // naive error string on a UTC host) and the real numbers say it has capacity
  // now. CONSERVATIVE by design: unlike selection's model-scoped isDrained,
  // this counts every window (session + all weekly, scoped or not) so we never
  // reopen an account while any bucket is still hot. Returns true only when it
  // actually cleared something.
  function refreshQuotaBreaker(engine, name, limits) {
    const acct = state[engine] && state[engine].accounts.find((a) => a.name === name);
    if (!acct) return false;
    const st = acct.breaker.status();
    if (st.state === 'closed' || st.reason !== 'quota') return false;
    if (!limits || !limits.length) return false; // no data → trust the deadline
    const hot = limits.some((l) => {
      const p = Number(l.percent) || 0;
      return l.group === 'session' ? p >= 90 : p >= 95;
    });
    if (hot) return false;
    acct.breaker.reset();
    return true;
  }
```

Add `refreshQuotaBreaker` to the returned object (the `return { select, envFor, ... }` block ~line 243):

```js
    select, envFor, feedback, clearNeedsLogin, resetBreakers, refreshQuotaBreaker, setEnabled, engineBreakerStatus, snapshot,
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/headroom.test.js`
Expected: PASS through H3.

- [ ] **Step 5: Wire the headroom fn + select sites in `server.js`**

Read `server.js` around the quota-service block (~line 204-216) and the dispatch region (~line 900-1035). Three edits:

(a) After the `quota` service is created (~line 216, after `if (QUOTA_POLL) quota.start();`), add the headroom source:

```js
// Headroom source for account selection (router spec §6): the account's
// effective quota windows, or null when there's no snapshot or it's too stale
// to trust (older than 3 poll intervals) — a null makes the scorer treat the
// account as neutral rather than falsely healthy.
const QUOTA_POLL_MINUTES = Number(process.env.QUOTA_POLL_MINUTES) || 5;
const HEADROOM_STALE_MIN = QUOTA_POLL_MINUTES * 3;
const headroomFor = (engine, name) => {
  const q = quota.get(engine, name);
  if (!q || q.staleMinutes > HEADROOM_STALE_MIN) return null;
  return q.limits;
};
```

(b) Extend the quota `onChange` (currently `onChange: (ev) => events.emit('quota.change', ev)`, ~line 214) to correct breakers:

```js
  onChange: (ev) => {
    events.emit('quota.change', ev);
    // A fresh poll can retire a quota breaker whose parsed deadline was wrong.
    if (ev.limits) pool.refreshQuotaBreaker(ev.engine, ev.account, ev.limits);
  },
```

(c) Pass `model` + `headroom` at all three `pool.select` call sites in the dispatch path. The primary site (~line 913):

```js
  let sel = pool.select(route.engine, { pin, pinMode, model: route.model, headroom: headroomFor });
```

The cross-engine fallback site (~line 923):

```js
      const alt = pool.select(fb.engine, { model: fb.model, headroom: headroomFor });
```

The mid-dispatch failover site (~line 1028, `pool.select(route.engine, { exclude: sel.account.name })`):

```js
          const next = pool.select(route.engine, { exclude: sel.account.name, model: route.model, headroom: headroomFor });
```

(Search for any other `pool.select(` occurrences in server.js and give each the same `model` + `headroom` treatment; there should be exactly these three in the dispatch path.)

- [ ] **Step 6: Add a headroom routing assertion to provider2**

The existing provider2 fake CLIs don't feed quota snapshots, so live headroom routing can't be exercised there; instead assert the wiring doesn't break dispatch and that selection still succeeds. Find a passing `/v1/chat/completions` test that routes to claude with 2 accounts (search for a multi-account boot). If one exists, add after its success assertion:

```js
  assert(r.status === 200, 'headroom wiring: multi-account claude dispatch still succeeds with no snapshots (neutral scoring)');
```

If no 2-account claude dispatch test exists, SKIP this step (the headroom.test.js H2/H3 coverage plus the unchanged provider2 suite passing is sufficient) — note the skip in your report.

- [ ] **Step 7: Full suite + commit**

Run: `node tests/headroom.test.js && node tests/provider2.test.js && npm test`
Expected: all green.

```bash
git add packages/provider/accounts.js packages/provider/server.js tests/headroom.test.js tests/provider2.test.js
git commit -m "feat(server): headroom-aware dispatch wired + quota.change corrects wrong breaker deadlines"
```

---

### Task 4: quota.js — per-account poll backoff

Must-remember #4: with the Orbit import about to multiply account count, a poller hammering a failing provider endpoint every 5 min across N accounts is wasteful. Add per-account exponential backoff on poll failure (network error, 429, or thrown non-ok), honored by `pollable`.

**Files:**
- Modify: `packages/provider/quota.js`
- Test: `tests/quota.test.js` (append Q7 block)

- [ ] **Step 1: Append the failing Q7 block to `tests/quota.test.js`**

Insert before the final summary line:

```js
  console.log('\n## Q7 — quota service: per-account poll backoff');
  {
    const { createQuotaService } = require(path.join(REPO, 'packages/provider/quota.js'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q7-'));
    const dir = path.join(tmp, 'c'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 't' } }));
    const pool = { accounts: (e) => e === 'claude' ? [{ engine: 'claude', name: 'c', dir, enabled: true, needsLogin: false, usageSource: 'oauth' }] : [] };

    let calls = 0;
    const svc = createQuotaService({
      pool, file: path.join(tmp, 's.json'),
      fetchImpl: async () => { calls += 1; return { ok: false, status: 429, json: async () => ({}) }; },
      backoffBaseMs: 50, // small for the test
    });
    await svc.pollAll();
    ok(calls === 1, 'Q7: first poll attempts the fetch');
    await svc.pollAll();
    ok(calls === 1, 'Q7: a 429 puts the account in backoff — the immediate next sweep skips it');
    await new Promise((r) => setTimeout(r, 70));
    await svc.pollAll();
    ok(calls === 2, 'Q7: after the backoff window elapses, the account is polled again');
  }
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/quota.test.js`
Expected: FAIL at `Q7: a 429 puts the account in backoff` (calls === 2, no backoff yet).

- [ ] **Step 3: Implement backoff in `packages/provider/quota.js`**

Add `backoffBaseMs` to the `createQuotaService` options destructure (near `pollMinutes`):

```js
  backoffBaseMs = Number(process.env.QUOTA_BACKOFF_BASE_MS) || 60_000,
```

Add backoff state near the other Maps (after `const reactive = new Set();`):

```js
  const backoff = new Map(); // 'engine:name' → { until: epochMs, streak: n }
```

In `pollClaude`, on the 429 path (the block that today throws for non-ok, OR add explicit handling) — the current code does `if (!res.ok) throw new Error(...)`. Change the claude poller's non-ok tail and the agy poller's non-ok tail to register backoff instead of a bare throw. Simplest: wrap the registration in `pollOne`. Replace the `pollOne` function body with:

```js
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
```

Also update `pollable` so a backed-off account is skipped by `pollAll`'s pre-filter too — but `pollAll` calls `pollOne` which now checks backoff first, so no change to `pollable` is required. Verify `pollAll` still calls `pollOne` per account (it iterates `if (pollable(engine, acct)) await pollOne(...)`); the backoff check inside `pollOne` handles the skip. Add `backoff.clear()` calls are not needed in `stop()` (Map is GC'd with the instance), but for cleanliness add `backoff.clear();` in `stop()` alongside `soonTimers.clear();`.

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/quota.test.js`
Expected: PASS through Q7 (Q1-Q6 + Q7).

- [ ] **Step 5: Full suite + commit**

Run: `npm test` → green.

```bash
git add packages/provider/quota.js tests/quota.test.js
git commit -m "feat(quota): per-account exponential poll backoff on failure (caps at 30min, cleared on success)"
```

---

### Task 5: Orbit account import script

A Mac-operator tool that reads Orbit OS's credential vault and registers those Claude accounts in the bridge's `accounts.json`, writing each account's OAuth blob to its config dir. The pure planning core is unit-tested; the I/O (sqlite3/security/fs) is a thin wrapper exercised by a `--dry-run` smoke on the operator's Mac.

**Files:**
- Create: `packages/provider/orbit-import.js` (pure planning core + thin I/O)
- Create: `scripts/import-orbit-accounts.js` (CLI entry)
- Test: `tests/headroom.test.js` (append H4 block for the pure planner)

- [ ] **Step 1: Append H4 (pure planner) to headroom.test.js**

```js
  console.log('\n## H4 — Orbit import planner');
  {
    const { planOrbitImport } = require(path.join(REPO, 'packages/provider/orbit-import.js'));

    // Orbit accounts: claude oauth ones become bridge accounts; codex/manual
    // and the skip-listed daily-drivers are excluded.
    const orbit = [
      { id: 'uuid-1', email: 'dev1a@silentresponder.org', provider: 'claude', source: 'oauth' },
      { id: 'uuid-2', email: 'dev2b@silentresponder.org', provider: 'claude', source: 'oauth' },
      { id: 'uuid-3', email: 'waqar@iconprosolutions.com', provider: 'claude', source: 'oauth' }, // daily driver → skip
      { id: 'uuid-4', email: 'hello@x.com', provider: 'codex', source: 'oauth' }, // wrong provider
      { id: 'uuid-5', email: 'x@y.org', provider: 'claude', source: 'manual' }, // no vaulted blob
    ];
    const plan = planOrbitImport({
      orbitAccounts: orbit,
      existing: { claude: [{ name: 'main', dir: 'accounts/claude/main' }] },
      skipEmails: ['waqar@iconprosolutions.com', 'waqar@unitedtf.org'],
      hasVaultBlob: (id) => id !== 'uuid-5', // uuid-5 has no keychain blob
    });

    const names = plan.imported.map((a) => a.name).sort();
    ok(names.length === 2 && names.includes('dev1a') && names.includes('dev2b'),
      `H4: only claude+oauth+vaulted+non-skipped accounts imported (${names.join(',')})`);
    ok(plan.skipped.some((s) => s.email === 'waqar@iconprosolutions.com' && /daily driver|skip/i.test(s.reason)),
      'H4: daily-driver skipped with a reason');
    ok(plan.skipped.some((s) => s.email === 'hello@x.com' && /provider/i.test(s.reason)), 'H4: non-claude skipped');
    ok(plan.skipped.some((s) => s.id === 'uuid-5' && /vault|blob|login/i.test(s.reason)), 'H4: no-blob account skipped');

    // Each imported account: unique name (email localpart, de-collided),
    // dir under accounts/claude/, usageSource oauth, preserves existing 'main'.
    const imp = plan.imported.find((a) => a.name === 'dev1a');
    ok(imp.dir === 'accounts/claude/dev1a' && imp.usageSource === 'oauth' && imp.blobFromVaultId === 'uuid-1',
      'H4: imported account has dir/usageSource/vault-id wiring');
    ok(plan.accountsJson.claude.some((a) => a.name === 'main'), 'H4: existing accounts preserved');
    ok(plan.accountsJson.claude.filter((a) => a.name === 'dev1a').length === 1, 'H4: no duplicate account rows');

    // Name collision with an existing account gets a numeric suffix.
    const plan2 = planOrbitImport({
      orbitAccounts: [{ id: 'u', email: 'main@x.com', provider: 'claude', source: 'oauth' }],
      existing: { claude: [{ name: 'main', dir: 'accounts/claude/main' }] },
      skipEmails: [], hasVaultBlob: () => true,
    });
    ok(plan2.imported[0].name === 'main-2', `H4: name collision de-conflicted (${plan2.imported[0].name})`);
  }
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/headroom.test.js`
Expected: FAIL — `Cannot find module '.../orbit-import.js'`.

- [ ] **Step 3: Create `packages/provider/orbit-import.js`**

```js
'use strict';

const { execFileSync } = require('child_process');

// Daily-driver accounts the operator actively uses on the Mac — importing
// their OAuth blob would make the bridge's token refresh clobber the Mac login
// (Anthropic rotates refresh tokens). These are onboarded separately via
// `claude setup-token` (no rotation). Override with --skip on the CLI.
const DEFAULT_SKIP = ['waqar@iconprosolutions.com', 'waqar@unitedtf.org'];

const localpart = (email) => String(email || '').split('@')[0].replace(/[^A-Za-z0-9._-]/g, '') || 'account';

// Pure planner: decide which Orbit accounts become bridge accounts, their
// names/dirs, and what to skip and why. No I/O — fully unit-testable.
function planOrbitImport({ orbitAccounts, existing = {}, skipEmails = DEFAULT_SKIP, hasVaultBlob = () => true }) {
  const skip = new Set(skipEmails.map((e) => e.toLowerCase()));
  const existingClaude = (existing.claude || []).slice();
  const used = new Set(existingClaude.map((a) => a.name));
  const imported = [];
  const skipped = [];

  for (const acc of orbitAccounts) {
    if (acc.provider !== 'claude') { skipped.push({ id: acc.id, email: acc.email, reason: `provider ${acc.provider}, not claude` }); continue; }
    if (acc.source !== 'oauth') { skipped.push({ id: acc.id, email: acc.email, reason: `source ${acc.source}, no vaulted login` }); continue; }
    if (skip.has(String(acc.email).toLowerCase())) { skipped.push({ id: acc.id, email: acc.email, reason: 'daily driver — skip (use setup-token)' }); continue; }
    if (!hasVaultBlob(acc.id)) { skipped.push({ id: acc.id, email: acc.email, reason: 'no vault blob (log in once while Orbit runs, then re-import)' }); continue; }

    let name = localpart(acc.email);
    let n = 1;
    while (used.has(name)) { n += 1; name = `${localpart(acc.email)}-${n}`; }
    used.add(name);
    imported.push({ name, dir: `accounts/claude/${name}`, usageSource: 'oauth', email: acc.email, blobFromVaultId: acc.id });
  }

  const accountsJson = { ...existing, claude: existingClaude.concat(imported.map((a) => ({ name: a.name, dir: a.dir, usageSource: a.usageSource }))) };
  return { imported, skipped, accountsJson };
}

// ── Thin I/O layer (macOS operator machine) ───────────────────────────────
// Enumerate Orbit's tracked Claude accounts from its SQLite DB.
function readOrbitAccounts(dbPath) {
  const sql = `SELECT id, email, provider, source FROM accounts WHERE provider='claude';`;
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
}

// True when Orbit's login vault holds a credential blob for this account uuid.
function vaultHasBlob(accountId) {
  try {
    execFileSync('security', ['find-generic-password', '-s', 'Claude OS Login Vault', '-a', accountId, '-w'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch (_) { return false; }
}

// Read the vaulted credential blob (the claude .credentials.json contents).
function readVaultBlob(accountId) {
  return execFileSync('security', ['find-generic-password', '-s', 'Claude OS Login Vault', '-a', accountId, '-w'], { encoding: 'utf8' }).trim();
}

module.exports = { planOrbitImport, readOrbitAccounts, vaultHasBlob, readVaultBlob, DEFAULT_SKIP, localpart };
```

- [ ] **Step 4: Run to verify it passes**

Run: `node tests/headroom.test.js`
Expected: PASS through H4.

- [ ] **Step 5: Create the CLI entry `scripts/import-orbit-accounts.js`**

```js
#!/usr/bin/env node
'use strict';

// Import Orbit OS-vaulted Claude accounts into the bridge account pool.
// RUN ON THE MAC (needs the keychain + Orbit's SQLite DB). Writes each
// account's OAuth blob to <runtime>/accounts/claude/<name>/.credentials.json
// and registers it in accounts.json (usageSource oauth). Daily-driver accounts
// are skipped — onboard those with `claude setup-token`.
//
//   node scripts/import-orbit-accounts.js [--dry-run] [--runtime <dir>] [--skip a@x,b@y]
//
// Default runtime dir: ./.bridge-runtime (matches BRIDGE_ACCOUNTS_FILE default).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { planOrbitImport, readOrbitAccounts, vaultHasBlob, readVaultBlob, DEFAULT_SKIP } = require('../packages/provider/orbit-import');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const dryRun = process.argv.includes('--dry-run');
const runtime = path.resolve(arg('--runtime', path.join(__dirname, '..', '.bridge-runtime')));
const skipEmails = (arg('--skip', DEFAULT_SKIP.join(','))).split(',').map((s) => s.trim()).filter(Boolean);
const orbitDb = arg('--orbit-db', path.join(os.homedir(), '.claudeos', 'claudeos.db'));
const accountsFile = path.join(runtime, 'accounts.json');

if (!fs.existsSync(orbitDb)) { console.error(`Orbit DB not found: ${orbitDb}`); process.exit(1); }

const orbitAccounts = readOrbitAccounts(orbitDb);
const existing = fs.existsSync(accountsFile) ? JSON.parse(fs.readFileSync(accountsFile, 'utf8')) : {};
const plan = planOrbitImport({ orbitAccounts, existing, skipEmails, hasVaultBlob: vaultHasBlob });

console.log(`\nOrbit import plan (${dryRun ? 'DRY RUN' : 'APPLYING'}):`);
for (const a of plan.imported) console.log(`  + ${a.email}  →  claude:${a.name}  (${a.dir})`);
for (const s of plan.skipped) console.log(`  - ${s.email || s.id}  skipped: ${s.reason}`);
if (!plan.imported.length) { console.log('\nNothing to import.'); process.exit(0); }

if (dryRun) { console.log('\nDry run — no files written.'); process.exit(0); }

for (const a of plan.imported) {
  const dir = path.join(runtime, a.dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), readVaultBlob(a.blobFromVaultId), { mode: 0o600 });
}
fs.mkdirSync(runtime, { recursive: true });
fs.writeFileSync(accountsFile, `${JSON.stringify(plan.accountsJson, null, 2)}\n`);
console.log(`\nWrote ${plan.imported.length} account(s) + ${accountsFile}. Probe them from the dashboard Accounts tab.`);
```

- [ ] **Step 6: Dry-run smoke on the Mac**

Run: `node scripts/import-orbit-accounts.js --dry-run`
Expected: prints a plan listing the dev-fleet accounts as `+ imported` and the two daily drivers as `- skipped: daily driver`. Report the actual output. (If `~/.claudeos/claudeos.db` isn't present in the execution environment, run `node -e "require('./packages/provider/orbit-import')"` to confirm the module loads and note that the live dry-run needs the operator's Mac.)

- [ ] **Step 7: Full suite + commit**

Run: `npm test` → green (headroom.test.js gains H4).

```bash
git add packages/provider/orbit-import.js scripts/import-orbit-accounts.js tests/headroom.test.js
git commit -m "feat(accounts): Orbit vault import — planner + Mac CLI (dev fleet → oauth, daily drivers skipped)"
```

---

### Task 6: Dashboard — Overview fleet headroom summary

Per-engine summary on the Overview tab: best account (lowest bottleneck), how many windows are free, and the next reset across the fleet. Static files, smoke-verified.

**Files:**
- Modify: `packages/provider/dashboard/app.js` (Overview render ~line 160-231)
- Modify: `packages/provider/dashboard/index.html` (add an `ov-fleet` anchor)
- Modify: `packages/provider/dashboard/styles.css`

- [ ] **Step 1: Add the DOM anchor**

In `packages/provider/dashboard/index.html`, in the Overview section, add after the `ov-engines` div (line ~40):

```html
    <div class="fleet" id="ov-fleet"></div>
```

- [ ] **Step 2: Render the fleet summary**

In `app.js`, inside the Overview render function (the one that populates `ov-engines`/`ov-tiles`, ~line 160-231), add a fleet renderer. The account snapshots with quota live in `state.status.accounts[engine][].quota`. Add:

```js
  function renderFleet() {
    var s = state.status;
    if (!s || !s.accounts) { $('ov-fleet').innerHTML = ''; return; }
    var cards = Object.keys(s.accounts).map(function (e) {
      var accts = s.accounts[e] || [];
      var withQ = accts.filter(function (a) { return a.quota && a.quota.limits && a.quota.limits.length; });
      if (!withQ.length) return '<div class="fleetcard"><span class="eyebrow">' + esc(e) + '</span><span class="sub2">no usage data yet</span></div>';
      // Best = lowest max-window utilization; count windows under 90%; soonest reset.
      var best = null, bestPct = 101, freeWin = 0, totWin = 0, nextReset = Infinity;
      withQ.forEach(function (a) {
        var mx = 0;
        a.quota.limits.forEach(function (l) {
          totWin += 1;
          var p = Math.round(l.percent);
          if (p < 90) freeWin += 1;
          if (p > mx) mx = p;
          if (l.resetsAt && l.percent >= 90 && l.resetsAt < nextReset) nextReset = l.resetsAt;
        });
        if (mx < bestPct) { bestPct = mx; best = a; }
      });
      var resetTxt = nextReset < Infinity ? ' · next reset ' + fmtEta(nextReset) : '';
      return '<div class="fleetcard"><span class="eyebrow">' + esc(e) + '</span>'
        + '<span class="idmail">best: ' + esc(best ? best.name : '—') + ' (' + bestPct + '%)</span> '
        + '<span class="sub2">' + freeWin + '/' + totWin + ' windows free' + esc(resetTxt) + '</span></div>';
    }).join('');
    $('ov-fleet').innerHTML = cards;
  }
```

Call `renderFleet()` from wherever the Overview renders (add the call next to the existing `ov-engines`/`ov-tiles` population, and ensure it's reached on `quota.change` — the SSE handler already refreshes Overview on status change; verify `quota.change` triggers the Overview refresh path, and if the Overview render is a distinct function, call `renderFleet()` inside it). `fmtEta` and `esc` already exist (from Phase 1 Task 8 / the base file).

- [ ] **Step 3: Style it**

Append to `styles.css`, reusing the existing custom properties (check the top of the file — Phase 1 used `--body`/`--hairline`/`--ok`/`--warn`/`--down`):

```css
/* Overview — fleet headroom summary (router Phase 2) */
.fleet { display: flex; flex-wrap: wrap; gap: 10px; margin: 10px 0; }
.fleetcard { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; border: 1px solid var(--hairline); border-radius: 8px; min-width: 180px; }
```

- [ ] **Step 4: Smoke it**

```bash
cd /Users/waqar/Projects/experiments/ai-cli-bridge
BRIDGE_QUOTA_POLL=0 PROVIDER_PORT=19912 node packages/provider/server.js &
sleep 1.5
curl -s localhost:19912/healthz
curl -s localhost:19912/dashboard/app.js | node --check /dev/stdin && echo "app.js parses"
kill %1
```
Also copy `renderFleet`+`fmtEta`+`esc` into a scratch file and run it against a fixture with two accounts (one 20%/one 85% window) — confirm it names the 20% account as best and counts windows free. Report the output. Then delete the scratch file.

- [ ] **Step 5: Commit**

```bash
git add packages/provider/dashboard/app.js packages/provider/dashboard/index.html packages/provider/dashboard/styles.css
git commit -m "feat(dashboard): Overview fleet headroom summary (best account, windows free, next reset)"
```

---

### Task 7: Docs + full verification

**Files:**
- Modify: `docs/STATE.md`

- [ ] **Step 1: Update STATE.md**

Bump `last-updated` to today; add a new first Current Status bullet: **Router Phase 2 shipped** — headroom-aware unpinned dispatch (bottleneck-utilization scoring, drain threshold session≥90%/weekly≥95%, model-scoped weekly, drained-primary spill, round-robin fallback when no snapshots), `quota.change`→breaker-deadline correction (retires a quota breaker whose parsed reset was wrong once a fresh poll shows headroom), per-account exponential poll backoff, Orbit vault import script (`scripts/import-orbit-accounts.js` — dev fleet → oauth, daily drivers skipped for setup-token onboarding), and the Overview fleet summary. Note the three select() call sites now pass `model`+`headroom`. Point at spec §6/§9 and this plan. Update "Up Next" to Phase 3 (codex engine) next.

- [ ] **Step 2: Full verification**

Run: `npm test`
Expected: all 8 suites green (security, provider, pacer, core, keys, provider2, quota, headroom).

Run: `npm run check`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add docs/STATE.md
git commit -m "docs(state): router Phase 2 — headroom dispatch, breaker correction, Orbit import, poll backoff"
```

---

## Out of scope (later phases)

Codex engine (Phase 3), auto-routes/rules/per-key routing flags/latency tiebreak (Phase 4), NAS rebuild + live smokes + real headroom verification against live accounts (Phase 5). This plan makes selection *use* the snapshots and imports the fleet; it does not add engines, rules, or the Requests-tab "why this account" annotation (Phase 4).

## Notes carried from Phase 1's final review (now addressed here)

- **poll→breaker correction** (must-remember #1) — Task 3's `refreshQuotaBreaker`.
- **TZ-naive error-text deadlines** (must-remember #2) — mitigated by Task 3: a real poll now overrides a wrong parsed deadline.
- **poller jitter/backoff** (must-remember #4) — Task 4 (backoff; jitter deferred — one process, sequential polls are naturally staggered).
- Still deferred: spec §7's "confirm poll AT resetsAt before closing" (must-remember #3) — half-open trials still spend one real request to confirm recovery; acceptable, revisit only if trial-request waste shows up.
