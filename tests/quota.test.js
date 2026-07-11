'use strict';
// Router Phase 1 suite: reset-precise breakers, adapter reset parsers,
// quota snapshot service. Plain asserts, no framework — same style as the
// other tests/*.test.js suites.
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const REPO = path.resolve(__dirname, '..');
let passed = 0;
function ok(cond, msg) { assert(cond, msg); passed += 1; console.log(`  ok - ${msg}`); }

(async () => {
  console.log('## Q1 — breaker: single-strike quota + cooldown deadline');
  {
    const { createBreaker } = require(path.join(REPO, 'packages/provider/breaker.js'));

    // Default quotaThreshold is now 1: the first quota failure opens.
    const b1 = createBreaker({ engine: 'claude:t1', quotaCooldownMs: 60_000 });
    b1.recordFailure('quota');
    const g1 = b1.allow();
    ok(g1.allowed === false, 'Q1: first quota failure opens the circuit');
    ok(g1.retryInSec >= 55 && g1.retryInSec <= 60, `Q1: fallback cooldown ~60s (got ${g1.retryInSec}s)`);

    // Explicit deadline overrides the fallback cooldown.
    const b2 = createBreaker({ engine: 'claude:t2', quotaCooldownMs: 60_000 });
    const until = Date.now() + 90 * 60 * 1000;
    b2.recordFailure('quota', { until });
    const g2 = b2.allow();
    ok(g2.allowed === false && g2.retryInSec > 85 * 60, `Q1: deadline cooldown ~90min (got ${g2.retryInSec}s)`);

    // Sub-30s deadlines are floored (agy "reset after 1s" server-bug loop).
    const b3 = createBreaker({ engine: 'gemini:t3', quotaCooldownMs: 60_000 });
    b3.recordFailure('quota', { until: Date.now() + 1000 });
    ok(b3.allow().retryInSec >= 28, 'Q1: sub-30s deadline floored to ≥30s');

    // Absurd deadlines are capped at 8 days.
    const b4 = createBreaker({ engine: 'gemini:t4', quotaCooldownMs: 60_000 });
    b4.recordFailure('quota', { until: Date.now() + 365 * 24 * 3600 * 1000 });
    ok(b4.allow().retryInSec <= 8 * 24 * 3600, 'Q1: deadline capped at 8 days');

    // Timeout failures keep the 3-strike behavior and ignore `until`.
    const b5 = createBreaker({ engine: 'claude:t5' });
    b5.recordFailure('timeout', { until: Date.now() + 3600_000 });
    b5.recordFailure('timeout');
    ok(b5.allow().allowed === true, 'Q1: two timeouts stay closed (threshold 3 unchanged)');
  }

  console.log('\n## Q2 — account pool: usageSource + cooldown pass-through');
  {
    const { createAccountPool, validateAccounts } = require(path.join(REPO, 'packages/provider/accounts.js'));
    const { BridgeError } = require(path.join(REPO, 'packages/core/errors.js'));

    // usageSource validates: absent OK, 'oauth'/'reactive' OK, junk rejected.
    validateAccounts({ claude: [{ name: 'a', dir: 'x' }, { name: 'b', dir: 'y', usageSource: 'reactive' }] });
    ok(true, 'Q2: usageSource absent/reactive accepted');
    let threw = false;
    try { validateAccounts({ claude: [{ name: 'a', dir: 'x', usageSource: 'push' }] }); }
    catch (e) { threw = /usageSource/.test(e.message); }
    ok(threw, 'Q2: unknown usageSource rejected with a precise message');

    // feedback() forwards cooldownUntilMs to the account breaker.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q2-accounts-'));
    const file = path.join(tmp, 'accounts.json');
    fs.writeFileSync(file, JSON.stringify({ claude: [{ name: 'main', dir: 'main' }, { name: 'alt', dir: 'alt', usageSource: 'reactive' }] }));
    const pool = createAccountPool({ file, baseDir: tmp, engines: ['claude'], watch: false });
    const snap = pool.snapshot();
    ok(snap.claude[0].usageSource === 'oauth' && snap.claude[1].usageSource === 'reactive',
      'Q2: snapshot carries usageSource (default oauth)');

    const sel = pool.select('claude', { pin: 'main' });
    const until = Date.now() + 45 * 60 * 1000;
    pool.feedback('claude', sel.account, new BridgeError('quota', 'limit', { cooldownUntilMs: until }));
    const gate = sel.account.breaker.allow();
    ok(gate.allowed === false && gate.retryInSec > 40 * 60,
      `Q2: feedback passes the deadline through (retry ${gate.retryInSec}s)`);

    // Half-open re-failure with a deadline (review fold-in from Task 1): a
    // trial that fails with a fresh deadline must cool until THAT deadline.
    const { createBreaker } = require(path.join(REPO, 'packages/provider/breaker.js'));
    const hb = createBreaker({ engine: 'claude:ho', quotaCooldownMs: 50 });
    hb.recordFailure('quota'); // opens with 50ms fallback
    await new Promise((r) => setTimeout(r, 80));
    const trial = hb.allow(); // half-open trial
    ok(trial.allowed === true && trial.trial === true, 'Q2: half-open admits the trial');
    hb.recordFailure('quota', { until: Date.now() + 20 * 60 * 1000 });
    const regate = hb.allow();
    ok(regate.allowed === false && regate.retryInSec > 15 * 60,
      `Q2: half-open re-failure honors the new deadline (retry ${regate.retryInSec}s)`);
  }

  console.log(`\nquota.test.js: all ${passed} assertions passed`);
})().catch((err) => { console.error(err); process.exit(1); });
