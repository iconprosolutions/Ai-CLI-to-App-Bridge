'use strict';

const { BridgeError } = require('@bridge/core');

// Per-engine concurrency gate with a small bounded FIFO wait queue: bursts
// wait briefly for the slot instead of instantly 429ing, without violating
// the one-CLI-at-a-time subscription constraint. Depth 0 restores the old
// instant-reject behavior.
function createSemaphore({ max = 1, queueDepth = 4, queueTimeoutMs = 30000 } = {}) {
  let active = 0;
  const waiters = [];

  const busyError = () => {
    const err = new Error('engine busy');
    err.busy = true;
    return err;
  };

  function dispatch() {
    while (active < max && waiters.length > 0) {
      const w = waiters.shift();
      w.cleanup();
      active += 1;
      w.resolve(release);
    }
  }

  function release() {
    active -= 1;
    dispatch();
  }

  function acquire(signal) {
    if (signal && signal.aborted) {
      return Promise.reject(new BridgeError('aborted', 'Request aborted while waiting for an engine slot'));
    }
    if (active < max) {
      active += 1;
      return Promise.resolve(release);
    }
    if (waiters.length >= queueDepth) {
      return Promise.reject(busyError());
    }
    return new Promise((resolve, reject) => {
      const w = { resolve, cleanup: () => {} };
      const timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i !== -1) waiters.splice(i, 1);
        w.cleanup();
        reject(busyError());
      }, queueTimeoutMs);
      timer.unref();
      const onAbort = () => {
        const i = waiters.indexOf(w);
        if (i !== -1) waiters.splice(i, 1);
        w.cleanup();
        reject(new BridgeError('aborted', 'Request aborted while queued'));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      w.cleanup = () => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      waiters.push(w);
    });
  }

  return {
    acquire,
    get active() { return active; },
    get queued() { return waiters.length; },
  };
}

module.exports = { createSemaphore };
