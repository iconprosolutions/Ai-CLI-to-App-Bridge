'use strict';

const crypto = require('crypto');
const express = require('express');

// Control-plane endpoints backing the dashboard's buttons. ALWAYS behind the
// bearer key — even when /v1 auth is open — because these mutate state and
// can spend quota (probe). With no key configured at all, admin is disabled.
function createAdminRouter({
  apiKey, registry, pool, adapters, activeRequests, capture, events, enginesDisabled,
}) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!apiKey) {
      return res.status(503).json({ error: 'Admin API disabled: no PROVIDER_API_KEY configured.' });
    }
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const a = Buffer.from(token);
    const b = Buffer.from(apiKey);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return next();
  });

  const engineOr404 = (req, res) => {
    const engine = req.params.engine;
    if (!adapters[engine]) {
      res.status(404).json({ error: `Unknown engine "${engine}"` });
      return null;
    }
    return engine;
  };

  // ── Live requests ──────────────────────────────────────────────────────
  router.post('/requests/:id/kill', (req, res) => {
    const entry = activeRequests.get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'No active request with that id' });
    entry.killedByAdmin = true;
    entry.ac.abort();
    return res.json({ killed: true, id: req.params.id });
  });

  // ── Breakers ───────────────────────────────────────────────────────────
  router.post('/breakers/:engine/reset', (req, res) => {
    const engine = engineOr404(req, res);
    if (!engine) return undefined;
    pool.resetBreakers(engine);
    return res.json({ engine, breaker: pool.engineBreakerStatus(engine) });
  });

  // ── Accounts ───────────────────────────────────────────────────────────
  // Probe spends one tiny prompt on the account; success clears needs-login
  // and closes its breaker — the recovery path after an operator re-login.
  router.post('/accounts/:engine/:name/probe', async (req, res) => {
    const engine = engineOr404(req, res);
    if (!engine) return undefined;
    const acct = pool.accounts(engine).find((a) => a.name === req.params.name);
    if (!acct) return res.status(404).json({ error: `Unknown account "${engine}:${req.params.name}"` });
    try {
      const out = await adapters[engine].invoke({ prompt: 'Reply with exactly: OK', env: pool.envFor(engine, acct) });
      pool.clearNeedsLogin(engine, acct.name);
      pool.feedback(engine, acct, null);
      return res.json({ engine, account: acct.name, ok: true, sample: String(out.text).slice(0, 40) });
    } catch (err) {
      pool.feedback(engine, acct, err);
      return res.status(502).json({ engine, account: acct.name, ok: false, error: err.message, kind: err.kind || null });
    }
  });

  // ── Engines ────────────────────────────────────────────────────────────
  router.post('/engines/:engine/probe', async (req, res) => {
    const engine = engineOr404(req, res);
    if (!engine) return undefined;
    const models = await adapters[engine].listModels({ refresh: true });
    return res.json({ engine, models });
  });

  router.post('/engines/:engine/disable', (req, res) => {
    const engine = engineOr404(req, res);
    if (!engine) return undefined;
    enginesDisabled[engine] = true;
    events.emit('engine.health', { engine, disabled: true });
    return res.json({ engine, disabled: true });
  });

  router.post('/engines/:engine/enable', (req, res) => {
    const engine = engineOr404(req, res);
    if (!engine) return undefined;
    enginesDisabled[engine] = false;
    events.emit('engine.health', { engine, disabled: false });
    return res.json({ engine, disabled: false });
  });

  // ── Routes (mutations persist to routes.json, validated, hot-applied) ──
  const routeMutation = (res, mutate) => {
    try {
      const next = registry.update(mutate);
      return res.json({ ok: true, routes: next.routes.map((r) => r.id), defaultRoute: next.defaultRoute });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  };

  router.post('/routes', (req, res) => {
    const route = req.body || {};
    routeMutation(res, (next) => {
      next.routes.push({ enabled: true, aliases: [], ...route });
    });
  });

  router.put('/routes/:id', (req, res) => {
    const patch = req.body || {};
    routeMutation(res, (next) => {
      const r = next.routes.find((x) => x.id === req.params.id);
      if (!r) throw new Error(`Unknown route "${req.params.id}"`);
      // id is immutable; everything else can be patched.
      for (const [k, v] of Object.entries(patch)) {
        if (k !== 'id') r[k] = v;
      }
    });
  });

  router.delete('/routes/:id', (req, res) => {
    routeMutation(res, (next) => {
      const i = next.routes.findIndex((x) => x.id === req.params.id);
      if (i === -1) throw new Error(`Unknown route "${req.params.id}"`);
      if (next.defaultRoute === req.params.id) throw new Error('Cannot delete the default route; change defaultRoute first.');
      next.routes.splice(i, 1);
    });
  });

  // ── Capture ────────────────────────────────────────────────────────────
  router.get('/capture', (req, res) => {
    res.json({ enabled: capture.enabled, count: capture.size, requests: capture.list() });
  });

  router.post('/capture', (req, res) => {
    const enabled = capture.setEnabled(Boolean(req.body && req.body.enabled));
    events.emit('capture.change', { enabled });
    res.json({ enabled });
  });

  router.get('/capture/:id', (req, res) => {
    const entry = capture.get(req.params.id);
    if (!entry) return res.status(404).json({ error: 'Not captured (buffer holds the last 50 while capture is on)' });
    return res.json(entry);
  });

  return router;
}

module.exports = { createAdminRouter };
