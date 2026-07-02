'use strict';

// Per-engine circuit breaker. Opens on consecutive quota (2) or timeout (3)
// failures so a known-exhausted engine fails fast with Retry-After instead
// of spawning doomed CLI runs and burning retries. Half-open admits exactly
// one trial after the cool-down; its outcome closes or reopens the circuit.
function createBreaker({
  engine,
  quotaThreshold = 2,
  timeoutThreshold = 3,
  quotaCooldownMs = 15 * 60 * 1000,
  timeoutCooldownMs = 2 * 60 * 1000,
  onChange = null,
} = {}) {
  let state = 'closed'; // closed | open | half-open
  let reason = null; // quota | timeout
  let quotaStreak = 0;
  let timeoutStreak = 0;
  let openedAt = 0;
  let cooldownMs = 0;
  let trialInFlight = false;

  const change = (next) => {
    if (state === next) return;
    state = next;
    if (typeof onChange === 'function') onChange(status());
  };

  function allow() {
    if (state === 'closed') return { allowed: true };
    const elapsed = Date.now() - openedAt;
    if (state === 'open') {
      if (elapsed < cooldownMs) {
        return { allowed: false, reason, retryInSec: Math.max(1, Math.ceil((cooldownMs - elapsed) / 1000)) };
      }
      change('half-open');
      trialInFlight = false;
    }
    // half-open: admit exactly one probe at a time.
    if (trialInFlight) {
      return { allowed: false, reason, retryInSec: 5 };
    }
    trialInFlight = true;
    return { allowed: true, trial: true };
  }

  function recordSuccess() {
    quotaStreak = 0;
    timeoutStreak = 0;
    trialInFlight = false;
    if (state !== 'closed') {
      reason = null;
      change('closed');
    }
  }

  function recordFailure(kind) {
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
      openedAt = Date.now();
      change('open');
    }
  }

  function reset() {
    quotaStreak = 0;
    timeoutStreak = 0;
    trialInFlight = false;
    reason = null;
    change('closed');
  }

  function status() {
    const elapsed = Date.now() - openedAt;
    return {
      engine,
      state,
      reason,
      openedAt: state !== 'closed' ? new Date(openedAt).toISOString() : null,
      retryInSec: state === 'open' ? Math.max(0, Math.ceil((cooldownMs - elapsed) / 1000)) : 0,
    };
  }

  return { allow, recordSuccess, recordFailure, reset, status };
}

module.exports = { createBreaker };
