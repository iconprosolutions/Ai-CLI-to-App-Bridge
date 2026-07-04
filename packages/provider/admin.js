'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Control-plane endpoints backing the dashboard's buttons. ALWAYS behind an
// admin-role key — even when /v1 auth is open — because these mutate state and
// can spend quota (probe). App-role keys are rejected with 403. With no key
// configured at all, admin is disabled.
function createAdminRouter({
  keyStore, registry, pool, adapters, activeRequests, capture, events, enginesDisabled, limitGuard,
  userStore, ledger, sessionUser, accountsFile,
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
      const rec = keyStore.mint({ name: body.name, role: body.role, accountPin: body.accountPin, limits: body.limits, pinMode: body.pinMode });
      events.emit('keys.change', { action: 'mint', name: rec.name, role: rec.role });
      return res.json({
        name: rec.name, role: rec.role, accountPin: rec.accountPin || null, pinMode: rec.pinMode || null, limits: rec.limits || null, createdAt: rec.createdAt, key: rec.key,
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

  // ── Account onboarding from the dashboard (no terminal) ──────────────────
  // claude: paste the sk-ant-oat… token that `claude setup-token` prints
  // (run it on ANY machine with the claude CLI — the browser step happens
  // there). gemini: paste the JSON contents of
  // ~/.gemini/antigravity-cli/antigravity-oauth-token from a machine where agy
  // is signed in. Files land in the runtime volume; accounts.json hot-reloads.
  const ACCT_NAME_RE = /^[A-Za-z0-9._-]+$/;
  function writeFileAtomic(file, data, mode) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, data, { mode: mode || 0o600 });
    fs.renameSync(tmp, file);
  }

  router.post('/accounts/:engine', (req, res) => {
    const engine = engineOr404(req, res);
    if (!engine || !accountsFile) return;
    const body = req.body || {};
    const name = String(body.name || '').trim();
    if (!ACCT_NAME_RE.test(name)) {
      return res.status(400).json({ error: 'Account name must be letters, digits, . _ -' });
    }
    const baseDir = path.dirname(accountsFile);
    const dir = path.join(baseDir, 'accounts', engine, name);
    try {
      if (engine === 'claude') {
        const token = String(body.token || '').trim();
        if (!token.startsWith('sk-ant-')) {
          return res.status(400).json({ error: 'Paste the sk-ant-oat… token printed by `claude setup-token`.' });
        }
        const expiresAt = (Math.floor(Date.now() / 1000) + 365 * 24 * 3600) * 1000; // tokens are issued for 1 year
        writeFileAtomic(path.join(dir, '.credentials.json'), JSON.stringify({
          claudeAiOauth: { accessToken: token, expiresAt, scopes: ['user:inference'], subscriptionType: 'external' },
        }));
        if (!fs.existsSync(path.join(dir, '.claude.json'))) {
          writeFileAtomic(path.join(dir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
        }
      } else {
        let tok = body.oauthToken;
        if (typeof tok === 'string') {
          try { tok = JSON.parse(tok); } catch (_) {
            return res.status(400).json({ error: 'oauthToken must be the JSON contents of ~/.gemini/antigravity-cli/antigravity-oauth-token' });
          }
        }
        if (!tok || typeof tok.token !== 'string') {
          return res.status(400).json({ error: 'oauthToken is missing its "token" field — copy the whole file contents.' });
        }
        writeFileAtomic(path.join(dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), JSON.stringify(tok));
        if (body.email) {
          writeFileAtomic(path.join(dir, '.gemini', 'google_accounts.json'), JSON.stringify({ active: String(body.email) }));
        }
      }

      const rel = registerAccount(engine, name);
      return res.json({ ok: true, engine, name, dir: rel });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Register an onboarded account dir in accounts.json + hot-reload the pool.
  function registerAccount(engine, name) {
    let doc = {};
    try { doc = JSON.parse(fs.readFileSync(accountsFile, 'utf8')); } catch (_) { doc = {}; }
    if (!Array.isArray(doc[engine])) doc[engine] = [];
    const rel = `accounts/${engine}/${name}`;
    if (!doc[engine].some((a) => a && a.name === name)) {
      doc[engine].push({ name, dir: rel });
      writeFileAtomic(accountsFile, `${JSON.stringify(doc, null, 2)}\n`, 0o644);
    }
    pool.reload();
    events.emit('account.change', { action: 'add', engine, account: name });
    return rel;
  }

  // ── Guided claude browser login (OAuth PKCE) ─────────────────────────────
  // The same authorization-code + PKCE flow `claude setup-token` drives, using
  // Claude Code's public client id — but the dashboard is the terminal: we
  // hand the operator the authorize link, they approve at claude.ai and paste
  // the code back, we exchange it and the account joins the pool. If Anthropic
  // ever changes the flow, the paste-a-token path still works.
  const CLAUDE_OAUTH = {
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    authorize: 'https://claude.ai/oauth/authorize',
    token: 'https://console.anthropic.com/v1/oauth/token',
    redirect: 'https://console.anthropic.com/oauth/code/callback',
    scope: 'org:create_api_key user:profile user:inference',
  };
  const oauthPending = new Map(); // state → { verifier, name, at }

  router.post('/oauth/claude/start', (req, res) => {
    const name = String((req.body || {}).name || '').trim();
    if (!ACCT_NAME_RE.test(name)) {
      return res.status(400).json({ error: 'Account name must be letters, digits, . _ -' });
    }
    for (const [k, v] of oauthPending) { if (Date.now() - v.at > 10 * 60e3) oauthPending.delete(k); }
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');
    oauthPending.set(state, { verifier, name, at: Date.now() });
    const url = `${CLAUDE_OAUTH.authorize}?${new URLSearchParams({
      code: 'true',
      client_id: CLAUDE_OAUTH.clientId,
      response_type: 'code',
      redirect_uri: CLAUDE_OAUTH.redirect,
      scope: CLAUDE_OAUTH.scope,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    })}`;
    res.json({ url, state, expiresInSec: 600 });
  });

  router.post('/oauth/claude/finish', async (req, res) => {
    let { code, state } = req.body || {};
    code = String(code || '').trim();
    if (code.includes('#')) { const [c, s] = code.split('#'); code = c; state = state || s; }
    const pending = oauthPending.get(String(state || ''));
    if (!pending) return res.status(400).json({ error: 'Unknown or expired login attempt — generate a new link.' });
    try {
      const resp = await fetch(CLAUDE_OAUTH.token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code,
          state,
          client_id: CLAUDE_OAUTH.clientId,
          redirect_uri: CLAUDE_OAUTH.redirect,
          code_verifier: pending.verifier,
        }),
      });
      if (!resp.ok) {
        const detail = await resp.text();
        return res.status(502).json({ error: `Token exchange failed (${resp.status}): ${detail.slice(0, 200)}` });
      }
      const tok = await resp.json();
      oauthPending.delete(state);
      const dir = path.join(path.dirname(accountsFile), 'accounts', 'claude', pending.name);
      writeFileAtomic(path.join(dir, '.credentials.json'), JSON.stringify({
        claudeAiOauth: {
          accessToken: tok.access_token,
          refreshToken: tok.refresh_token,
          expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
          scopes: String(tok.scope || CLAUDE_OAUTH.scope).split(' '),
          subscriptionType: (tok.account && tok.account.subscription_type) || 'external',
        },
      }));
      if (!fs.existsSync(path.join(dir, '.claude.json'))) {
        writeFileAtomic(path.join(dir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
      }
      registerAccount('claude', pending.name);
      return res.json({ ok: true, engine: 'claude', name: pending.name });
    } catch (err) {
      return res.status(502).json({ error: `Could not reach the token endpoint: ${err.message}` });
    }
  });

  // Designate an engine's primary account: it takes traffic whenever healthy
  // with a free slot; the others are overflow + failover capacity. Persisted
  // in accounts.json. Body {"unset": true} clears the designation instead.
  router.post('/accounts/:engine/:name/primary', (req, res) => {
    const engine = engineOr404(req, res);
    if (!engine || !accountsFile) return;
    const name = req.params.name;
    try {
      let doc = {};
      try { doc = JSON.parse(fs.readFileSync(accountsFile, 'utf8')); } catch (_) {
        return res.status(400).json({ error: 'No accounts.json yet — add a named account first.' });
      }
      const list = Array.isArray(doc[engine]) ? doc[engine] : [];
      const target = list.find((a) => a && a.name === name);
      if (!target) return res.status(404).json({ error: `Unknown ${engine} account "${name}"` });
      for (const a of list) delete a.primary;
      if (!(req.body || {}).unset) target.primary = true;
      writeFileAtomic(accountsFile, `${JSON.stringify(doc, null, 2)}\n`, 0o644);
      pool.reload();
      events.emit('account.change', { action: 'primary', engine, account: name, primary: !(req.body || {}).unset });
      return res.json({ ok: true, engine, name, primary: !(req.body || {}).unset });
    } catch (err) {
      return res.status(500).json({ error: err.message });
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
