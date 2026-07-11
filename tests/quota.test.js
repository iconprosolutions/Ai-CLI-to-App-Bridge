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

  console.log(`\nquota.test.js: all ${passed} assertions passed`);
})().catch((err) => { console.error(err); process.exit(1); });
