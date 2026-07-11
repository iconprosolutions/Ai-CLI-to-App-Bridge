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

    // Boundary exactness: >= at 90/95, just-under stays undrained.
    ok(isDrained([{ group: 'session', kind: 'session', label: 's', percent: 90 }], 'm') === true, 'H1: session exactly 90 → drained');
    ok(isDrained([{ group: 'session', kind: 'session', label: 's', percent: 89.9 }], 'm') === false, 'H1: session 89.9 → not drained');
    ok(isDrained([{ group: 'weekly', kind: 'weekly_all', label: 'W', percent: 95 }], 'm') === true, 'H1: weekly exactly 95 → drained');
    ok(isDrained([{ group: 'weekly', kind: 'weekly_all', label: 'W', percent: 94.9 }], 'm') === false, 'H1: weekly 94.9 → not drained');
    // The threshold override Task 2 threads through select().
    ok(isDrained([{ group: 'session', kind: 'session', label: 's', percent: 60 }], 'm', { sessionMax: 50 }) === true, 'H1: sessionMax override respected');
  }

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

    // Soft-pin fallback must stay headroom-aware: when the assigned account is
    // drained, the pool fallback picks the least-utilized account, not the
    // round-robin first (review fix — the recursion previously dropped opts).
    const { BridgeError } = require(path.join(REPO, 'packages/core/errors.js'));
    const spFile = path.join(tmp, 'softpin.json');
    fs.writeFileSync(spFile, JSON.stringify({ claude: [{ name: 'assigned', dir: 'assigned' }, { name: 'busy', dir: 'busy' }, { name: 'idle', dir: 'idle' }] }));
    const p7 = createAccountPool({ file: spFile, baseDir: tmp, engines: ['claude'], watch: false });
    const spScen = {
      assigned: [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 97 }], // drained, but that alone doesn't stop the pin from serving
      busy: [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 80 }],
      idle: [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 5 }],
    };
    // Open the assigned account's breaker so the soft pin is truly unusable
    // (drain alone doesn't disqualify a soft pin — it serves until it fails).
    const selAssigned = p7.select('claude', { pin: 'assigned' });
    p7.feedback('claude', selAssigned.account, new BridgeError('quota', 'exhausted'));
    const s7 = p7.select('claude', { pin: 'assigned', pinMode: 'soft', model: 'm', headroom: (e, n) => spScen[n] });
    ok(s7.ok && s7.account.name === 'idle', 'H2: soft-pin fallback stays headroom-aware (review fix)');

    // Cold start: no snapshots anywhere → all score neutral-50 → the dist
    // tiebreak must degrade to round-robin, not herd on index 0.
    const p8 = mk(['a', 'b', 'c']);
    const cold = (n) => { const r = []; for (let i = 0; i < n; i += 1) { const s = p8.select('claude', { model: 'm', headroom: () => null }); r.push(s.account.name); } return r; };
    ok(cold(2).join(',') === 'a,b', 'H2: equal scores degrade to round-robin by cursor distance');

    // Busy spill: the best-scored account with all slots taken ranks behind a
    // free account — a burst spreads across the pool instead of queueing.
    const p9 = mk(['x', 'y']);
    const busyScen = {
      x: [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 5 }],
      y: [{ group: 'weekly', kind: 'weekly_all', label: 'Weekly', percent: 60 }],
    };
    const hb = (e, n) => busyScen[n];
    const first = p9.select('claude', { model: 'm', headroom: hb });
    ok(first.account.name === 'x', 'H2: best-scored account chosen when free');
    first.account.semaphore.acquire(); // occupy x's only CLI slot
    const second = p9.select('claude', { model: 'm', headroom: hb });
    ok(second.account.name === 'y', 'H2: busy best account spills the burst to the next-best');
  }

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

  console.log(`\nheadroom.test.js: all ${passed} assertions passed`);
})().catch((err) => { console.error(err); process.exit(1); });
