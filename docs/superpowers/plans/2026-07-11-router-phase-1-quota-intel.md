# Router Phase 1 — Quota Intelligence + Reset-Precise Breakers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-account quota snapshots for claude + agy (free provider endpoints), quota breakers that cool down until the *actual* reset instant, adapter fixes for limit errors the bridge currently misclassifies or misses, and live usage bars on the dashboard Accounts tab.

**Architecture:** New `packages/provider/quota.js` polls each account's provider usage endpoint and normalizes to one per-window shape (Orbit OS port); adapters attach `cooldownUntilMs` to quota `BridgeError`s; `accounts.js` feedback passes it to `breaker.js`, which now trips on the first quota failure and honors the deadline. Server wires the poller to SSE (`quota.change`) and `/dashboard/status`; the dashboard renders bars. Spec: `docs/superpowers/specs/2026-07-11-multi-model-router-design.md` (§5, §7, §9 Phase 1).

**Tech Stack:** Node 22 (CommonJS, no new deps), plain-assert test suites run via `node tests/<file>.test.js`, native `fetch` with injectable `fetchImpl` (Orbit's pattern).

**Conventions for every task:** run tests from the repo root `/Users/waqar/Projects/experiments/ai-cli-bridge`. All new unit tests go in **`tests/quota.test.js`** (created in Task 1, extended by later tasks — append each task's block above the final summary line). Commit after every green task.

---

### Task 1: Breaker — single-strike quota + explicit cooldown deadline

The breaker currently opens only after **2** consecutive quota failures and always cools down a fixed `quotaCooldownMs` (15 min default). A parsed limit error is definitive, so quota now trips on the **first** failure, and callers can pass the real reset instant.

**Files:**
- Modify: `packages/provider/breaker.js`
- Modify: `tests/provider2.test.js:806-817` (encodes the old two-strike default)
- Modify: `package.json:17` (add the new suite to the test chain)
- Create: `tests/quota.test.js`

- [ ] **Step 1: Create the new test suite with failing breaker tests**

Create `tests/quota.test.js`:

```js
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
```

- [ ] **Step 2: Run the suite to verify it fails**

Run: `node tests/quota.test.js`
Expected: FAIL — `Q1: first quota failure opens the circuit` (current default threshold is 2, so the circuit stays closed).

- [ ] **Step 3: Implement the breaker changes**

In `packages/provider/breaker.js`:

Change the defaults (the comment block above `createBreaker` should also say quota trips on the first failure):

```js
function createBreaker({
  engine,
  quotaThreshold = 1, // a parsed limit error is definitive, not flaky
  timeoutThreshold = 3,
  quotaCooldownMs = 15 * 60 * 1000, // fallback when no reset signal parsed
  timeoutCooldownMs = 2 * 60 * 1000,
  onChange = null,
} = {}) {
```

Add the clamp constants right after the state variables (`let trialInFlight = false;`):

```js
  // Reset-precise deadlines are clamped: never trust a sub-30s reset (agy has
  // a server-side bug that loops "reset after 1s"), never park an account for
  // more than 8 days (longest observed weekly-baseline lockout, plus slack).
  const MIN_UNTIL_MS = 30 * 1000;
  const MAX_UNTIL_MS = 8 * 24 * 3600 * 1000;
```

Replace `recordFailure` with:

```js
  function recordFailure(kind, opts = {}) {
    trialInFlight = false;
    if (kind === 'quota') {
      quotaStreak += 1;
      timeoutStreak = 0;
    } else if (kind === 'timeout') {
      timeoutStreak += 1;
      quotaStreak = 0;
    } else {
      // Other failures break the streaks — they're not capacity signals.
      quotaStreak = 0;
      timeoutStreak = 0;
      return;
    }
    const tripQuota = quotaStreak >= quotaThreshold;
    const tripTimeout = timeoutStreak >= timeoutThreshold;
    if (state === 'half-open' || tripQuota || tripTimeout) {
      reason = state === 'half-open' ? (kind || reason) : (tripQuota ? 'quota' : 'timeout');
      cooldownMs = reason === 'quota' ? quotaCooldownMs : timeoutCooldownMs;
      // A quota error that names its reset instant cools exactly until then.
      if (reason === 'quota' && Number.isFinite(opts.until)) {
        cooldownMs = Math.min(Math.max(opts.until - Date.now(), MIN_UNTIL_MS), MAX_UNTIL_MS);
      }
      openedAt = Date.now();
      change('open');
    }
  }
```

- [ ] **Step 4: Run the suite to verify it passes**

Run: `node tests/quota.test.js`
Expected: PASS — `all 6 assertions passed` (5 `ok` lines plus none failing; adjust count message to whatever the suite prints).

- [ ] **Step 5: Update the stale two-strike assertions in provider2**

In `tests/provider2.test.js`, replace lines 806-811 (keep 812-817 as is):

```js
  const b = createBreaker({ engine: 'claude', quotaCooldownMs: 200 });
  b.recordFailure('quota');
  const denied = b.allow();
  assert(denied.allowed === false && denied.retryInSec >= 1, 'a single quota failure opens the circuit (quota is definitive)');
```

(The old block asserted `one quota failure keeps circuit closed` then required a second failure — delete both of those asserts and the extra `recordFailure`.)

Note: `tests/provider2.test.js:238` passes an explicit `quotaThreshold: 2` and stays valid — do not touch it.

- [ ] **Step 6: Add the suite to the test chain**

In `package.json` line 17, append `&& node tests/quota.test.js` to the `"test"` script (after `provider2.test.js`).

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: all suites PASS, including the updated provider2 breaker block.

- [ ] **Step 8: Commit**

```bash
git add packages/provider/breaker.js tests/quota.test.js tests/provider2.test.js package.json
git commit -m "feat(breaker): quota trips on first failure, cooldown until the parsed reset instant"
```

---

### Task 2: Account pool — `usageSource` field + deadline pass-through

`pool.feedback()` currently calls `breaker.recordFailure(err.kind)` and **drops** any reset info the adapter attached. Accounts also need a `usageSource` field so setup-token accounts can opt out of polling.

**Files:**
- Modify: `packages/provider/accounts.js`
- Test: `tests/quota.test.js` (append block)

- [ ] **Step 1: Append failing tests to `tests/quota.test.js`**

Insert before the final `console.log` summary line:

```js
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
  }
```

Note on the import: `packages/core/errors.js` exports `BridgeError` (check the export name with `grep "module.exports" packages/core/errors.js` — if it exports via `@bridge/core`'s index instead, use `require(path.join(REPO, 'packages/core/index.js')).BridgeError`).

- [ ] **Step 2: Run to verify the new block fails**

Run: `node tests/quota.test.js`
Expected: FAIL at `Q2: unknown usageSource rejected` (no validation exists) or `Q2: snapshot carries usageSource`.

- [ ] **Step 3: Implement in `packages/provider/accounts.js`**

In `validateAccounts`, after the `dir` check (line ~24):

```js
      if (a.usageSource !== undefined && !['oauth', 'reactive'].includes(a.usageSource)) {
        throw new Error(`accounts.json: ${engine}/${a.name} "usageSource" must be "oauth" or "reactive"`);
      }
```

In `makeAccount`, after `implicit: Boolean(def.implicit),`:

```js
      // 'oauth' → the quota service polls this account's provider usage
      // endpoint; 'reactive' → never poll (setup-token / shared credentials),
      // quota knowledge comes only from parsed limit errors.
      usageSource: def.usageSource || 'oauth',
```

In `build()`, inside the `if (old)` branch (line ~80), alongside the `enabled`/`primary` reassertion:

```js
          old.usageSource = def.usageSource || 'oauth';
```

In `feedback()`, replace `account.breaker.recordFailure(err.kind);` with:

```js
    account.breaker.recordFailure(err.kind, {
      until: err.data && Number.isFinite(err.data.cooldownUntilMs) ? err.data.cooldownUntilMs : undefined,
    });
```

In `snapshot()`, add to the per-account object (next to `primary`):

```js
        usageSource: a.usageSource,
```

- [ ] **Step 4: Run the suite**

Run: `node tests/quota.test.js`
Expected: PASS (Q1 + Q2 blocks).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS everywhere (feedback's second argument is optional, so existing call sites are unaffected).

- [ ] **Step 6: Commit**

```bash
git add packages/provider/accounts.js tests/quota.test.js
git commit -m "feat(accounts): usageSource per account + quota deadlines flow into breakers"
```

---

### Task 3: Claude adapter — reset parsing, mid-stream limit detection, throttle exclusion

Three fixes from research: (1) limit errors carry a parseable reset time in two generations of wording — parse it into `cooldownUntilMs`; (2) a mid-stream limit arrives as a synthetic assistant event with `isApiErrorMessage: true` that today looks like a **clean completion** (upstream anthropics/claude-code#68816); (3) "Server is temporarily limiting requests (not your usage limit)" is a retryable server throttle, not quota — it currently matches the `rate limit` regex and wrongly opens the quota breaker.

**Files:**
- Modify: `packages/adapters/claude.js`
- Test: `tests/quota.test.js` (append block)

- [ ] **Step 1: Append failing tests**

Insert before the final summary line:

```js
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

    // classifyError: quota errors carry the deadline…
    const qe = classifyError('', "You've hit your Opus limit · resets 3:45pm");
    ok(qe && qe.kind === 'quota' && Number.isFinite(qe.data.cooldownUntilMs),
      'Q3: classifyError attaches cooldownUntilMs');
    // …and the server throttle is NOT quota.
    ok(classifyError('', 'API Error: Server is temporarily limiting requests (not your usage limit)') === null,
      'Q3: "not your usage limit" throttle excluded from quota');
  }
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/quota.test.js`
Expected: FAIL — `parseClaudeResetMs` is not exported / not defined.

- [ ] **Step 3: Implement in `packages/adapters/claude.js`**

Add above `classifyError` (after `MODEL_ALIASES`):

```js
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Parse a reset instant out of Claude limit-error text. Two generations:
// legacy "…usage limit reached|<epoch>" and current human wording
// ("resets 3:45pm", "resets Mon 12:00am", "resets Jul 14 at 4pm (Europe/Berlin)").
// Returns epoch ms or null. Times are read in THIS process's zone —
// ponytail: good enough; the quota service's authoritative resets_at
// (Task 6) corrects any drift on the next poll.
function parseClaudeResetMs(text, now = Date.now()) {
  const s = String(text || '');
  const epoch = /\|(\d{10,13})\b/.exec(s);
  if (epoch) { const n = Number(epoch[1]); return n < 1e12 ? n * 1000 : n; }
  const m = /resets?\s+(?:at\s+)?([^·\n()]+)/i.exec(s);
  if (!m) return null;
  const phrase = m[1].trim().toLowerCase();
  const t = /(\d{1,2})(?::(\d{2}))?\s*([ap]m)/.exec(phrase);
  if (!t) return null;
  const hour = (Number(t[1]) % 12) + (t[3] === 'pm' ? 12 : 0);
  const minute = Number(t[2] || 0);
  const d = new Date(now);
  d.setSeconds(0, 0);
  const mon = new RegExp(`\\b(${MONTHS.join('|')})[a-z]*\\s+(\\d{1,2})\\b`).exec(phrase);
  const wd = new RegExp(`\\b(${WEEKDAYS.join('|')})[a-z]*\\b`).exec(phrase);
  if (mon) {
    d.setMonth(MONTHS.indexOf(mon[1]), Number(mon[2]));
    d.setHours(hour, minute);
    if (d.getTime() <= now) d.setFullYear(d.getFullYear() + 1);
  } else if (wd) {
    d.setHours(hour, minute);
    let delta = (WEEKDAYS.indexOf(wd[1]) - d.getDay() + 7) % 7;
    if (delta === 0 && d.getTime() <= now) delta = 7;
    d.setDate(d.getDate() + delta);
  } else {
    d.setHours(hour, minute);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}
```

Replace `classifyError` (keep the model_not_found branch as is):

```js
function classifyError(stderr, stdout) {
  const text = [stderr, stdout].map((p) => String(p || '').trim()).filter(Boolean).join('\n');
  // Server-side throttling explicitly says it is NOT the subscription limit —
  // retryable on the same account, never a quota signal.
  if (/not your usage limit/i.test(text)) return null;
  if (/usage limit|limit reached|limit will reset|rate limit|hit your \S+ limit/i.test(text)) {
    const until = parseClaudeResetMs(text);
    return new BridgeError('quota', 'Claude subscription capacity is exhausted for now. Retry after the limit window resets.', {
      detail: text.slice(0, 300),
      ...(until ? { cooldownUntilMs: until } : {}),
    });
  }
  if (text.includes("There's an issue with the selected model") || text.includes('deprecated and will reach end-of-life')) {
    return new BridgeError('model_not_found', 'The requested Claude model is not available in this Claude Code install.', { detail: text.slice(0, 300) });
  }
  return null;
}
```

In `invokeStreamJson`, add mid-stream detection. Declare alongside `let resultLine = null;`:

```js
    let apiError = null;
```

In `handleLine`, add a branch before `} else if (obj.type === 'result') {`:

```js
      } else if (obj.type === 'assistant' && obj.isApiErrorMessage) {
        // A mid-stream limit arrives as a synthetic assistant turn whose
        // stop_reason looks like a clean completion (claude-code#68816) —
        // isApiErrorMessage is the only reliable flag.
        const blocks = (obj.message && obj.message.content) || [];
        apiError = { error: String(obj.error || ''), text: blocks.map((b) => (b && b.text) || '').join(' ').trim() };
      } else if (obj.type === 'result') {
```

After the `if (!resultLine)` guard and **before** the `if (resultLine.is_error)` block, add:

```js
    if (apiError) {
      const isQuota = apiError.error === 'rate_limit' || /hit your \S+ limit|usage limit/i.test(apiError.text);
      const until = isQuota ? parseClaudeResetMs(apiError.text) : null;
      throw new BridgeError(isQuota ? 'quota' : 'bad_output',
        apiError.text || 'Claude reported an API error mid-stream',
        { ...(until ? { cooldownUntilMs: until } : {}) });
    }
```

In the `resultLine.is_error` branch, attach the deadline there too — replace `throw new BridgeError(kind, msg);` with:

```js
      const until = kind === 'quota' ? parseClaudeResetMs(msg) : null;
      throw new BridgeError(kind, msg, { ...(until ? { cooldownUntilMs: until } : {}) });
```

Export the helpers — change the module exports line to:

```js
module.exports = { createClaudeAdapter, KNOWN_MODELS, parseClaudeResetMs, classifyError };
```

(`system/api_retry` events need no change: `handleLine` already ignores unknown types.)

- [ ] **Step 4: Run the suite**

Run: `node tests/quota.test.js`
Expected: PASS through Q3.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — the provider2 quota-stub test (`Claude usage limit reached. Your limit will reset at 5pm.` → 429) keeps working; it now also carries a deadline internally.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters/claude.js tests/quota.test.js
git commit -m "fix(claude): parse limit reset times, catch mid-stream isApiErrorMessage limits, exclude server throttle from quota"
```

---

### Task 4: agy adapter — extended reset grammar + deadline attachment

`agy.js` already parses `Resets in 2h3m57s` from cli.log (`parseResetsIn`, returns seconds) and attaches `retryAfterSec`. Research adds two server grammars: `Your quota will reset after 146h52m11s` and `Your plan's baseline quota will refresh on 3/24/2026, 5:04:50 PM`, plus the CLI-compiled string `You have exhausted your quota on this model.` (agy ≥1.1.1 prints these to stderr in print mode).

**Files:**
- Modify: `packages/adapters/agy.js`
- Test: `tests/quota.test.js` (append block)

- [ ] **Step 1: Append failing tests**

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/quota.test.js`
Expected: FAIL — `parseResetsIn` / `parseBaselineRefreshMs` not exported; "reset after" grammar unknown.

- [ ] **Step 3: Implement in `packages/adapters/agy.js`**

Replace `parseResetsIn` (line ~48) and add the baseline parser:

```js
// "Resets in 2h3m57s" / "quota will reset after 146h52m11s" → seconds. Null if absent.
function parseResetsIn(text) {
  const m = /(?:resets in|reset after)\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/i.exec(text);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return (Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
}

// "baseline quota will refresh on 3/24/2026, 5:04:50 PM" → epoch ms (V8 parses
// this US-locale form directly). The weekly-baseline lockout deadline.
function parseBaselineRefreshMs(text) {
  const m = /baseline quota will refresh on\s+([\d/]+,\s*[\d: ]+[AP]M)/i.exec(text);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}

// Deadline from any agy quota text: prefer the rolling-window duration
// (floored to 30s — the server has a known "reset after 1s" loop bug),
// else the weekly baseline date. Undefined when neither parses.
function agyCooldownUntilMs(text) {
  const sec = parseResetsIn(text);
  if (sec != null) return Date.now() + Math.max(sec, 30) * 1000;
  const baseline = parseBaselineRefreshMs(text);
  return baseline != null ? baseline : undefined;
}
```

In `classifyError`, replace the quota branch:

```js
  if (text.includes('You have exhausted your capacity on this model')
    || text.includes('You have exhausted your quota on this model')) {
    const until = agyCooldownUntilMs(text);
    return new BridgeError('quota', 'Antigravity capacity for this model is exhausted. Retry later or use a Flash mode.', {
      detail: text.slice(0, 300),
      ...(until !== undefined ? { cooldownUntilMs: until } : {}),
    });
  }
```

In `classifyEmptyOutput`, replace the quota branch body so it attaches the same deadline (keeping `retryAfterSec` for the message):

```js
  if (/RESOURCE_EXHAUSTED|quota reached|Individual quota reached/i.test(tail)) {
    const retryAfterSec = parseResetsIn(tail);
    const until = agyCooldownUntilMs(tail);
    return new BridgeError('quota',
      `Antigravity quota for this Google account is exhausted.${retryAfterSec ? ` Resets in ~${Math.ceil(retryAfterSec / 60)} min.` : ''}`,
      {
        detail: 'agy exited 0 with no output; cli.log shows RESOURCE_EXHAUSTED',
        ...(retryAfterSec ? { retryAfterSec } : {}),
        ...(until !== undefined ? { cooldownUntilMs: until } : {}),
      });
  }
```

Update the exports:

```js
module.exports = { createAgyAdapter, CANDIDATE_MODELS, parseResetsIn, parseBaselineRefreshMs, classifyError };
```

- [ ] **Step 4: Run the suite, then the full chain**

Run: `node tests/quota.test.js && npm test`
Expected: PASS everywhere (the Jul-10 silent-quota tests in provider2 keep passing — `retryAfterSec` is untouched).

- [ ] **Step 5: Commit**

```bash
git add packages/adapters/agy.js tests/quota.test.js
git commit -m "feat(agy): parse server reset grammars into breaker deadlines (floored vs the 1s-loop bug)"
```

---

### Task 5: quota.js — normalized parsers (pure functions)

The parsing layer of the new quota module, ported from Orbit OS `accounts.ts` (`parseLimits`) and adapted for agy's `retrieveUserQuotaSummary` shape. Pure functions, no I/O.

**Files:**
- Create: `packages/provider/quota.js`
- Test: `tests/quota.test.js` (append block)

- [ ] **Step 1: Append failing tests**

```js
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/quota.test.js`
Expected: FAIL — `Cannot find module '.../packages/provider/quota.js'`.

- [ ] **Step 3: Create `packages/provider/quota.js` with the parsers**

```js
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
```

(`fs`/`path`/`crypto` are used by Task 6's service — leaving the requires in place now is fine.)

- [ ] **Step 4: Run the suite**

Run: `node tests/quota.test.js`
Expected: PASS through Q5.

- [ ] **Step 5: Commit**

```bash
git add packages/provider/quota.js tests/quota.test.js
git commit -m "feat(quota): normalized limit parsers for claude oauth/usage and agy quota summary"
```

---

### Task 6: quota.js — snapshot service (pollers, persistence, pollSoon)

The stateful half: per-account polling with per-account failure isolation, snapshot persistence across restarts, and an immediate re-poll hook for quota errors.

**Contract:**
- `createQuotaService({ pool, file, pollMinutes, fetchImpl, agyRefresh, claudeUserAgent, logger, onChange })`
- `start()` / `stop()` — interval polling (unref'd), first sweep ~5s after start.
- `pollAll()` — one sweep; never throws.
- `pollSoon(engine, name)` — debounced single-account poll (~1s), for quota-error hooks.
- `get(engine, name)` → `{ limits (effective), takenAt, staleMinutes, source, error }` or `null`.
- Skips: disabled accounts, `needsLogin`, `usageSource: 'reactive'`, implicit accounts (`dir: null`).
- claude 401 ⇒ transient (`error: 'auth-stale'`, keep last snapshot; a real dispatch refreshes the credential file, next poll recovers). claude 403 ⇒ permanent for the process: account marked reactive (setup-token scope).
- agy access token expired ⇒ run injectable `agyRefresh(account)` (production: `agy models` under the account HOME — the CLI refreshes its own token file lazily; no OAuth client secret needed in our code), then re-read the token file once.

**Files:**
- Modify: `packages/provider/quota.js`
- Test: `tests/quota.test.js` (append block)

- [ ] **Step 1: Append failing tests**

```js
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
  }
```

- [ ] **Step 2: Run to verify it fails**

Run: `node tests/quota.test.js`
Expected: FAIL — `createQuotaService` is not a function.

- [ ] **Step 3: Implement the service in `packages/provider/quota.js`**

Append below `effective()` and extend the exports:

```js
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const AGY_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
const AGY_TOKEN_REL = path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token');

// Per-account usage snapshots for the pollable engines. One instance per
// process; accounts with usageSource 'reactive', implicit accounts, and
// engines this module doesn't know stay invisible (their quota knowledge is
// whatever the adapters parse out of limit errors).
function createQuotaService({
  pool,
  file,
  pollMinutes = Number(process.env.QUOTA_POLL_MINUTES) || 5,
  fetchImpl = globalThis.fetch,
  // Production: run `agy models` under the account HOME so the CLI refreshes
  // its own token file (no Google OAuth client secret in our code). Injected
  // for tests; wired in server.js.
  agyRefresh = null,
  claudeUserAgent = process.env.QUOTA_CLAUDE_UA || 'claude-code/2.1.206',
  logger = console,
  onChange = null,
} = {}) {
  const snapshots = new Map(); // 'engine:name' → { limits, takenAt, source, error }
  const reactive = new Set(); // accounts degraded at runtime (403 scope)
  const soonTimers = new Map();
  let interval = null;
  let persistTimer = null;

  // ── persistence ─────────────────────────────────────────────────────────
  try {
    if (file && fs.existsSync(file)) {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) snapshots.set(k, v);
    }
  } catch (err) { logger.error(`[quota] snapshot file unreadable, starting empty: ${err.message}`); }

  const persist = () => {
    if (!file) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try {
        const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(snapshots)));
        fs.renameSync(tmp, file);
      } catch (err) { logger.error(`[quota] persist failed: ${err.message}`); }
    }, 1000);
    persistTimer.unref();
  };

  const record = (engine, name, limits, source, error = null) => {
    const key = `${engine}:${name}`;
    const next = { limits, takenAt: Date.now(), source, ...(error ? { error } : {}) };
    const prev = snapshots.get(key);
    snapshots.set(key, next);
    persist();
    if (typeof onChange === 'function'
      && (!prev || JSON.stringify(prev.limits) !== JSON.stringify(limits) || prev.error !== next.error)) {
      onChange({ engine, account: name, limits: effective(limits), takenAt: next.takenAt, source, error });
    }
  };

  // ── per-engine pollers ──────────────────────────────────────────────────
  async function pollClaude(acct) {
    let token;
    try {
      token = JSON.parse(fs.readFileSync(path.join(acct.dir, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken;
    } catch (_) { return; } // no credential file yet — nothing to poll
    if (!token) return;
    const res = await fetchImpl(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': claudeUserAgent },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 403) {
      // Token lacks the usage scope (setup-token) — permanent for this process.
      reactive.add(`claude:${acct.name}`);
      const prev = snapshots.get(`claude:${acct.name}`);
      if (prev) record('claude', acct.name, prev.limits, 'reactive', 'scope');
      return;
    }
    if (res.status === 401) {
      // Access token stale; a real dispatch refreshes the file. Keep the last
      // snapshot, surface the state.
      const prev = snapshots.get(`claude:${acct.name}`);
      record('claude', acct.name, (prev && prev.limits) || [], 'oauth', 'auth-stale');
      return;
    }
    if (!res.ok) throw new Error(`usage endpoint ${res.status}`);
    record('claude', acct.name, parseClaudeUsage(await res.json()), 'oauth');
  }

  const readAgyToken = (dir) => JSON.parse(fs.readFileSync(path.join(dir, AGY_TOKEN_REL), 'utf8'));

  async function pollAgy(acct) {
    let tok;
    try { tok = readAgyToken(acct.dir); } catch (_) { return; } // no token file yet
    const expired = tok.token && tok.token.expiry && (Date.parse(tok.token.expiry) - Date.now() < 5 * 60 * 1000);
    if (expired && typeof agyRefresh === 'function') {
      try { await agyRefresh(acct); tok = readAgyToken(acct.dir); } catch (_) { /* poll with what we have */ }
    }
    const access = tok.token && tok.token.access_token;
    if (!access) return;
    const res = await fetchImpl(AGY_QUOTA_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 || res.status === 403) {
      const prev = snapshots.get(`gemini:${acct.name}`);
      record('gemini', acct.name, (prev && prev.limits) || [], 'oauth', 'auth-stale');
      return;
    }
    if (!res.ok) throw new Error(`quota summary ${res.status}`);
    record('gemini', acct.name, parseAgyQuotaSummary(await res.json()), 'oauth');
  }

  const POLLERS = { claude: pollClaude, gemini: pollAgy };

  const pollable = (engine, acct) => acct.enabled && !acct.needsLogin && acct.dir
    && acct.usageSource !== 'reactive' && !reactive.has(`${engine}:${acct.name}`);

  async function pollOne(engine, name) {
    const acct = pool.accounts(engine).find((a) => a.name === name);
    if (!acct || !pollable(engine, acct) || !POLLERS[engine]) return;
    try { await POLLERS[engine](acct); } catch (err) {
      logger.error(`[quota] ${engine}:${name} poll failed: ${err.message}`);
    }
  }

  async function pollAll() {
    for (const engine of Object.keys(POLLERS)) {
      let accounts = [];
      try { accounts = pool.accounts(engine); } catch (_) { continue; }
      for (const acct of accounts) {
        if (pollable(engine, acct)) await pollOne(engine, acct.name);
      }
    }
  }

  function pollSoon(engine, name) {
    const key = `${engine}:${name}`;
    if (soonTimers.has(key)) return;
    const t = setTimeout(() => { soonTimers.delete(key); pollOne(engine, name); }, 1000);
    t.unref();
    soonTimers.set(key, t);
  }

  function get(engine, name) {
    const snap = snapshots.get(`${engine}:${name}`);
    if (!snap) return null;
    return {
      limits: effective(snap.limits),
      takenAt: snap.takenAt,
      staleMinutes: Math.round((Date.now() - snap.takenAt) / 60_000),
      source: reactive.has(`${engine}:${name}`) ? 'reactive' : snap.source,
      error: snap.error || null,
    };
  }

  function start() {
    if (interval) return;
    const first = setTimeout(() => { pollAll(); }, 5000);
    first.unref();
    interval = setInterval(pollAll, Math.max(1, pollMinutes) * 60_000);
    interval.unref();
  }

  function stop() {
    clearInterval(interval);
    interval = null;
    clearTimeout(persistTimer);
    for (const t of soonTimers.values()) clearTimeout(t);
    soonTimers.clear();
  }

  return { start, stop, pollAll, pollSoon, get };
}

module.exports = { parseClaudeUsage, parseAgyQuotaSummary, effective, createQuotaService };
```

- [ ] **Step 4: Run the suite**

Run: `node tests/quota.test.js`
Expected: PASS through Q6.

- [ ] **Step 5: Commit**

```bash
git add packages/provider/quota.js tests/quota.test.js
git commit -m "feat(quota): per-account snapshot service — pollers, degradation, persistence, pollSoon"
```

---

### Task 7: Server wiring — boot, SSE, status merge, quota-error hook

**Files:**
- Modify: `packages/provider/server.js` (four spots: require block ~line 13-21, after pool creation ~line 175-195, `/dashboard/status` ~line 589-593, shutdown handler)
- Test: `tests/provider2.test.js` (one assertion in the existing `/dashboard/status` test)

- [ ] **Step 1: Add the failing status assertion**

In `tests/provider2.test.js`, find the existing `/dashboard/status` test (search for `'/dashboard/status'` — the block that asserts on `accounts`). Add immediately after its existing account assertions:

```js
  assert(Object.prototype.hasOwnProperty.call(sBody.accounts.claude[0], 'quota'),
    'status accounts carry a quota field (null until first poll)');
```

(Adapt `sBody` to whatever that block names its parsed response.)

Run: `node tests/provider2.test.js`
Expected: FAIL on the new assertion.

- [ ] **Step 2: Wire the service in `server.js`**

With the other provider requires (~line 21):

```js
const { createQuotaService } = require('./quota');
```

After the pool is created and `RUNTIME_DIR` exists (below the `pool = createAccountPool({...})` block, ~line 190):

```js
// Per-account subscription-usage snapshots (Phase 1, router spec §5). The
// poller is advisory: any failure degrades one account's freshness, never
// dispatch. BRIDGE_QUOTA_POLL=0 disables the interval (tests, air-gapped).
const quota = createQuotaService({
  pool,
  file: path.join(RUNTIME_DIR, 'quota-snapshots.json'),
  agyRefresh: (acct) => runCli(process.env.GEMINI_PATH || process.env.AGY_PATH || 'agy', ['models'], {
    timeoutMs: 15_000, maxBytes: 256 * 1024, env: { ...process.env, HOME: acct.dir },
  }),
  onChange: (ev) => events.emit('quota.change', ev),
});
if (process.env.BRIDGE_QUOTA_POLL !== '0') quota.start();
```

`runCli` — confirm it is already imported from `@bridge/core` at the top of server.js (`grep "runCli" packages/provider/server.js`); if not, add it to that require.

In the pool's existing `onChange` handler (~line 193, the one that emits `account.change`), add:

```js
    // A quota-tripped breaker is the freshest possible signal — re-poll that
    // account now so the dashboard and (Phase 2) selection see real numbers.
    if (ev.kind === 'breaker' && ev.breaker && ev.breaker.state === 'open' && ev.breaker.reason === 'quota') {
      quota.pollSoon(ev.engine, ev.account);
    }
```

Note: the pool is created before `quota` exists — JS closures make this safe only if the handler runs after boot. Since breaker events only fire on request feedback (never during construction), referencing `quota` inside the callback is fine; if the linter complains about use-before-define, declare `let quota` above the pool block and assign after.

In `/dashboard/status` (~line 589-593), inside the loop that decorates each account with `identity`, add:

```js
      a.quota = quota.get(e, a.name);
```

In the shutdown path (search for `SIGTERM` or the graceful-shutdown block), add `quota.stop();` alongside the other teardown calls.

- [ ] **Step 3: Run provider2, then the full suite**

First, make the test boots deterministic: in `tests/provider2.test.js`, find the `bootProvider` helper (search `function bootProvider`) and add `BRIDGE_QUOTA_POLL: '0'` to the base env it passes to every spawned server — booted test servers must never run the interval poller (a test that ever seeds a real-looking credential file must not reach the network).

Run: `node tests/provider2.test.js && npm test`
Expected: PASS.

Note on spec §7's "schedule one usage poll at resetsAt to confirm": no extra machinery — `effective()` already reads a past-reset window as fresh, and the 5-minute interval sweep re-polls the authoritative numbers within one cycle of the reset. The `pollSoon` hook here covers the moment the breaker *opens*; the sweep covers the moment it should *close*.

- [ ] **Step 4: Commit**

```bash
git add packages/provider/server.js tests/provider2.test.js
git commit -m "feat(server): quota service wired — boot poller, quota.change SSE, status merge, breaker hook"
```

---

### Task 8: Dashboard — usage bars on account cards

Static files, no test suite — verified by curl + browser smoke.

**Files:**
- Modify: `packages/provider/dashboard/app.js` (SSE list ~line 104, `renderAccounts` ~line 291-336)
- Modify: `packages/provider/dashboard/styles.css`

- [ ] **Step 1: Subscribe to quota events**

In the SSE event list (line ~104), add `'quota.change'` to the array (same refresh handler as `account.change`).

- [ ] **Step 2: Render the bars**

Add a helper near `accountState` (~line 284):

```js
  function fmtEta(ts) {
    var ms = ts - Date.now();
    if (ms <= 0) return 'now';
    var m = Math.round(ms / 60000);
    return m < 60 ? 'in ' + m + 'm' : m < 2880 ? 'in ' + Math.round(m / 60) + 'h' : 'in ' + Math.round(m / 1440) + 'd';
  }
  function quotaBars(a) {
    var q = a.quota;
    if (!q || !q.limits || !q.limits.length) {
      return a.usageSource === 'reactive' ? '<div class="sub2">usage: reactive (no polling)</div>' : '';
    }
    var rows = q.limits.map(function (l) {
      var pct = Math.max(0, Math.min(100, Math.round(l.percent)));
      var cls = pct >= 90 ? ' crit' : pct >= 70 ? ' warn' : '';
      var reset = l.resetsAt ? 'resets ' + fmtEta(l.resetsAt) : '';
      return '<div class="qrow"><span class="qlabel">' + esc(l.label) + '</span>'
        + '<span class="qbar"><span class="qfill' + cls + '" style="width:' + pct + '%"></span></span>'
        + '<span class="qpct">' + pct + '%</span> <span class="sub2">' + esc(reset) + '</span></div>';
    }).join('');
    var meta = (q.source || 'polled') + (q.staleMinutes != null ? ' · ' + q.staleMinutes + 'm ago' : '')
      + (q.error ? ' · ' + q.error : '');
    return '<div class="qbars">' + rows + '<div class="sub2">' + esc(meta) + '</div></div>';
  }
```

In `renderAccounts`'s card template (the string concatenation around line 309-323), insert `+ quotaBars(a)` after the usage/month line and before the needs-login block.

- [ ] **Step 3: Style the bars**

Append to `styles.css` (reuse the existing palette variables — check the top of the file for the accent/warn/danger custom properties and use those names):

```css
/* Accounts tab — per-window quota bars (router Phase 1) */
.qbars { margin-top: 8px; display: grid; gap: 4px; }
.qrow { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.qlabel { min-width: 110px; color: var(--text-2, #9aa3b2); }
.qbar { flex: 1; height: 6px; border-radius: 3px; background: var(--bg-3, #23262e); overflow: hidden; }
.qfill { display: block; height: 100%; border-radius: 3px; background: var(--accent, #5b8def); }
.qfill.warn { background: var(--warn, #d9a03f); }
.qfill.crit { background: var(--danger, #d95c4a); }
.qpct { min-width: 36px; text-align: right; font-variant-numeric: tabular-nums; }
```

- [ ] **Step 4: Smoke it locally**

```bash
BRIDGE_QUOTA_POLL=0 node packages/provider/server.js &
sleep 1
curl -s localhost:9011/dashboard/status | head -c 400   # expect "quota": null on accounts (or gated 401 if DASHBOARD_AUTH=1 — then check via the login flow)
kill %1
```

Then open `http://localhost:9011/dashboard/` → Accounts tab renders without errors (bars absent until a real poll — correct).

- [ ] **Step 5: Commit**

```bash
git add packages/provider/dashboard/app.js packages/provider/dashboard/styles.css
git commit -m "feat(dashboard): per-window quota bars on account cards (quota.change SSE)"
```

---

### Task 9: Docker agy floor, docs, full verification

agy 1.0.16 (currently on the NAS) swallows server errors in `--print` mode — everything in Tasks 4-6 depends on ≥1.1.1 there. The installer fetches latest, so the fix is an image-build assertion plus a rebuild note.

**Files:**
- Modify: `deploy/Dockerfile:22-24`
- Modify: `docs/STATE.md` (status entry)

- [ ] **Step 1: Version-floor the agy install**

Replace the install RUN (lines 22-24) with:

```dockerfile
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /usr/local/bin \
    && test -x /usr/local/bin/agy \
    && /usr/local/bin/agy --version \
    # agy < 1.1.1 exits 0 with EMPTY output on server errors in --print mode —
    # the bridge's quota detection is blind on those builds. Fail the build
    # rather than ship a blind image.
    && AGY_V=$(/usr/local/bin/agy --version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1) \
    && printf '%s\n1.1.1\n' "$AGY_V" | sort -V | head -1 | grep -qx '1.1.1'
```

- [ ] **Step 2: Sanity-check the version comparison logic**

Run: `printf '%s\n1.1.1\n' "1.0.16" | sort -V | head -1` → expect `1.0.16` (build would fail).
Run: `printf '%s\n1.1.1\n' "1.2.0" | sort -V | head -1` → expect `1.1.1` (build passes).

- [ ] **Step 3: Update STATE.md**

Add a Current Status entry (top of the list) summarizing: router Phase 1 shipped — quota snapshot service (claude oauth/usage + agy quota summary), reset-precise single-strike quota breakers, claude mid-stream limit detection (#68816) + server-throttle exclusion, agy reset grammars, Accounts-tab usage bars, Dockerfile agy ≥1.1.1 floor; note the NAS needs an image rebuild to pick it up; point at the spec + this plan.

- [ ] **Step 4: Full verification**

Run: `npm test`
Expected: all 7 suites green.

- [ ] **Step 5: Commit**

```bash
git add deploy/Dockerfile docs/STATE.md
git commit -m "build(deploy): fail the image build on agy <1.1.1 (blind to quota errors); Phase 1 state notes"
```

---

## Out of scope for this plan (later phases)

Headroom-aware selection order (Phase 2 — this plan only *collects* the data), Orbit account import (Phase 2), codex engine (Phase 3), auto-routes/rules/key flags (Phase 4), NAS rebuild + live smokes (Phase 5). Do not implement selection changes here even though the snapshots make it tempting — Phase 2 has its own plan and tests.
