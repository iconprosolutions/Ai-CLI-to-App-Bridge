'use strict';

// SSE event bus for the dashboard: request lifecycle, breaker transitions,
// health samples, capture toggles. One held connection per dashboard tab;
// EventSource reconnects automatically (retry hint below).
function createEventBus({ pingMs = 15000 } = {}) {
  const clients = new Set();
  // In-process listeners (webhook notifier, future consumers). Unlike SSE
  // clients these always receive events — alerting must work precisely when
  // no dashboard tab is watching.
  const listeners = new Set();

  const ping = setInterval(() => {
    for (const res of clients) {
      if (!res.writableEnded) res.write(': ping\n\n');
    }
  }, pingMs);
  ping.unref();

  function handler(req, res) {
    res.status(200);
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  }

  function emit(type, data) {
    for (const fn of listeners) {
      try { fn(type, data); } catch (_) { /* a listener must never break emit */ }
    }
    if (!clients.size) return;
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      if (!res.writableEnded) res.write(payload);
    }
  }

  function on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { handler, emit, on, get clientCount() { return clients.size; } };
}

module.exports = { createEventBus };
