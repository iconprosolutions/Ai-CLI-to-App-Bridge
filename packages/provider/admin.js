'use strict';

const express = require('express');

// Control-plane endpoints backing the dashboard's buttons. ALWAYS behind an
// admin-role key — even when /v1 auth is open — because these mutate state and
// can spend quota (probe). App-role keys are rejected with 403. With no key
// configured at all, admin is disabled.
function createAdminRouter({
  keyStore, registry, pool, adapters, activeRequests, capture, events, enginesDisabled, limitGuard,
  userStore, ledger, sessionUser,
}) {
  const router = express.Router();

  router.use((req, res, next) => {
    // A signed-in admin session authorizes exactly like an admin key, so the
    // dashboard works after login without pasting the key.
    const su = sessionUser ? sessionUser(req) : null;
    if (su && su.role === 'admin') {
      req.auth = { name: `user:${su.username}`, role: 'admin' };
      return next();
    }
    if (!keyStore.authEnabled) {
      return res.status(503).json({ error: 'Admin API disabled: no API key configured.' });
    }
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const who = keyStore.verify(token);
    if (!who) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (who.role !== 'admin') {
      return res.status(403).json({ error: 'Admin role required for this endpoint.' });
    }
    req.auth = who;
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

  // Runtime enable/disable of a pooled account (in-memory; accounts.json wins on reload).
  router.post('/accounts/:engine/:name/:op(enable|disable)', (req, res) => {
    const engine = engineOr404(req, res);
    if (!engine) return undefined;
    const enabled = req.params.op === 'enable';
    const acct = pool.setEnabled(engine, req.params.name, enabled);
    if (!acct) return res.status(404).json({ error: `Unknown account "${engine}:${req.params.name}"` });
    events.emit('account.change', { kind: 'enabled', engine, account: acct.name, enabled });
    return res.json({ engine, account: acct.name, enabled });
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

  // ── Named API keys ───────────────────────────────────────────────────────
  // list() never returns secret values; mint returns the new secret exactly
  // once (never retrievable afterward). Admin-role gate is enforced above.
  router.get('/keys', (req, res) => {
    // Each key carries its limits plus live consumption so the dashboard can
    // show "used X of Y today" without a second round-trip.
    const keys = keyStore.list().map((k) => ({
      ...k,
      usage: limitGuard ? limitGuard.snapshot(k.name) : undefined,
    }));
    res.json({ keys });
  });

  router.post('/keys', (req, res) => {
    const body = req.body || {};
    try {
      const rec = keyStore.mint({ name: body.name, role: body.role, accountPin: body.accountPin, limits: body.limits });
      events.emit('keys.change', { action: 'mint', name: rec.name, role: rec.role });
      return res.json({
        name: rec.name, role: rec.role, accountPin: rec.accountPin || null, limits: rec.limits || null, createdAt: rec.createdAt, key: rec.key,
      });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  // Update a key's limits (body: { limits: { rpm?, tokensPerDay?, usdPerMonth? } };
  // null/{} clears them). Secret and role are immutable — revoke + re-mint.
  router.patch('/keys/:name', (req, res) => {
    try {
      const rec = keyStore.setLimits(req.params.name, (req.body || {}).limits);
      events.emit('keys.change', { action: 'limits', name: rec.name });
      return res.json(rec);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  router.delete('/keys/:name', (req, res) => {
    try {
      keyStore.revoke(req.params.name);
      events.emit('keys.change', { action: 'revoke', name: req.params.name });
      return res.json({ revoked: true, name: req.params.name });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  // ── User management (SaaS mode) ──────────────────────────────────────────
  // Users own API keys; deleting a user revokes their keys and sessions.
  router.get('/users', async (req, res) => {
    const [today, month] = await Promise.all([
      ledger.aggregate('today', { ownerOf: keyStore.ownerOf }),
      ledger.aggregate('month', { ownerOf: keyStore.ownerOf }),
    ]);
    const rollup = (list, name) => (list || []).find((u) => u.user === name) || {};
    const users = userStore.list().map((u) => ({
      ...u,
      keys: keyStore.listByOwner(u.username).map((k) => k.name),
      usageToday: rollup(today.perUser, u.username),
      usageMonth: rollup(month.perUser, u.username),
    }));
    res.json({ users });
  });

  router.post('/users', (req, res) => {
    try {
      const rec = userStore.create(req.body || {});
      events.emit('users.change', { action: 'create', username: rec.username });
      return res.json(rec);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  router.patch('/users/:username', (req, res) => {
    try {
      const rec = userStore.update(req.params.username, req.body || {});
      events.emit('users.change', { action: 'update', username: rec.username });
      return res.json(rec);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  router.delete('/users/:username', (req, res) => {
    try {
      const owned = keyStore.listByOwner(req.params.username);
      userStore.remove(req.params.username); // throws first if unknown / last admin
      for (const k of owned) {
        try { keyStore.revoke(k.name); } catch (_) { /* last-admin-key guard */ }
      }
      events.emit('users.change', { action: 'delete', username: req.params.username });
      return res.json({ deleted: true, username: req.params.username, revokedKeys: owned.map((k) => k.name) });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createAdminRouter };
