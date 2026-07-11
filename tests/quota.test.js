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

    // First-strike Retry-After: the request that discovers the deadline must
    // report it precisely, not a generic 60s (final-review fix).
    const { httpFor } = require(path.join(REPO, 'packages/core/errors.js'));
    const firstStrike = classifyError('', `Claude AI usage limit reached|${Math.floor((Date.now() + 2 * 3600 * 1000) / 1000)}`);
    const mapped = httpFor(firstStrike);
    ok(mapped.retryAfterSec > 7000 && mapped.retryAfterSec <= 7200,
      `Q3: first-strike Retry-After derives from the parsed deadline (${mapped.retryAfterSec}s)`);
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
    ok(e1 && e1.kind === 'quota' && e1.data.cooldownUntilMs >= Date.now() + 29_000 && e1.data.cooldownUntilMs <= Date.now() + 31_000,
      'Q4: sub-30s reset floored to ≥30s (and only ~30s)');
    ok(parseResetsIn('Resets in 2h0m0s ... later ... Resets in 1h50m0s') === 1 * 3600 + 50 * 60,
      'Q4: freshest (last) duration wins in a multi-event log tail');
    ok(parseResetsIn('will reset after some time. Also: Resets in 2h3m57s') === 2 * 3600 + 3 * 60 + 57,
      'Q4: digitless phrase does not shadow a real duration');
    const e2 = agyClassify('', 'You have exhausted your quota on this model.');
    ok(e2 && e2.kind === 'quota' && e2.data.cooldownUntilMs === undefined,
      'Q4: CLI-compiled quota string classifies, no fake deadline');
  }

  console.log('\n## Q5 — quota parsers (claude oauth/usage + agy quota summary)');
  {
    const { parseClaudeUsage, parseAgyQuotaSummary, effective } =
      require(path.join(REPO, 'packages/provider/quota.js'));

    // New payload generation: generic limits[] array.
    const newShape = parseClaudeUsage({
      limits: [
        { kind: 'session', group: 'session', percent: 42, severity: 'normal', resets_at: '2026-07-11T19:00:00Z' },
        { kind: 'weekly_scoped', group: 'weekly', percent: 80, scope: { model: { display_name: 'Opus' } }, resets_at: '2026-07-14T08:00:00Z' },
      ],
    });
    ok(newShape.length === 2 && newShape[0].percent === 42 && newShape[0].label === 'Session (5h)',
      'Q5: claude limits[] shape parses');
    ok(newShape[1].label === 'Opus weekly' && newShape[1].resetsAt === Date.parse('2026-07-14T08:00:00Z'),
      'Q5: model-scoped weekly labeled from scope');

    // Ragged payloads: null entries must vanish, not become phantom 0% rows.
    const ragged = parseClaudeUsage({ limits: [null, { kind: 'session', group: 'session', percent: 10, resets_at: '2026-07-11T19:00:00Z' }] });
    ok(ragged.length === 1 && ragged[0].kind === 'session', 'Q5: null limits[] entries are filtered, not phantom rows');

    // Legacy generation: top-level five_hour/seven_day (+ per-model keys).
    const legacy = parseClaudeUsage({
      five_hour: { utilization: 61, resets_at: '2026-07-11T17:00:00Z' },
      seven_day: { utilization: 33, resets_at: '2026-07-14T08:00:00Z' },
      seven_day_opus: { utilization: 90, resets_at: '2026-07-14T08:00:00Z' },
    });
    ok(legacy.length === 3 && legacy[0].kind === 'session' && legacy[2].kind === 'weekly_scoped',
      'Q5: claude legacy shape parses incl. seven_day_<model>');

    // agy quota summary: remainingFraction (0..1 remaining) → percent used.
    const agy = parseAgyQuotaSummary({
      groups: [{
        displayName: 'Gemini Models',
        buckets: [
          { bucketId: 'five_hour', displayName: 'Five hour', remaining: { remainingFraction: 0.25 }, resetTime: '2026-07-11T18:00:00Z' },
          { bucketId: 'weekly', displayName: 'Weekly', remaining: { remainingFraction: 0.9 }, resetTime: '2026-07-15T00:00:00Z' },
        ],
      }],
    });
    ok(agy.length === 2 && agy[0].percent === 75 && agy[0].group === 'session',
      'Q5: agy five-hour bucket → 75% used, session group');
    ok(agy[1].percent === 10 && agy[1].label === 'Gemini Models · Weekly',
      'Q5: agy weekly bucket labeled by family');

    // effective(): a window whose reset passed reads as fresh (0%).
    const eff = effective([{ kind: 'session', group: 'session', label: 'x', percent: 99, resetsAt: Date.now() - 1000 }]);
    ok(eff[0].percent === 0 && eff[0].fresh === true, 'Q5: past reset ⇒ fresh window');
  }

  console.log('\n## Q6 — quota service: polling, degradation, persistence');
  {
    const { createQuotaService } = require(path.join(REPO, 'packages/provider/quota.js'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q6-quota-'));

    // Fake pool: two claude accounts (one reactive) + one gemini account.
    const mkDir = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); return d; };
    const claudeMain = mkDir('claude-main');
    fs.writeFileSync(path.join(claudeMain, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'tok-main' } }));
    const agyDir = mkDir('agy-a');
    fs.mkdirSync(path.join(agyDir, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(agyDir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
      JSON.stringify({ token: { access_token: 'g-tok', expiry: new Date(Date.now() + 3600_000).toISOString() } }));
    const fakePool = {
      accounts: (engine) => engine === 'claude'
        ? [
          { engine: 'claude', name: 'main', dir: claudeMain, enabled: true, needsLogin: false, usageSource: 'oauth' },
          { engine: 'claude', name: 'shared', dir: mkDir('claude-shared'), enabled: true, needsLogin: false, usageSource: 'reactive' },
        ]
        : [{ engine: 'gemini', name: 'a', dir: agyDir, enabled: true, needsLogin: false, usageSource: 'oauth' }],
    };

    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, auth: opts.headers.Authorization });
      if (url.includes('api.anthropic.com')) {
        return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 40, resets_at: '2026-07-11T17:00:00Z' } }) };
      }
      return { ok: true, status: 200, json: async () => ({ groups: [{ displayName: 'Gemini Models', buckets: [{ bucketId: 'five_hour', remaining: { remainingFraction: 0.5 }, resetTime: '2026-07-11T18:00:00Z' }] }] }) };
    };

    const events = [];
    const svc = createQuotaService({
      pool: fakePool, file: path.join(tmp, 'snap.json'), fetchImpl,
      onChange: (ev) => events.push(ev),
    });
    await svc.pollAll();

    ok(calls.some((c) => c.url.includes('api.anthropic.com') && c.auth === 'Bearer tok-main'),
      'Q6: claude oauth account polled with its own token');
    ok(!calls.some((c) => c.auth === 'Bearer undefined'), 'Q6: reactive account never polled');
    ok(calls.some((c) => c.url.includes('cloudcode-pa.googleapis.com') && c.auth === 'Bearer g-tok'),
      'Q6: agy account polled with the token-file access token');

    const got = svc.get('claude', 'main');
    ok(got && got.limits[0].percent === 40 && got.source === 'oauth', 'Q6: snapshot readable via get()');
    ok(svc.get('claude', 'shared') === null, 'Q6: reactive account has no snapshot');
    ok(events.length >= 2, `Q6: onChange fired per polled account (${events.length})`);

    // 403 on the usage endpoint degrades the account to reactive (scope).
    const svc403 = createQuotaService({
      pool: fakePool, file: path.join(tmp, 'snap2.json'),
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    });
    await svc403.pollAll();
    const deg = svc403.get('claude', 'main');
    ok(deg === null || deg.source === 'reactive', 'Q6: 403 degrades the account to reactive');

    // Persistence: a new instance reads the snapshot file back. The write is
    // debounced ~1s, so give it time to land before the second instance loads.
    await new Promise((r) => setTimeout(r, 1300));
    const svc2 = createQuotaService({ pool: fakePool, file: path.join(tmp, 'snap.json'), fetchImpl });
    const back = svc2.get('claude', 'main');
    ok(back && back.limits[0].kind === 'session', 'Q6: snapshots survive a restart via the file');

    // stop() within the first 5s must cancel the initial sweep — a service
    // stopped at shutdown must never fire network calls afterwards.
    let sweeps = 0;
    const svcStop = createQuotaService({
      pool: { accounts: () => { sweeps += 1; return []; } },
      file: path.join(tmp, 'snap3.json'),
      fetchImpl: async () => { throw new Error('must not fetch'); },
    });
    svcStop.start();
    svcStop.stop();
    await new Promise((r) => setTimeout(r, 5300));
    ok(sweeps === 0, `Q6: stop() cancels the pending first sweep (${sweeps} sweeps fired)`);
  }

  console.log(`\nquota.test.js: all ${passed} assertions passed`);
})().catch((err) => { console.error(err); process.exit(1); });
