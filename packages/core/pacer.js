'use strict';

// Smooth token pacer: splits upstream text flushes into word-ish tokens and
// emits them on a short interval so chunky CLI paragraph flushes stream
// naturally. Invariants:
//   - Lossless: the concatenation of emitted tokens equals the pushed text.
//   - Bounded: total added delay per response never exceeds maxTotalDelayMs,
//     however large the flush (delay adapts down as the queue grows).
//   - Stoppable: stop() drops the queue and unblocks drain() — wired to
//     client aborts so we never keep writing to a dead response.
function createSmoothPacer(onToken, opts = {}) {
  const delayMs = opts.delayMs === undefined ? 10 : opts.delayMs;
  const maxTotalDelayMs = opts.maxTotalDelayMs === undefined ? 2000 : opts.maxTotalDelayMs;
  const queue = [];
  let processing = false;
  let stopped = false;
  let budgetLeft = maxTotalDelayMs; // hard cap on total added delay per response

  const currentDelay = () => {
    if (delayMs <= 0 || queue.length === 0 || budgetLeft <= 0) return 0;
    return Math.min(delayMs, Math.max(0, Math.floor(budgetLeft / queue.length)));
  };

  const processQueue = async () => {
    if (processing) return;
    processing = true;
    while (queue.length > 0 && !stopped) {
      onToken(queue.shift());
      const d = currentDelay();
      if (d > 0 && queue.length > 0) {
        budgetLeft -= d;
        await new Promise((r) => setTimeout(r, d));
      }
    }
    if (stopped) queue.length = 0;
    processing = false;
  };

  return {
    push(text) {
      if (!text || stopped) return;
      // Every char is either \s or \S, so this can never drop characters.
      const tokens = String(text).match(/\s+|\S+/g) || [String(text)];
      queue.push(...tokens);
      processQueue();
    },
    stop() {
      stopped = true;
      queue.length = 0;
    },
    async drain() {
      while (!stopped && (processing || queue.length > 0)) {
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

module.exports = { createSmoothPacer };
