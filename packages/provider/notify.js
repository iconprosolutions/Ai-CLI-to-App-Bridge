'use strict';

// Webhook alerting — the operator's pager for a self-hosted bridge. POSTs a
// short message to BRIDGE_WEBHOOK_URL when something needs a human: an
// account breaker opens (quota/timeouts), an account needs a fresh login, an
// engine health check starts failing (and when it recovers), a key nears its
// budget. Dollars here are fiction — quota/login failure is the real outage
// mode, so these four signals cover the operational surface.
//
// Payload format auto-detects from the URL (Slack / Discord / ntfy), or set
// BRIDGE_WEBHOOK_FORMAT=slack|discord|ntfy|json explicitly. Transition-aware
// with a per-event cooldown so a flapping breaker can't flood the channel.
// No URL configured → disabled, zero overhead.

function detectFormat(url) {
  try {
    const host = new URL(url).host;
    if (/(^|\.)slack\.com$/.test(host)) return 'slack';
    if (/(^|\.)discord(app)?\.com$/.test(host)) return 'discord';
    if (/(^|\.)ntfy\./.test(host) || host === 'ntfy.sh') return 'ntfy';
  } catch (_) { /* fall through */ }
  return 'json';
}

function createNotifier({
  url = '',
  format = '',
  cooldownMs = 5 * 60 * 1000,
  fetchImpl = null,
  logger = console,
  name = 'ai-cli-bridge',
} = {}) {
  const enabled = Boolean(url);
  const fmt = format || (enabled ? detectFormat(url) : 'json');
  const doFetch = fetchImpl || fetch;
  const lastSent = new Map(); // dedupe key → last-sent ts (cooldown window)
  const lastHealth = new Map(); // engine → last ok (transition tracking)
  const stats = { sent: 0, suppressed: 0, failed: 0 };

  function post(message, detail) {
    let body;
    let headers = { 'Content-Type': 'application/json' };
    if (fmt === 'slack') body = JSON.stringify({ text: message });
    else if (fmt === 'discord') body = JSON.stringify({ content: message });
    else if (fmt === 'ntfy') { body = message; headers = { Title: `${name} alert`, 'Content-Type': 'text/plain' }; }
    else body = JSON.stringify({ source: name, message, detail: detail || null, at: new Date().toISOString() });
    return doFetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) })
      .then((r) => {
        if (r && r.ok === false) throw new Error(`HTTP ${r.status}`);
        stats.sent += 1;
      })
      .catch((err) => {
        stats.failed += 1;
        logger.warn(`[notify] webhook post failed: ${err.message}`);
      });
  }

  // Send once per `key` per cooldown window. Returns the post promise (so
  // tests can await delivery) or null when disabled/suppressed.
  function send(key, message, detail) {
    if (!enabled) return null;
    const now = Date.now();
    if (now - (lastSent.get(key) || 0) < cooldownMs) {
      stats.suppressed += 1;
      return null;
    }
    lastSent.set(key, now);
    return post(message, detail);
  }

  // Event-bus listener — speaks the bridge's own event vocabulary.
  function handle(type, data) {
    if (!enabled || !data) return;
    if (type === 'account.change') {
      const acct = `${data.engine}:${data.account}`;
      if (data.kind === 'breaker' && data.breaker) {
        if (data.breaker.state === 'open') {
          const retry = data.breaker.retryInSec ? ` — retries in ~${data.breaker.retryInSec}s` : '';
          send(`breaker:${acct}`, `🔴 ${acct} breaker OPEN (${data.breaker.reason || 'failures'})${retry}`, data.breaker);
        } else if (data.breaker.state === 'closed' && lastSent.has(`breaker:${acct}`)) {
          // Only announce recovery for accounts we alerted about.
          send(`breaker-ok:${acct}`, `🟢 ${acct} breaker closed — account healthy again`);
        }
      } else if (data.kind === 'needs-login') {
        send(`login:${acct}`, `🔐 ${acct} needs login — re-authenticate from the dashboard Accounts tab, then Probe`);
      }
    } else if (type === 'engine.health' && typeof data.ok === 'boolean') {
      const prev = lastHealth.get(data.engine);
      lastHealth.set(data.engine, data.ok);
      if (prev === undefined) return; // first sample is the baseline, not a transition
      if (prev && !data.ok) send(`health:${data.engine}`, `🟠 engine "${data.engine}" health check failing: ${data.detail || 'no detail'}`);
      else if (!prev && data.ok) send(`health-ok:${data.engine}`, `🟢 engine "${data.engine}" healthy again`);
    } else if (type === 'budget.warning') {
      send(`budget:${data.keyName}:${data.reason}`,
        `⚠️ key "${data.keyName}" is at ${data.pct}% of its ${data.reason} budget (${data.used} of ${data.limit})`);
    }
  }

  return {
    enabled,
    format: fmt,
    handle,
    send,
    stats: () => ({ ...stats }),
  };
}

module.exports = { createNotifier, detectFormat };
