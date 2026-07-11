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
