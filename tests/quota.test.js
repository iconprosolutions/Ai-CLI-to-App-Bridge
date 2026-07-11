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

  console.log('\n## Q3 — claude adapter: reset parsing + throttle exclusion');
  {
    const { parseClaudeResetMs, classifyError } = require(path.join(REPO, 'packages/adapters/claude.js'));
    const now = new Date('2026-07-11T14:00:00').getTime(); // local 2pm

    // Legacy pipe-epoch format (seconds).
    ok(parseClaudeResetMs('Claude AI usage limit reached|1754298000', now) === 1754298000 * 1000,
      'Q3: legacy |epoch parses (seconds → ms)');

    // Current wording, same-day time.
    const t1 = parseClaudeResetMs("You've hit your session limit · resets 3:45pm", now);
    ok(t1 === new Date('2026-07-11T15:45:00').getTime(), 'Q3: "resets 3:45pm" → today 3:45pm');

    // A time already past rolls to tomorrow.
    const t2 = parseClaudeResetMs("You've hit your session limit · resets 1pm", now);
    ok(t2 === new Date('2026-07-12T13:00:00').getTime(), 'Q3: past time rolls to tomorrow');

    // Weekday wording (2026-07-11 is a Saturday; "Mon" → 2026-07-13).
    const t3 = parseClaudeResetMs("You've hit your weekly limit · resets Mon 12:00am", now);
    ok(t3 === new Date('2026-07-13T00:00:00').getTime(), 'Q3: weekday phrase → next Monday midnight');

    // Month-day wording with a timezone suffix to ignore.
    const t4 = parseClaudeResetMs("You've hit your weekly limit · resets Jul 14 at 4pm (Europe/Berlin)", now);
    ok(t4 === new Date('2026-07-14T16:00:00').getTime(), 'Q3: "Mon DD at Npm" parses (tz suffix ignored)');

    ok(parseClaudeResetMs('no reset info here', now) === null, 'Q3: unparseable → null');

    // Prose after the reset clause must not poison the parse ("monthly" ≠ Monday).
    const t5 = parseClaudeResetMs('resets 3:45pm. Note: monthly usage unaffected', now);
    ok(t5 === new Date('2026-07-11T15:45:00').getTime(), 'Q3: trailing prose does not fake a weekday');

    // classifyError: quota errors carry the deadline…
    const qe = classifyError('', "You've hit your Opus limit · resets 3:45pm");
    ok(qe && qe.kind === 'quota' && Number.isFinite(qe.data.cooldownUntilMs),
      'Q3: classifyError attaches cooldownUntilMs');
    // …and the server throttle is NOT quota.
    ok(classifyError('', 'API Error: Server is temporarily limiting requests (not your usage limit)') === null,
      'Q3: "not your usage limit" throttle excluded from quota');

    // Integration seam (Task 2 review fold-in): an ADAPTER-produced error must
    // flow through pool.feedback() into the account breaker's deadline path.
    const { createAccountPool } = require(path.join(REPO, 'packages/provider/accounts.js'));
    const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'q3-adapter-'));
    fs.writeFileSync(path.join(tmp3, 'accounts.json'), JSON.stringify({ claude: [{ name: 'm', dir: 'm' }] }));
    const pool3 = createAccountPool({ file: path.join(tmp3, 'accounts.json'), baseDir: tmp3, engines: ['claude'], watch: false });
    const sel3 = pool3.select('claude', {});
    pool3.feedback('claude', sel3.account, classifyError('', `Claude AI usage limit reached|${Math.floor((Date.now() + 2 * 3600 * 1000) / 1000)}`));
    const gate3 = sel3.account.breaker.allow();
    ok(gate3.allowed === false && gate3.retryInSec > 3600,
      `Q3: adapter-classified error drives the real breaker deadline (retry ${gate3.retryInSec}s)`);

    // Throttle exclusion must hold at ALL classification sites — isQuotaText
    // is the single decision the mid-stream and result-line branches share.
    const { isQuotaText } = require(path.join(REPO, 'packages/adapters/claude.js'));
    ok(isQuotaText('API Error: Server is temporarily limiting requests (not your usage limit)') === false,
      'Q3: throttle text is not quota despite containing "usage limit"');
    ok(isQuotaText('Your rate limit has been reached, limit will reset at 5pm') === true,
      'Q3: broad limit wording classifies as quota');
  }

  console.log('\n## Q4 — agy adapter: extended reset grammar');
  {
    const { parseResetsIn, parseBaselineRefreshMs, classifyError: agyClassify } =
      require(path.join(REPO, 'packages/adapters/agy.js'));

    ok(parseResetsIn('Resets in 2h3m57s') === 2 * 3600 + 3 * 60 + 57, 'Q4: "Resets in" grammar still parses');
    ok(parseResetsIn('Your quota will reset after 146h52m11s.') === 146 * 3600 + 52 * 60 + 11,
      'Q4: "reset after <GoDuration>" parses');
    ok(parseResetsIn('nothing here') === null, 'Q4: no duration → null');

    const b = parseBaselineRefreshMs("Your plan's baseline quota will refresh on 3/24/2026, 5:04:50 PM");
    ok(b === new Date('2026-03-24T17:04:50').getTime(), 'Q4: baseline refresh date parses (local)');

    // Both server phrasings classify as quota with a deadline attached.
    const e1 = agyClassify('', 'RESOURCE_EXHAUSTED (code 429): You have exhausted your capacity on this model. Your quota will reset after 2s');
    ok(e1 && e1.kind === 'quota' && e1.data.cooldownUntilMs >= Date.now() + 29_000,
      'Q4: sub-30s reset floored to ≥30s');
    const e2 = agyClassify('', 'You have exhausted your quota on this model.');
    ok(e2 && e2.kind === 'quota' && e2.data.cooldownUntilMs === undefined,
      'Q4: CLI-compiled quota string classifies, no fake deadline');
  }

  console.log(`\nquota.test.js: all ${passed} assertions passed`);
})().catch((err) => { console.error(err); process.exit(1); });
