'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');

const {
  httpFor, BridgeError, createSmoothPacer, installGracefulShutdown, intEnv, strEnv,
  extractJson, assertJsonSchema, runCli,
} = require('@bridge/core');
const { createClaudeAdapter, createAgyAdapter } = require('@bridge/adapters');
const { createRouteRegistry } = require('./routes');
const { createAccountPool } = require('./accounts');
const { createQuotaService } = require('./quota');
const { createKeyStore, validateLimits } = require('./keys');
const { createLimitGuard } = require('./limits');
const { createUserStore } = require('./users');
const { createContinuityStore } = require('./continuity');
const { createTelemetry } = require('./telemetry');
const { createUsageLedger } = require('./usage');
const { createEventBus } = require('./events');
const { createCapture } = require('./capture');
const { createAdminRouter } = require('./admin');
const {
  estimateTokens, parseToolCallsFromText, messagesToPrompt, openaiErrorBody, formatContent,
  normalizeStops, applyStopAndMax, createOutputLimiter,
} = require('./translate');

const app = express();

const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const corsOptions = CORS_ORIGINS.length
  ? { origin: (origin, cb) => cb(null, !origin || CORS_ORIGINS.includes(origin)) }
  : {};
app.use(cors(corsOptions));

// ── Security headers + CSRF guard (matters once internet-exposed) ───────
// The tunnel/proxy terminates TLS and forwards over HTTP, so trust
// X-Forwarded-Proto to decide the Secure cookie flag and HSTS.
app.set('trust proxy', true);
function requestIsHttps(req) {
  return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}
// Origins allowed to iframe the dashboard (space-separated, e.g. Orbit hubs).
// Unset = DENY, the safe default for internet-exposed deployments.
const FRAME_ANCESTORS = (process.env.FRAME_ANCESTORS || '').trim();
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  if (FRAME_ANCESTORS) res.set('Content-Security-Policy', `frame-ancestors ${FRAME_ANCESTORS}`);
  else res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  if (requestIsHttps(req)) res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

// CSRF defense-in-depth: cookie-authed state changes must originate from our
// own site. Browsers always send Origin on cross-site POST/PATCH/DELETE, so a
// mismatched Origin is a forged request. API-key callers (Authorization
// header, no cookie) and same-origin requests pass. SameSite=Lax already
// blocks most of this; this is the belt to that suspenders.
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
app.use((req, res, next) => {
  if (!MUTATING.has(req.method)) return next();
  if (req.headers.authorization) return next(); // token auth isn't cookie-riding
  const origin = req.headers.origin;
  if (!origin) return next(); // non-browser client (curl/SDK) — no ambient cookie risk
  let host = null;
  try { host = new URL(origin).host; } catch (_) { host = null; }
  const expected = req.headers['x-forwarded-host'] || req.headers.host;
  if (host && expected && host === expected) return next();
  return res.status(403).json({ error: 'Cross-origin request refused.' });
});
// Body-size limits: /v1 carries whole conversations (large), everything else
// is small control-plane JSON. A tight cap off /v1 shrinks the memory a flood
// of junk POSTs can pin, and oversized bodies get a clean 400 (handler below).
app.use('/v1', express.json({ limit: intEnv('MAX_BODY_BYTES_V1', 10 * 1024 * 1024) }));
app.use(express.json({ limit: intEnv('MAX_BODY_BYTES', 256 * 1024) }));

const PORT = intEnv('PROVIDER_PORT', 9011);
// Bind to loopback by default; opt in to 0.0.0.0 only when you mean to expose it.
const BIND_HOST = strEnv('BIND_HOST', '127.0.0.1');
const API_KEY = process.env.PROVIDER_API_KEY || process.env.BRIDGE_API_KEY || '';
const MAX_CONCURRENT_PER_ENGINE = Math.max(1, intEnv('PROVIDER_MAX_CONCURRENT_PER_ENGINE', 1));

// Named API keys (v2 credentials.json). The env key, if set, is layered on as
// an implicit admin key so the launcher and tests keep working unchanged.
const CREDENTIALS_FILE = process.env.BRIDGE_CREDENTIALS_FILE
  || path.resolve(__dirname, '../../.bridge-runtime/credentials.json');
const keyStore = createKeyStore({ file: CREDENTIALS_FILE, envKey: API_KEY });

// Per-key limits (rpm / tokens-per-day / $-per-month) — enforced on /v1,
// counters seeded from the ledger after boot so restarts keep budgets intact.
const limitGuard = createLimitGuard();

// Dashboard users + sessions (SaaS login layer). First boot with no users
// creates the admin login and prints its password exactly once.
const RUNTIME_DIR = path.dirname(CREDENTIALS_FILE);
const userStore = createUserStore({
  file: process.env.BRIDGE_USERS_FILE || path.join(RUNTIME_DIR, 'users.json'),
  sessionsFile: process.env.BRIDGE_SESSIONS_FILE || path.join(RUNTIME_DIR, 'sessions.json'),
  validateLimits,
});
{
  const boot = userStore.bootstrap();
  if (boot) console.log(`[bridge] dashboard login created — user "${boot.username}" password (change it in the dashboard): ${boot.password}`);
}

// Session cookie helpers. HttpOnly; SameSite=Lax; no Secure flag because the
// origin speaks plain HTTP (TLS terminates at the tunnel/proxy edge).
const SESSION_COOKIE = 'bridge_session';
function sessionUser(req) {
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([0-9a-f]{48})`).exec(String(req.headers.cookie || ''));
  return m ? userStore.resolve(m[1]) : null;
}
function sessionToken(req) {
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([0-9a-f]{48})`).exec(String(req.headers.cookie || ''));
  return m ? m[1] : null;
}
function setSessionCookie(req, res, token, maxAgeSec) {
  // Secure flag when the browser reached us over HTTPS (tunnel/proxy edge),
  // so the session cookie never rides a plaintext hop.
  const secure = requestIsHttps(req) ? ' Secure;' : '';
  res.append('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly;${secure} Path=/; SameSite=Lax; Max-Age=${maxAgeSec}`);
}

// Engines are in-process adapters — no HTTP hop, and every control-plane
// action operates on state this process owns.
const adapters = {
  claude: createClaudeAdapter(),
  gemini: createAgyAdapter(),
};
const ENGINE_NAMES = Object.keys(adapters);

const registry = createRouteRegistry(process.env.BRIDGE_ROUTES_FILE || path.join(__dirname, 'routes.json'));
const telemetry = createTelemetry({ engines: ENGINE_NAMES });
const ledger = createUsageLedger({
  dir: process.env.BRIDGE_USAGE_DIR || path.resolve(__dirname, '../../.bridge-runtime/usage'),
  pricingFile: path.join(__dirname, 'pricing.json'),
});
const SSE_HEARTBEAT_MS = intEnv('SSE_HEARTBEAT_MS', 15000);

// Session continuity: resume a CLI conversation (claude --resume) and send only
// the new turn when a request extends one we already served on the same account.
// Pure accelerator — any mismatch falls back to a full-prompt spawn. BRIDGE_SESSIONS=0 off.
const continuity = createContinuityStore({ formatContent });

const events = createEventBus();
const capture = createCapture({ max: 50 });

// Operator alerting: pushes breaker-open / needs-login / health transitions /
// budget warnings to a webhook (Slack/Discord/ntfy/JSON). No URL → disabled.
const { createNotifier } = require('./notify');
const notifier = createNotifier({
  url: strEnv('BRIDGE_WEBHOOK_URL', ''),
  format: strEnv('BRIDGE_WEBHOOK_FORMAT', ''),
  cooldownMs: intEnv('BRIDGE_WEBHOOK_COOLDOWN_MS', 5 * 60 * 1000),
});
if (notifier.enabled) {
  events.on(notifier.handle);
  console.log(`[notify] webhook alerts enabled (format: ${notifier.format})`);
}
const activeRequests = new Map(); // reqId → {id, routeId, engine, appId, account, startedAt, streaming, ac, killedByAdmin}
const enginesDisabled = {};
for (const e of ENGINE_NAMES) enginesDisabled[e] = false;

// Multi-account pool: each account carries its own breaker + CLI lane. With
// no accounts.json every engine gets one implicit "default" account whose
// spawns leave the environment untouched — exactly the old single-account
// behavior.
const ACCOUNTS_FILE = process.env.BRIDGE_ACCOUNTS_FILE || path.resolve(__dirname, '../../.bridge-runtime/accounts.json');
const pool = createAccountPool({
  file: ACCOUNTS_FILE,
  // Relative account dirs resolve beside accounts.json itself — the runtime
  // dir in production, the isolated temp dir in tests.
  baseDir: path.dirname(ACCOUNTS_FILE),
  engines: ENGINE_NAMES,
  breakerOpts: {
    quotaCooldownMs: intEnv('BREAKER_QUOTA_COOLDOWN_MS', 15 * 60 * 1000),
    timeoutCooldownMs: intEnv('BREAKER_TIMEOUT_COOLDOWN_MS', 2 * 60 * 1000),
  },
  semaphoreOpts: {
    max: MAX_CONCURRENT_PER_ENGINE,
    queueDepth: intEnv('PROVIDER_QUEUE_DEPTH', 4),
    queueTimeoutMs: intEnv('PROVIDER_QUEUE_TIMEOUT_MS', 30000),
  },
  onChange: (ev) => {
    if (ev.kind === 'breaker') console.log(`[breaker] ${ev.engine}:${ev.account} → ${ev.breaker.state}${ev.breaker.reason ? ` (${ev.breaker.reason})` : ''}`);
    if (ev.kind === 'needs-login') console.warn(`[accounts] ${ev.engine}:${ev.account} needs login`);
    events.emit('account.change', ev);
    // A quota-tripped breaker is the freshest possible signal — re-poll that
    // account now so the dashboard (and Phase 2 selection) see real numbers.
    // Gate BOTH poll paths: air-gapped/test hosts must make zero quota fetches.
    if (QUOTA_POLL && ev.kind === 'breaker' && ev.breaker && ev.breaker.state === 'open' && ev.breaker.reason === 'quota') {
      quota.pollSoon(ev.engine, ev.account);
    }
  },
});

// Per-account subscription-usage snapshots (router spec §5). The poller is
// advisory: any failure degrades one account's freshness, never dispatch.
// BRIDGE_QUOTA_POLL=0 disables the interval (tests, air-gapped hosts).
const QUOTA_POLL = process.env.BRIDGE_QUOTA_POLL !== '0';
const quota = createQuotaService({
  pool,
  file: path.join(RUNTIME_DIR, 'quota-snapshots.json'),
  agyRefresh: (acct) => runCli(process.env.GEMINI_PATH || process.env.AGY_PATH || 'agy', ['models'], {
    timeoutMs: 15_000, maxBytes: 256 * 1024, env: { ...process.env, HOME: acct.dir },
  }),
  onChange: (ev) => events.emit('quota.change', ev),
});
if (QUOTA_POLL) quota.start();

// Server-side interval health sampling — uptime no longer depends on how
// many dashboard tabs are polling (audit M13).
const HEALTH_SAMPLE_MS = intEnv('HEALTH_SAMPLE_MS', 30000);
const healthSampler = setInterval(async () => {
  for (const e of ENGINE_NAMES) {
    const h = await adapters[e].healthCheck();
    telemetry.recordHealthSample(e, h.ok, 'health');
    events.emit('engine.health', { engine: e, ...h, disabled: enginesDisabled[e] });
  }
}, HEALTH_SAMPLE_MS);
healthSampler.unref();

function newRequestId() {
  return crypto.randomBytes(6).toString('hex');
}

function appIdFrom(req, body) {
  // X-App-Id / X-Client-Id header first; fall back to the OpenAI `user` field
  // (many SDKs set it) so per-caller attribution works without a custom header.
  const raw = req.headers['x-app-id'] || req.headers['x-client-id'] || (body && body.user) || '';
  const cleaned = String(raw).trim().slice(0, 64);
  return cleaned && /^[A-Za-z0-9_.\- ]+$/.test(cleaned) ? cleaned : 'default';
}

// The reply tried to be a tool call (fenced json or a tool_calls payload) but
// parseToolCallsFromText rejected it — used to trigger one corrective retry.
function looksLikeToolAttempt(t) {
  return /"tool_calls"|```json/i.test(String(t));
}

// Max prompt bytes an engine accepts: agy passes the prompt as a CLI argument
// (ARG_MAX-bound, ~200KB); claude streams it over stdin (effectively uncapped).
const MAX_PROMPT_BYTES = intEnv('MAX_PROMPT_BYTES', 200 * 1024);
function engineCap(engine) {
  return engine === 'gemini' ? MAX_PROMPT_BYTES : Infinity;
}

// Serialize an aggregate() rollup to CSV. `dimension` picks which breakdown
// (perKey/perApp/perRoute/perAccount/perUser) becomes the rows; RFC-4180
// quoting so a name with a comma/quote can't corrupt the columns.
const CSV_DIMENSIONS = {
  key: 'perKey', app: 'perApp', route: 'perRoute', account: 'perAccount', user: 'perUser',
};
function csvCell(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function usageToCsv(agg, dimension) {
  const field = CSV_DIMENSIONS[dimension] || 'perKey';
  const rows = agg[field] || [];
  const cols = rows.length ? Object.keys(rows[0]) : ['(no data)'];
  const lines = [cols.join(',')];
  for (const row of rows) lines.push(cols.map((c) => csvCell(row[c])).join(','));
  return `${lines.join('\n')}\n`;
}
const USAGE_RANGES = ['today', 'month', '7d', '30d', 'all'];
const rangeOf = (q) => (USAGE_RANGES.includes(String(q)) ? String(q) : '7d');

function sendError(res, status, message, type, param, retryAfterSec) {
  if (retryAfterSec) res.set('Retry-After', String(retryAfterSec));
  return res.status(status).json(openaiErrorBody(message, type, param));
}

// ── Response translation shims ──────────────────────────────────────────
// /v1/completions and /v1/messages run the chat pipeline, then reshape its
// reply on the way out by wrapping res.json (non-streaming) and res.write
// (SSE). Each write carries exactly one event (ends in \n\n), so a per-write
// transform is safe. Error envelopes pass through unchanged.
function parseSseData(str) {
  if (!str.startsWith('data: ')) return null; // heartbeat/comment — leave as-is
  const payload = str.slice(6).trim();
  if (payload === '[DONE]') return '[DONE]';
  try { return JSON.parse(payload); } catch (_) { return null; }
}

function installTextCompletionShim(res, streaming) {
  if (streaming) {
    const origWrite = res.write.bind(res);
    res.write = (chunk, ...rest) => {
      const obj = parseSseData(String(chunk));
      if (obj === null) return origWrite(chunk, ...rest); // heartbeat/comment
      if (obj === '[DONE]') return origWrite('data: [DONE]\n\n', ...rest);
      const c = (obj.choices && obj.choices[0]) || {};
      const out = {
        id: String(obj.id || '').replace('chatcmpl-', 'cmpl-'),
        object: 'text_completion',
        created: obj.created,
        model: obj.model,
        choices: c.delta !== undefined || c.finish_reason !== undefined
          ? [{ text: (c.delta && c.delta.content) || '', index: 0, logprobs: null, finish_reason: c.finish_reason || null }]
          : [],
      };
      if (obj.usage) out.usage = obj.usage;
      return origWrite(`data: ${JSON.stringify(out)}\n\n`, ...rest);
    };
    return;
  }
  const origJson = res.json.bind(res);
  res.json = (obj) => {
    if (!obj || obj.object !== 'chat.completion') return origJson(obj); // error body
    const c = obj.choices[0] || {};
    return origJson({
      id: String(obj.id || '').replace('chatcmpl-', 'cmpl-'),
      object: 'text_completion',
      created: obj.created,
      model: obj.model,
      choices: [{ text: (c.message && c.message.content) || '', index: 0, logprobs: null, finish_reason: c.finish_reason }],
      usage: obj.usage,
    });
  };
}

const ANTHROPIC_STOP = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' };
function installAnthropicShim(res, streaming, model) {
  const msgId = `msg_${crypto.randomBytes(12).toString('hex')}`;
  if (streaming) {
    const origWrite = res.write.bind(res);
    let started = false;
    let finish = 'end_turn';
    res.write = (chunk, ...rest) => {
      const obj = parseSseData(String(chunk));
      if (obj === null) return origWrite(chunk, ...rest); // heartbeat/comment
      if (obj === '[DONE]') return true; // Anthropic has no [DONE]; message_stop already sent
      const c = (obj.choices && obj.choices[0]) || {};
      const ev = (type, data) => origWrite(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`, ...rest);
      if (!started) {
        started = true;
        ev('message_start', { message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: obj.usage ? obj.usage.prompt_tokens : 0, output_tokens: 0 } } });
        ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      }
      if (c.delta && c.delta.content) ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: c.delta.content } });
      if (c.finish_reason) {
        finish = ANTHROPIC_STOP[c.finish_reason] || 'end_turn';
        ev('content_block_stop', { index: 0 });
        ev('message_delta', { delta: { stop_reason: finish, stop_sequence: null }, usage: { output_tokens: obj.usage ? obj.usage.completion_tokens : 0 } });
        ev('message_stop', {});
      }
      return true;
    };
    return;
  }
  const origJson = res.json.bind(res);
  res.json = (obj) => {
    if (!obj || obj.object !== 'chat.completion') {
      // Reshape the OpenAI error envelope into Anthropic's.
      if (obj && obj.error) return origJson({ type: 'error', error: { type: obj.error.type || 'error', message: obj.error.message } });
      return origJson(obj);
    }
    const c = obj.choices[0] || {};
    return origJson({
      id: msgId,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text: (c.message && c.message.content) || '' }],
      stop_reason: ANTHROPIC_STOP[c.finish_reason] || 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: obj.usage ? obj.usage.prompt_tokens : 0, output_tokens: obj.usage ? obj.usage.completion_tokens : 0 },
    });
  };
}

// ── Auth (OpenAI error envelope, /v1 only) ─────────────────────────────
// Any valid named key (admin or app) may call /v1. The matched key is attached
// as req.auth so the request path can honor its accountPin and attribute usage.
// /v1/messages speaks Anthropic shapes — install its translation shim BEFORE
// auth so even an auth-layer error comes back Anthropic-shaped, and so the
// route handler doesn't double-wrap res.
app.use('/v1/messages', (req, res, next) => {
  const body = req.body || {};
  installAnthropicShim(res, body.stream === true, body.model);
  next();
});

app.use('/v1', (req, res, next) => {
  if (!keyStore.authEnabled) return next();
  // Bearer (OpenAI) or x-api-key (Anthropic /v1/messages clients).
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.headers['x-api-key'] || '');
  const who = keyStore.verify(token);
  if (!who) {
    // A signed-in dashboard session may exercise /v1 directly (the Tester) —
    // no key paste needed. Attributed as "user:<name>" in the ledger, with
    // the user's default limits applied. External tools still use API keys.
    const su = sessionUser(req);
    if (su) {
      req.auth = { name: `user:${su.username}`, role: su.role === 'admin' ? 'admin' : 'app', limits: su.defaultLimits };
      return next();
    }
    return sendError(res, 401, 'Missing or invalid Authorization bearer token.', 'invalid_request_error', 'Authorization');
  }
  req.auth = who;
  return next();
});

// ── Login / sessions (SaaS mode) ────────────────────────────────────────
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const out = userStore.login(username, password, req.ip);
  if (!out.ok) return res.status(out.status).json({ error: out.error });
  setSessionCookie(req, res, out.token, 7 * 24 * 3600);
  return res.json({ user: out.user });
});

app.post('/auth/logout', (req, res) => {
  const tok = sessionToken(req);
  if (tok) userStore.logout(tok);
  setSessionCookie(req, res, 'x', 0);
  res.json({ ok: true });
});

app.get('/auth/me', (req, res) => {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  res.json({ user });
});

app.post('/auth/password', (req, res) => {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });
  const { currentPassword, newPassword } = req.body || {};
  const gate = userStore.checkPassword(user.username, currentPassword, req.ip);
  if (!gate.ok) return res.status(gate.status).json({ error: gate.error });
  try {
    userStore.update(user.username, { password: newPassword });
    return res.json({ ok: true, note: 'Password changed — sign in again.' });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// A session still on its bootstrap (log-printed) password can do exactly
// three things — see itself, change the password, sign out — until it is
// replaced. Requests carrying a *valid* API key are not session-authed and
// pass through; the login/logout/me/password routes above already ran.
app.use((req, res, next) => {
  // The static dashboard shell (and health probes) stay reachable — they are
  // public by design and the change-password dialog lives in that UI. The
  // /dashboard data endpoints (status/usage/events) are NOT exempt.
  if (req.method === 'GET' && ['/', '/healthz', '/health'].includes(req.path)) return next();
  if (req.method === 'GET' && req.path.startsWith('/dashboard')
    && !/^\/dashboard\/(status|usage|events)/.test(req.path)) return next();
  const su = sessionUser(req);
  if (!su || !su.mustChangePassword) return next();
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (token && keyStore.verify(token)) return next();
  return res.status(403).json({
    error: 'Your password was auto-generated at first boot — change it before doing anything else.',
    mustChangePassword: true,
  });
});

// ── Per-user self-service (session required; admin or user role) ────────
// A user's keys are namespaced "<username>.<app>": one key per application,
// inheriting the admin-set default limits for that user.
function requireSession(req, res) {
  const user = sessionUser(req);
  if (!user) { res.status(401).json({ error: 'Sign in first.' }); return null; }
  return user;
}

app.get('/me/keys', (req, res) => {
  const user = requireSession(req, res);
  if (!user) return;
  const keys = keyStore.listByOwner(user.username).map((k) => ({ ...k, usage: limitGuard.snapshot(k.name) }));
  res.json({ keys, defaultLimits: user.defaultLimits || null });
});

app.post('/me/keys', (req, res) => {
  const user = requireSession(req, res);
  if (!user) return;
  const app_ = String((req.body || {}).app || '').trim();
  if (!/^[A-Za-z0-9._-]{1,40}$/.test(app_)) {
    return res.status(400).json({ error: 'App name must be 1-40 chars of letters, digits, . _ -' });
  }
  try {
    const rec = keyStore.mint({
      name: `${user.username}.${app_}`,
      role: 'app',
      owner: user.username,
      limits: user.defaultLimits,
    });
    events.emit('keys.change', { action: 'mint', name: rec.name });
    return res.json({ name: rec.name, limits: rec.limits || null, createdAt: rec.createdAt, key: rec.key });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.delete('/me/keys/:name', (req, res) => {
  const user = requireSession(req, res);
  if (!user) return;
  if (keyStore.ownerOf(req.params.name) !== user.username) {
    return res.status(403).json({ error: 'That key is not yours.' });
  }
  try {
    keyStore.revoke(req.params.name);
    events.emit('keys.change', { action: 'revoke', name: req.params.name });
    return res.json({ revoked: true, name: req.params.name });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// Owners can rotate their own key's secret (a leaked key → new secret without
// losing the key's name/limits/history). Body may carry { graceDays }.
app.post('/me/keys/:name/rotate', (req, res) => {
  const user = requireSession(req, res);
  if (!user) return;
  if (keyStore.ownerOf(req.params.name) !== user.username) {
    return res.status(403).json({ error: 'That key is not yours.' });
  }
  try {
    const rec = keyStore.rotate(req.params.name, { graceDays: (req.body || {}).graceDays });
    events.emit('keys.change', { action: 'rotate', name: rec.name });
    return res.json({ name: rec.name, key: rec.key, expiresAt: rec.expiresAt || null, rotatedAt: rec.rotatedAt || null });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

app.get('/me/usage', async (req, res) => {
  const user = requireSession(req, res);
  if (!user) return;
  const range = rangeOf(req.query.range);
  const own = new Set(keyStore.listByOwner(user.username).map((k) => k.name));
  res.json(await ledger.aggregate(range, { keyFilter: own }));
});

// CSV export of the caller's own usage (spreadsheet / billing reconciliation).
app.get('/me/usage.csv', async (req, res) => {
  const user = requireSession(req, res);
  if (!user) return;
  const range = rangeOf(req.query.range);
  const own = new Set(keyStore.listByOwner(user.username).map((k) => k.name));
  const agg = await ledger.aggregate(range, { keyFilter: own });
  const dim = req.query.dimension === 'app' ? 'app' : 'key';
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="usage-${user.username}-${range}.csv"`);
  res.send(usageToCsv(agg, dim));
});

// ── Dashboard auth (optional; for tunnel/public exposure) ──────────────
// DASHBOARD_AUTH=1 gates the dashboard DATA endpoints (status/usage/events)
// behind an admin key — Bearer header or ?key= (EventSource can't set
// headers). The static UI files stay public; they contain no data. Set this
// before exposing the port through a Cloudflare tunnel / reverse proxy.
const DASHBOARD_AUTH = process.env.DASHBOARD_AUTH === '1';
// A URL query key ends up in access logs, proxy caches, and browser history,
// so we only honor ?key= where a header is impossible — the EventSource (SSE)
// stream. Every other gated endpoint requires the Authorization header (or an
// admin session cookie).
function makeDashboardGate({ allowQueryKey = false } = {}) {
  return function dashboardGate(req, res, next) {
    if (!DASHBOARD_AUTH || !keyStore.authEnabled) return next();
    const su = sessionUser(req);
    if (su && su.role === 'admin') return next(); // logged-in admin
    let token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token && allowQueryKey) token = String(req.query.key || '');
    const who = keyStore.verify(token);
    if (!who || who.role !== 'admin') {
      const hint = allowQueryKey ? 'Authorization: Bearer <key> or ?key=<key>' : 'Authorization: Bearer <key>';
      return res.status(401).json({ error: `Dashboard auth is enabled — sign in as an admin, or pass an admin key (${hint}).` });
    }
    return next();
  };
}
const dashboardGate = makeDashboardGate();
const dashboardGateSse = makeDashboardGate({ allowQueryKey: true });

// ── Dashboard (static control center) + health ─────────────────────────
// Liveness probe for Docker HEALTHCHECK / monitors: no data, never gated
// (the gated /dashboard/status would 401 the healthcheck under DASHBOARD_AUTH).
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Static middleware passes unknown paths through, so the /dashboard/status,
// /dashboard/events, and /dashboard/usage handlers below keep working.
app.get('/', (req, res) => res.redirect('/dashboard/'));
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));

app.get('/dashboard/status', dashboardGate, async (req, res) => {
  const checks = await Promise.all(ENGINE_NAMES.map((e) => adapters[e].healthCheck()));
  const engines = {};
  ENGINE_NAMES.forEach((e, i) => {
    engines[e] = {
      url: 'in-process',
      ...checks[i],
      disabled: enginesDisabled[e],
      history: telemetry.healthHistory[e].slice(-120),
    };
  });
  // Annotate each account with the identity currently signed in for its config
  // dir (read from disk, no CLI call) so the operator can see who's logged in.
  const accountsSnap = pool.snapshot();
  for (const e of ENGINE_NAMES) {
    for (const a of accountsSnap[e]) {
      const acct = pool.accounts(e).find((x) => x.name === a.name);
      try { a.identity = adapters[e].identity(pool.envFor(e, acct)); } catch (_) { a.identity = null; }
      a.quota = quota.get(e, a.name);
    }
  }
  const origin = `${req.protocol}://${req.get('host')}`;
  res.json({
    status: 'ok',
    engine: 'provider-bridge',
    authEnabled: keyStore.authEnabled,
    uptime: process.uptime(),
    inflight: Object.fromEntries(ENGINE_NAMES.map((e) => [e, pool.inflight(e)])),
    queue: Object.fromEntries(ENGINE_NAMES.map((e) => [e, pool.queued(e)])),
    breakers: Object.fromEntries(ENGINE_NAMES.map((e) => [e, pool.engineBreakerStatus(e)])),
    accounts: accountsSnap,
    capture: { enabled: capture.enabled, count: capture.size },
    notifications: { enabled: notifier.enabled, format: notifier.enabled ? notifier.format : null, ...notifier.stats() },
    activeRequests: [...activeRequests.values()].map((a) => ({
      id: a.id, routeId: a.routeId, engine: a.engine, appId: a.appId, startedAt: a.startedAt, streaming: a.streaming,
    })),
    engines,
    connection: {
      baseUrl: `${origin}/v1`,
      chatCompletionsUrl: `${origin}/v1/chat/completions`,
      authHeader: keyStore.authEnabled ? 'Authorization: Bearer <key>' : 'none',
    },
    defaultRoute: registry.defaultRoute(),
    routes: registry.list().map((route) => ({
      id: route.id,
      label: route.label,
      engine: route.engine,
      upstreamModel: route.model,
      bestFor: route.bestFor,
      enabled: route.enabled !== false,
    })),
    telemetry: telemetry.computeTelemetry(MAX_CONCURRENT_PER_ENGINE),
    recentRequests: telemetry.recentRequests.map((r) => ({ ...r })),
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    engine: 'provider-bridge',
    uptime: process.uptime(),
    inflightClaude: pool.inflight('claude'),
    inflightGemini: pool.inflight('gemini'),
  });
});

// Live event stream for the dashboard (SSE). EventSource can't set headers,
// so this is the one gate that accepts ?key=.
app.get('/dashboard/events', dashboardGateSse, events.handler);

// Control plane (always key-gated; see admin.js).
app.use('/admin', createAdminRouter({
  keyStore, registry, pool, adapters, activeRequests, capture, events, enginesDisabled, limitGuard,
  userStore, ledger, sessionUser, accountsFile: ACCOUNTS_FILE,
}));

// Durable usage rollups (JSONL ledger; survives restarts).
app.get('/dashboard/usage', dashboardGate, async (req, res) => {
  const range = rangeOf(req.query.range);
  res.json(await ledger.aggregate(range, { ownerOf: keyStore.ownerOf }));
});

// CSV export of the whole ledger (admin). ?dimension=key|app|route|account|user.
app.get('/dashboard/usage.csv', dashboardGate, async (req, res) => {
  const range = rangeOf(req.query.range);
  const dim = CSV_DIMENSIONS[req.query.dimension] ? req.query.dimension : 'key';
  const agg = await ledger.aggregate(range, { ownerOf: keyStore.ownerOf });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="usage-${dim}-${range}.csv"`);
  res.send(usageToCsv(agg, dim));
});

// ── /v1/models ──────────────────────────────────────────────────────────
app.get('/v1/models', (req, res) => {
  const created = Math.floor(Date.now() / 1000);
  const data = registry.list()
    .filter((route) => route.enabled !== false)
    .map((route) => ({
      id: route.id,
      object: 'model',
      created,
      owned_by: route.engine,
    }));
  res.json({ object: 'list', data });
});

// ── /v1/chat/completions ────────────────────────────────────────────────
// The core dispatch handler. /v1/completions and /v1/messages reuse it via
// thin request/response translation shims (below) so the routing, auth,
// limits, failover, continuity, tool and output-shaping logic lives in one
// place and never forks.
async function chatCompletion(req, res) {
  const reqId = newRequestId();
  const started = Date.now();
  const body = req.body || {};
  const aliasUsed = body.model;
  let route = registry.resolve(aliasUsed); // may be reassigned by overflow reroute
  const appId = appIdFrom(req, body);
  const keyName = (req.auth && req.auth.name) || null;
  let estPromptTokens = 0;
  let estCompletionTokens = 0;
  let usageSource = 'estimated';
  let accountName = null; // set after selection; follows failover

  const record = (status) => {
    telemetry.record({
      id: reqId,
      appId,
      keyName,
      aliasUsed: aliasUsed || '?',
      routeId: route ? route.id : null,
      label: route ? route.label : (aliasUsed || '?'),
      engine: route ? route.engine : null,
      account: accountName,
      status,
      durationMs: Date.now() - started,
      estPromptTokens,
      estCompletionTokens,
      usageSource,
    });
    if (route) {
      ledger.append({
        reqId,
        appId,
        keyName,
        routeId: route.id,
        engine: route.engine,
        model: route.model,
        account: accountName,
        promptTokens: estPromptTokens,
        completionTokens: estCompletionTokens,
        usageSource,
        durationMs: Date.now() - started,
        status,
      });
    }
    if (keyName && route && status === 200) {
      limitGuard.record(keyName, estPromptTokens + estCompletionTokens, ledger.costOf(route.model, estPromptTokens, estCompletionTokens));
    }
    events.emit('request.end', {
      id: reqId,
      appId,
      routeId: route ? route.id : null,
      engine: route ? route.engine : null,
      status,
      durationMs: Date.now() - started,
      tokens: estPromptTokens + estCompletionTokens,
    });
    console.log(`[req ${reqId}] ${status} model=${aliasUsed || '?'} app=${appId} ${Date.now() - started}ms`);
  };

  // Per-key limits: consume an rpm slot and check budgets before any engine
  // work. 429 carries Retry-After so OpenAI clients back off correctly.
  if (req.auth && req.auth.limits) {
    const verdict = limitGuard.check(req.auth.name, req.auth.limits);
    if (!verdict.ok) {
      record(429);
      return sendError(res, 429, verdict.message, 'rate_limit_error', null, verdict.retryAfterSec);
    }
    // Soft budget warning: tell the caller (header) and — once per period —
    // alert the operator (webhook) before the hard 429 arrives.
    if (verdict.warning) {
      const w = verdict.warning;
      res.set('X-Bridge-Budget-Warning', `${w.reason} at ${w.pct}% (${w.used} of ${w.limit})`);
      if (w.fresh) events.emit('budget.warning', { keyName: req.auth.name, reason: w.reason, pct: w.pct, used: String(w.used), limit: String(w.limit) });
    }
    // OpenAI-style rate-limit headers so SDK auto-backoff works against the
    // key's rpm budget.
    const rl = limitGuard.rpmStatus(req.auth.name, req.auth.limits);
    if (rl) {
      res.set('X-RateLimit-Limit-Requests', String(rl.limit));
      res.set('X-RateLimit-Remaining-Requests', String(rl.remaining));
      res.set('X-RateLimit-Reset-Requests', `${rl.resetSec}s`);
    }
  }

  for (const [name, val] of [['logprobs', body.logprobs]]) {
    if (val !== undefined && val !== null && val !== false) {
      record(400);
      return sendError(res, 400, `Parameter "${name}" is not supported by provider-bridge.`, 'unsupported_parameter', name);
    }
  }
  if (body.n !== undefined && body.n !== null && body.n !== 1) {
    record(400);
    return sendError(res, 400, 'Parameter "n" must be 1 — multiple choices are not supported.', 'unsupported_parameter', 'n');
  }
  // Accepted-but-ignored sampling params are reported honestly, not dropped.
  // (max_tokens and stop are HONORED — see output shaping below — so they are
  // no longer on this list.)
  const ignoredParams = ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty']
    .filter((p) => body[p] !== undefined && body[p] !== null);

  // Output shaping the CLIs don't do themselves: stop sequences truncate the
  // reply, max_tokens caps its length. Enforced post-hoc (see translate.js).
  const maxTokens = Number.isInteger(body.max_tokens) && body.max_tokens > 0 ? body.max_tokens : null;
  const stopSeqs = normalizeStops(body.stop);
  const shapeOutput = Boolean(maxTokens || stopSeqs.length);

  if (!route) {
    record(400);
    return sendError(res, 400, `Model "${aliasUsed}" is not a known provider route.`, 'invalid_model', 'model');
  }
  if (route.enabled === false) {
    record(400);
    return sendError(res, 400, `Model route "${route.id}" is currently disabled.`, 'invalid_model', 'model');
  }
  if (enginesDisabled[route.engine]) {
    record(400);
    return sendError(res, 400, `Engine "${route.engine}" is disabled by the operator.`, 'invalid_request_error', null);
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    record(400);
    return sendError(res, 400, '`messages` must be a non-empty array.', 'invalid_request_error', 'messages');
  }
  const allowedRoles = ['system', 'user', 'assistant', 'tool', 'developer', 'function'];
  for (const m of messages) {
    if (!m || typeof m !== 'object') {
      record(400);
      return sendError(res, 400, 'Each message must be an object.', 'invalid_request_error', 'messages');
    }
    if (!allowedRoles.includes(m.role)) {
      record(400);
      return sendError(res, 400, `Message role "${m.role}" is not supported.`, 'invalid_request_error', 'messages');
    }
    if (Array.isArray(m.content)) {
      for (const item of m.content) {
        if (!item || typeof item !== 'object' || (!item.type && !item.text && !item.image_url)) {
          record(400);
          return sendError(res, 400, 'Invalid items in message content array.', 'invalid_request_error', 'messages');
        }
        // Honest unsupported: images used to silently degrade to "[Image: url]".
        if (item.type === 'image_url' || item.image_url) {
          record(400);
          return sendError(res, 400, 'Image content is not supported by this bridge yet. Send text-only messages.', 'invalid_request_error', 'messages');
        }
      }
    } else if (typeof m.content !== 'string' && m.content !== null && m.content !== undefined) {
      record(400);
      return sendError(res, 400, 'Message content must be a string, array, or null.', 'invalid_request_error', 'messages');
    }
  }

  // Flatten the prompt up front (before taking a lane) so an oversized prompt
  // for a capped engine can be rejected — or rerouted — without spawning.
  const toolsList = body.tools || body.functions;
  const tc = body.tool_choice;
  let toolChoice = 'auto';
  let forcedToolName = null;
  if (tc === 'none') toolChoice = 'none';
  else if (tc === 'required') toolChoice = 'required';
  else if (tc && typeof tc === 'object' && tc.type === 'function' && tc.function && tc.function.name) {
    toolChoice = 'required';
    forcedToolName = tc.function.name;
  }
  // Only ever interpret model output as tool calls when the caller actually sent
  // tools — otherwise a reply that *discusses* a tool_calls payload is hijacked.
  const toolsProvided = Array.isArray(toolsList) && toolsList.length > 0 && toolChoice !== 'none';
  const prompt = messagesToPrompt(messages, {
    tools: toolsProvided ? toolsList : null,
    toolChoice,
    forcedToolName,
    responseFormat: body.response_format,
  });
  estPromptTokens = estimateTokens(prompt);

  // Oversized-prompt policy: over the engine's cap → loud 400 with remedies, or
  // a one-time reroute to a declared different-engine fallback (marked in the
  // reply so the caller always knows it was moved).
  let rerouted = null;
  {
    const promptBytes = Buffer.byteLength(prompt, 'utf8');
    if (promptBytes > engineCap(route.engine)) {
      const fb = route.overflowFallback ? registry.resolve(route.overflowFallback) : null;
      if (fb && promptBytes <= engineCap(fb.engine)) {
        rerouted = { from: route.id, to: fb.id, reason: 'prompt_overflow', bytes: promptBytes };
        console.log(`[req ${reqId}] prompt overflow ${promptBytes}B → reroute ${route.id} → ${fb.id}`);
        route = fb;
      } else {
        record(400);
        return sendError(res, 400, `Prompt is ${promptBytes} bytes, over the ${engineCap(route.engine)}-byte cap for the "${route.engine}" engine. Send it to a Claude route (uncapped stdin), shorten the conversation history, or set "overflowFallback" on this route.`, 'invalid_request_error', 'messages');
      }
    }
  }

  // Account selection precedence: key pin → route pin → pool rotation. Pinned
  // requests fail loud rather than silently switching accounts. Per-account
  // breakers make a known-exhausted account fail fast (or rotate past it)
  // instead of spawning a doomed CLI run. Key pin → route pin → pool rotation;
  // recomputed against the (possibly rerouted) engine.
  const keyPin = (req.auth && req.auth.accountPin && req.auth.accountPin[route.engine]) || null;
  const pin = keyPin || route.account || null;
  // Soft pins ("this app's assigned account, but fail over when exhausted")
  // only exist on keys; route pins stay hard.
  const pinMode = (keyPin && pin === keyPin && req.auth.pinMode === 'soft') ? 'soft' : 'hard';
  let sel = pool.select(route.engine, { pin, pinMode });
  if (!sel.ok) {
    // Cross-model failover before spawning anything: the engine's whole pool
    // is exhausted (429: all cooling down) or out of service (503: all
    // disabled/logged out) and the route declares a different-engine
    // fallback → move the request instead of bouncing the caller. Hard pins
    // fail loud as ever; the fallback engine must also fit the prompt.
    const fb = (!pin || pinMode === 'soft') && route.quotaFallback ? registry.resolve(route.quotaFallback) : null;
    if (fb && fb.enabled !== false && !enginesDisabled[fb.engine]
      && Buffer.byteLength(prompt, 'utf8') <= engineCap(fb.engine)) {
      const alt = pool.select(fb.engine, {});
      if (alt.ok) {
        rerouted = { from: route.id, to: fb.id, reason: 'engine_exhausted' };
        console.log(`[req ${reqId}] ${route.engine} pool unavailable (${sel.status}) → cross-model reroute ${route.id} → ${fb.id}`);
        route = fb;
        sel = alt;
      }
    }
    if (!sel.ok) {
      record(sel.status);
      return sendError(res, sel.status, sel.message, sel.status === 429 ? 'rate_limit_error' : 'engine_auth_error', null, sel.retryInSec);
    }
  }
  accountName = sel.account.name;

  let adapter = adapters[route.engine];
  const ac = new AbortController();
  let activePacer = null;
  let clientAborted = false;
  res.on('close', () => {
    if (!res.writableEnded) {
      clientAborted = true;
      if (activePacer) activePacer.stop();
      ac.abort();
    }
  });

  const active = {
    id: reqId,
    routeId: route.id,
    engine: route.engine,
    appId,
    account: sel.account.name,
    startedAt: new Date().toISOString(),
    streaming: body.stream === true,
    ac,
    killedByAdmin: false,
  };
  activeRequests.set(reqId, active);
  events.emit('request.start', { id: reqId, routeId: route.id, engine: route.engine, appId, streaming: active.streaming });

  let release;
  try {
    release = await sel.account.semaphore.acquire(ac.signal);
  } catch (err) {
    activeRequests.delete(reqId);
    if (err.busy) {
      record(429);
      return sendError(res, 429, `Engine "${route.engine}" is busy (slot queue full or wait timed out). Please retry shortly.`, 'engine_busy', null, 5);
    }
    record(499); // aborted while queued
    return res.end();
  }
  const queuedMs = Date.now() - started;

  try {
    // prompt / toolsProvided / toolChoice / forcedToolName were built up front
    // (before lane acquisition) for the oversized-prompt pre-flight above.

    // Opt-in debug capture (memory-only ring buffer; null when capture off).
    const cap = capture.start({
      reqId, appId, routeId: route.id, engine: route.engine, model: route.model, streaming: active.streaming,
    });
    if (cap) {
      cap.sentPrompt = prompt;
      cap.stages.queuedMs = queuedMs;
    }
    const markFirstByte = () => {
      if (cap && cap.stages.firstByteMs === undefined) cap.stages.firstByteMs = Date.now() - started;
    };
    const capFinish = (status, result, err) => {
      if (!cap) return;
      cap.status = status;
      cap.stages.totalMs = Date.now() - started;
      if (result) cap.rawOutput = result.text || '';
      if (err) cap.error = { kind: err.kind || 'error', message: err.message };
    };
    const breakerFeedback = (err) => pool.feedback(route.engine, sel.account, err || null);

    // One-shot transparent failover: a quota/auth/spawn failure on a pooled
    // (un-pinned) account moves the SAME request to the next healthy account
    // — but never after content bytes have reached the client.
    const FAILOVER_KINDS = new Set(['quota', 'auth', 'spawn_failed']);
    // `p` is what's actually sent (a resume delta or the full prompt); `fullPrompt`
    // is always the complete prompt used for any fallback. When not resuming,
    // `p === fullPrompt` and `rid` is null, so this behaves exactly as before.
    const invokeWithFailover = async ({ prompt: p, fullPrompt, resumeId: rid, onDelta, canFailover, onFailover }) => {
      try {
        return await adapter.invoke({ prompt: p, model: route.model, signal: ac.signal, onDelta, env: pool.envFor(route.engine, sel.account), resumeId: rid || undefined });
      } catch (err) {
        // A failed resume on the same account (e.g. the session expired) → one
        // retry with the full prompt on the same account, before account failover.
        // onFailover drops any partial stream state the failed resume buffered.
        if (rid && canFailover() && !clientAborted) {
          if (onFailover) onFailover();
          console.log(`[req ${reqId}] resume failed (${err.kind || 'err'}); retrying full prompt on ${sel.account.name}`);
          try {
            return await adapter.invoke({ prompt: fullPrompt, model: route.model, signal: ac.signal, onDelta, env: pool.envFor(route.engine, sel.account) });
          } catch (err2) { err = err2; }
        }
        const kind = err instanceof BridgeError ? err.kind : null;
        // Hard-pinned requests (route or strict key pin) never fail over —
        // they fail loud. Un-pinned and soft-pinned requests move on.
        if ((!pin || pinMode === 'soft') && FAILOVER_KINDS.has(kind) && canFailover() && !clientAborted) {
          pool.feedback(route.engine, sel.account, err);
          const next = pool.select(route.engine, { exclude: sel.account.name });
          if (next.ok) {
            release();
            release = await next.account.semaphore.acquire(ac.signal);
            sel = next;
            accountName = sel.account.name;
            active.account = sel.account.name;
            if (onFailover) onFailover();
            console.log(`[req ${reqId}] failover ${route.engine} → account ${sel.account.name} (${kind})`);
            // The new account has no session → always the full prompt, no resume.
            return adapter.invoke({ prompt: fullPrompt, model: route.model, signal: ac.signal, onDelta, env: pool.envFor(route.engine, sel.account) });
          }
          // Same engine fully exhausted mid-request → cross-model failover
          // (quota-shaped failures only: an auth/spawn error on one engine is
          // no reason to burn the other engine's quota). Nothing has streamed
          // (canFailover), so the whole request can move engines.
          const fb = kind === 'quota' && route.quotaFallback ? registry.resolve(route.quotaFallback) : null;
          if (fb && fb.enabled !== false && !enginesDisabled[fb.engine]
            && Buffer.byteLength(fullPrompt, 'utf8') <= engineCap(fb.engine)) {
            const alt = pool.select(fb.engine, {});
            if (alt.ok) {
              release();
              release = await alt.account.semaphore.acquire(ac.signal);
              sel = alt;
              rerouted = { from: route.id, to: fb.id, reason: 'engine_exhausted' };
              route = fb;
              adapter = adapters[fb.engine];
              accountName = sel.account.name;
              active.account = sel.account.name;
              active.engine = fb.engine;
              active.routeId = fb.id;
              if (onFailover) onFailover();
              console.log(`[req ${reqId}] cross-model failover → ${fb.id} (${fb.engine})`);
              return adapter.invoke({ prompt: fullPrompt, model: route.model, signal: ac.signal, onDelta, env: pool.envFor(route.engine, sel.account) });
            }
          }
        }
        throw err;
      }
    };

    const rf = body.response_format;
    const rfType = rf && typeof rf === 'object' ? (rf.type || (rf.json_schema ? 'json_schema' : null)) : null;
    const wantsJson = rfType === 'json_object' || rfType === 'json_schema';
    const rfSchema = wantsJson && rf.json_schema && rf.json_schema.schema ? rf.json_schema.schema : null;

    // response_format enforcement: extract → (optionally) schema-validate →
    // one corrective retry → bad_output. Returns canonical JSON text.
    const enforceJson = async (text) => {
      const attempt = (t) => {
        const parsed = extractJson(t);
        if (rfSchema) assertJsonSchema(parsed, rfSchema);
        return parsed;
      };
      try {
        return JSON.stringify(attempt(text));
      } catch (err1) {
        const retryPrompt = `${prompt}\n\n[ASSISTANT]\n${text}\n\n[SYSTEM]\nThe reply above is not acceptable: ${err1.message}. Respond again with ONLY the corrected JSON — no code fences, no commentary.`;
        // Corrective retries stay on the account that produced the reply.
        const retry = await adapter.invoke({ prompt: retryPrompt, model: route.model, signal: ac.signal, env: pool.envFor(route.engine, sel.account) });
        applyUsage(retry); // usage reflects the attempt whose output we return
        return JSON.stringify(attempt(retry.text)); // still bad → bad_output up the chain
      }
    };

    const applyUsage = (result) => {
      if (result.usage && result.usage.source === 'real') {
        estPromptTokens = result.usage.promptTokens;
        estCompletionTokens = result.usage.completionTokens;
        usageSource = 'real';
      } else {
        estCompletionTokens = estimateTokens(result.text);
      }
    };

    // Session continuity (claude only): if this conversation extends one we
    // served on the SAME account, resume it and send just the new turn. `prompt`
    // (the full flatten) stays intact for retries and any failover. Shared by
    // both the streaming and non-streaming paths below.
    let resumeId = null;
    let sendPrompt = prompt;
    if (route.engine === 'claude' && !rerouted && continuity.enabled) {
      const cont = continuity.lookup(route.id, messages);
      if (cont && cont.engine === 'claude' && cont.account === sel.account.name) {
        resumeId = cont.resumeId;
        sendPrompt = messagesToPrompt(cont.deltaMessages, {
          tools: toolsProvided ? toolsList : null, toolChoice, forcedToolName, responseFormat: body.response_format,
        });
        estPromptTokens = estimateTokens(sendPrompt);
        if (cap) cap.sentPrompt = sendPrompt;
        console.log(`[req ${reqId}] resuming ${route.engine}:${sel.account.name} session ${resumeId} (delta only)`);
      }
    }

    if (body.stream === true) {
      const completionId = 'chatcmpl-' + crypto.randomBytes(8).toString('hex');
      const createdTs = Math.floor(Date.now() / 1000);
      const chunkBase = { id: completionId, object: 'chat.completion.chunk', created: createdTs, model: aliasUsed };
      res.status(200);
      res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      });
      res.flushHeaders();
      res.write(`data: ${JSON.stringify({ ...chunkBase, ...(rerouted ? { bridge_rerouted: rerouted } : {}), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);

      // CLIs can be silent for minutes before the first byte; comments keep
      // proxies and client idle-timeouts from dropping the stream.
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
      }, SSE_HEARTBEAT_MS);
      heartbeat.unref();
      const endStream = () => {
        clearInterval(heartbeat);
        res.write('data: [DONE]\n\n');
        return res.end();
      };

      let streamedBytes = false; // content bytes sent → failover no longer possible
      const pacer = createSmoothPacer((deltaText) => {
        streamedBytes = true;
        const ok = res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }] })}\n\n`);
        // Backpressure: pause pacing until the socket drains.
        if (!ok && !res.writableEnded) return new Promise((r) => res.once('drain', r));
        return undefined;
      }, { delayMs: 10 });
      activePacer = pacer;

      // Tool-call hold-back: when the caller sent tools, buffer deltas while
      // the head of the reply still looks like a candidate JSON block, so raw
      // tool JSON is never streamed as visible content. Non-JSON-looking
      // output (or anything past the cap) flushes through immediately.
      const HOLD_CAP = 2048;
      let holding = toolsProvided;
      let held = '';
      // stop / max_tokens shaping for streamed content (not the tool path,
      // where hold-back + parsing owns the bytes). Once the limiter is done,
      // further deltas are dropped; the CLI is left to finish on its own.
      const limiter = (shapeOutput && !toolsProvided) ? createOutputLimiter({ stop: stopSeqs, maxTokens }) : null;
      const pushContent = (d) => {
        if (!limiter) { pacer.push(d); return; }
        if (limiter.done) return;
        const emit = limiter.push(d);
        if (emit) pacer.push(emit);
      };
      const feed = (d) => {
        markFirstByte();
        if (!holding) { pushContent(d); return; }
        held += d;
        const head = held.trimStart();
        if (!head) return;
        if (!(head.startsWith('```') || head.startsWith('{')) || held.length > HOLD_CAP) {
          holding = false;
          pushContent(held);
          held = '';
        }
      };

      let result;
      try {
        result = await invokeWithFailover({
          prompt: sendPrompt,
          fullPrompt: prompt,
          resumeId, // resume pre-first-byte; the hold-back keeps output buffered until parse
          onDelta: feed,
          canFailover: () => !streamedBytes,
          onFailover: () => { held = ''; holding = toolsProvided; }, // drop the failed attempt's held head
        });
      } catch (err) {
        const mapped = httpFor(err);
        const status = clientAborted || (err instanceof BridgeError && err.kind === 'aborted') ? 499 : mapped.status;
        breakerFeedback(err);
        capFinish(status, null, err);
        record(status);
        res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: { content: `\n[Error: ${err.message}]` }, finish_reason: 'stop' }] })}\n\n`);
        return endStream();
      }

      let detectedTools = toolsProvided ? parseToolCallsFromText(result.text) : null;
      // §6: the buffered head looked like a tool call but didn't parse, and no
      // content has streamed yet (hold-back kept it) → one corrective retry
      // before we give up and deliver the raw text as content.
      if (toolsProvided && !streamedBytes && !detectedTools && looksLikeToolAttempt(result.text)) {
        telemetry.recordToolRetry();
        try {
          const retry = await adapter.invoke({
            prompt: `${prompt}\n\n[ASSISTANT]\n${result.text}\n\n[SYSTEM]\nThe reply above looked like a tool call but its JSON could not be parsed — "arguments" must be an escaped JSON string. Respond with ONLY the \`\`\`json\`\`\` tool_calls block.`,
            model: route.model, signal: ac.signal, env: pool.envFor(route.engine, sel.account),
          });
          const reparsed = parseToolCallsFromText(retry.text);
          if (reparsed) { result = retry; detectedTools = reparsed; held = ''; }
        } catch (_) { /* keep the original attempt; fall through to deliver held content */ }
      }
      if (holding && held && !detectedTools) {
        pushContent(held); // looked like JSON but wasn't a tool call — deliver it
        held = '';
      }
      // Release any tail the limiter held back for stop-boundary detection.
      if (limiter && !limiter.done) { const tail = limiter.end(); if (tail) pacer.push(tail); }
      await pacer.drain();
      applyUsage(result);
      breakerFeedback();
      capFinish(200, result);
      record(200);
      // Remember this turn so a later request extending it can resume (claude
      // only — result.sessionId is undefined for agy, making this a no-op).
      if (!detectedTools) continuity.remember(route.id, route.engine, sel.account.name, messages, result.text, result.sessionId);

      // A mid-request cross-model reroute happens after the first chunk went
      // out, so the marker rides the finish chunk as well.
      const finishExtra = rerouted ? { bridge_rerouted: rerouted } : {};
      if (detectedTools) {
        res.write(`data: ${JSON.stringify({
          ...chunkBase,
          ...finishExtra,
          choices: [{
            index: 0,
            delta: { tool_calls: detectedTools.map((tc, i) => ({ index: i, ...tc })) },
            finish_reason: 'tool_calls',
          }],
        })}\n\n`);
      } else {
        const fr = limiter && limiter.finishReason ? limiter.finishReason : 'stop';
        res.write(`data: ${JSON.stringify({ ...chunkBase, ...finishExtra, choices: [{ index: 0, delta: {}, finish_reason: fr }] })}\n\n`);
      }
      if (body.stream_options && body.stream_options.include_usage) {
        res.write(`data: ${JSON.stringify({
          ...chunkBase,
          choices: [],
          usage: {
            prompt_tokens: estPromptTokens,
            completion_tokens: estCompletionTokens,
            total_tokens: estPromptTokens + estCompletionTokens,
          },
        })}\n\n`);
      }
      return endStream();
    }

    let result;
    try {
      result = await invokeWithFailover({ prompt: sendPrompt, fullPrompt: prompt, resumeId, onDelta: markFirstByte, canFailover: () => true });
    } catch (err) {
      const mapped = httpFor(err);
      breakerFeedback(err);
      if (clientAborted || (err instanceof BridgeError && err.kind === 'aborted')) {
        capFinish(499, null, err);
        record(499);
        if (active.killedByAdmin && !clientAborted) {
          return sendError(res, 500, 'Request was cancelled by an operator via the dashboard.', 'request_cancelled', null);
        }
        return res.end();
      }
      capFinish(mapped.status, null, err);
      record(mapped.status);
      return sendError(res, mapped.status, err.message, mapped.type, mapped.param, mapped.retryAfterSec);
    }

    applyUsage(result);
    breakerFeedback();
    let text = result.text;
    let detectedTools = toolsProvided ? parseToolCallsFromText(text) : null;
    const satisfiesChoice = () => {
      if (toolChoice !== 'required') return true;
      if (!detectedTools) return false;
      return !forcedToolName || detectedTools.some((t) => t.function.name === forcedToolName);
    };
    // §6: one corrective retry when the model must call a tool but didn't, OR
    // it *attempted* a tool call whose JSON didn't parse (malformed — the raw
    // JSON would otherwise leak as content). Malformed detection fires under any
    // tool_choice; the retry budget stays at one, shared with tool_choice.
    const malformedToolAttempt = () => toolsProvided && !detectedTools && looksLikeToolAttempt(text);
    if (toolsProvided && (!satisfiesChoice() || malformedToolAttempt())) {
      telemetry.recordToolRetry();
      const demand = forcedToolName ? `a call to the tool "${forcedToolName}"` : 'a tool call';
      const reason = malformedToolAttempt()
        ? 'the reply looked like a tool call but its JSON could not be parsed — "arguments" must be an escaped JSON string'
        : `this request requires ${demand}`;
      const retryPrompt = `${prompt}\n\n[ASSISTANT]\n${text}\n\n[SYSTEM]\nThe reply above is not acceptable: ${reason}. Respond with ONLY the \`\`\`json\`\`\` tool_calls block — no plain text.`;
      let retry;
      try {
        retry = await adapter.invoke({ prompt: retryPrompt, model: route.model, signal: ac.signal, env: pool.envFor(route.engine, sel.account) });
      } catch (err) {
        const mapped = httpFor(err);
        breakerFeedback(err);
        capFinish(mapped.status, null, err);
        record(mapped.status);
        return sendError(res, mapped.status, err.message, mapped.type, mapped.param, mapped.retryAfterSec);
      }
      applyUsage(retry);
      text = retry.text;
      detectedTools = parseToolCallsFromText(text);
      if (toolChoice === 'required' && !satisfiesChoice()) {
        capFinish(502, retry, null);
        record(502);
        return sendError(res, 502, `tool_choice could not be satisfied: the model did not produce ${demand}.`, 'upstream_error', 'tool_choice');
      }
    }
    if (wantsJson && !detectedTools) {
      try {
        text = await enforceJson(text);
      } catch (err) {
        const mapped = httpFor(err);
        capFinish(mapped.status, result, err);
        record(mapped.status);
        return sendError(res, mapped.status, `response_format could not be satisfied: ${err.message}`, mapped.type, mapped.param, mapped.retryAfterSec);
      }
    }
    capFinish(200, result);
    // Remember this turn so a follow-up extending it can resume on this account
    // (claude only; agy returns no sessionId → no-op). Tool-call turns are
    // skipped — their assistant message shape complicates prefix matching.
    if (!detectedTools) continuity.remember(route.id, route.engine, sel.account.name, messages, text, result.sessionId);

    // Honor stop / max_tokens on plain-text replies (skipped for tool calls
    // and JSON mode, where truncation would corrupt the structured payload).
    let finishReason = detectedTools ? 'tool_calls' : 'stop';
    if (!detectedTools && !wantsJson && shapeOutput) {
      const shaped = applyStopAndMax(text, { stop: stopSeqs, maxTokens });
      if (shaped.truncated) {
        text = shaped.text;
        finishReason = shaped.finishReason;
        estCompletionTokens = estimateTokens(text);
      }
    }
    const messageObj = detectedTools
      ? { role: 'assistant', content: null, tool_calls: detectedTools }
      : { role: 'assistant', content: text };

    const completion = {
      id: 'chatcmpl-' + crypto.randomBytes(8).toString('hex'),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: aliasUsed,
      choices: [
        {
          index: 0,
          message: messageObj,
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: estPromptTokens,
        completion_tokens: estCompletionTokens,
        total_tokens: estPromptTokens + estCompletionTokens,
      },
    };
    if (ignoredParams.length) completion.bridge_ignored_params = ignoredParams;
    if (rerouted) completion.bridge_rerouted = rerouted;
    record(200);
    return res.status(200).json(completion);
  } finally {
    release();
    activeRequests.delete(reqId);
  }
}
app.post('/v1/chat/completions', chatCompletion);

// ── /v1/completions (legacy text-completions API) ───────────────────────
// Older SDKs/tools still speak the text API. Translate prompt→messages, run
// the same pipeline, and reshape the reply to the text_completion object.
// Tools/JSON-mode aren't part of that API; max_tokens/stop/stream all work.
app.post('/v1/completions', (req, res) => {
  const body = req.body || {};
  if (body.prompt === undefined || body.prompt === null) {
    return sendError(res, 400, '`prompt` is required.', 'invalid_request_error', 'prompt');
  }
  if (body.best_of !== undefined && body.best_of !== null && body.best_of !== 1) {
    return sendError(res, 400, 'Parameter "best_of" must be 1.', 'unsupported_parameter', 'best_of');
  }
  const promptText = Array.isArray(body.prompt) ? body.prompt.map(String).join('\n') : String(body.prompt);
  // Rebuild the body as a chat request; carry model/max_tokens/stop/stream/user.
  req.body = {
    model: body.model,
    messages: [{ role: 'user', content: promptText }],
    stream: body.stream === true,
    ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
    ...(body.stop !== undefined ? { stop: body.stop } : {}),
    ...(body.user !== undefined ? { user: body.user } : {}),
    ...(body.stream_options ? { stream_options: body.stream_options } : {}),
  };
  installTextCompletionShim(res, body.stream === true);
  return chatCompletion(req, res);
});

// ── /v1/messages (Anthropic Messages API) ───────────────────────────────
// Lets Anthropic-SDK / Claude-native tools point straight at the bridge.
// Accepts {model, system, messages, max_tokens, stop_sequences, stream} and
// x-api-key auth (aliased to Bearer by the /v1 auth middleware), translates
// to the chat pipeline, and reshapes the reply into Anthropic message shape.
app.post('/v1/messages', (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.messages)) {
    return sendError(res, 400, '`messages` must be an array.', 'invalid_request_error', 'messages');
  }
  // Anthropic content blocks → plain text (the bridge is text-in/text-out).
  const flatten = (content) => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((b) => (b && b.type === 'text' ? b.text : (typeof b === 'string' ? b : ''))).join('');
    return content == null ? '' : String(content);
  };
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: flatten(body.system) });
  for (const m of body.messages) messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: flatten(m.content) });
  req.body = {
    model: body.model,
    messages,
    stream: body.stream === true,
    ...(body.max_tokens !== undefined ? { max_tokens: body.max_tokens } : {}),
    ...(body.stop_sequences !== undefined ? { stop: body.stop_sequences } : {}),
    ...(body.metadata && body.metadata.user_id ? { user: body.metadata.user_id } : {}),
  };
  // The Anthropic response shim is installed by pre-auth middleware above.
  return chatCompletion(req, res);
});

app.use((req, res) => {
  sendError(res, 404, `Unknown route: ${req.method} ${req.path}`, 'invalid_request_error', null);
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    return sendError(res, 400, 'Malformed or oversized JSON body.', 'invalid_request_error', null);
  }
  console.error(err);
  sendError(res, 500, 'Internal server error.', 'internal_error', null);
});

const server = app.listen(PORT, BIND_HOST, () => {
  console.log(`Provider (consolidated) running on ${BIND_HOST}:${PORT}`);
  console.log(`Auth: ${keyStore.authEnabled ? 'ENABLED (Bearer token required)' : 'DISABLED (open)'}`);
  console.log(`Engines: ${ENGINE_NAMES.map((e) => `${e} (in-process)`).join(', ')}`);
  console.log(`Max concurrent per engine: ${MAX_CONCURRENT_PER_ENGINE}`);
  console.log(`Routes: ${registry.list().map((r) => r.id).join(', ')}`);
  const exposed = BIND_HOST !== '127.0.0.1' && BIND_HOST !== 'localhost';
  if (!keyStore.authEnabled && exposed) {
    console.warn(`WARNING: provider bound to ${BIND_HOST} with no API key set — anyone who can reach this port can spend your Claude/Gemini quota. Set PROVIDER_API_KEY or bind to 127.0.0.1.`);
  }
  // The /v1 API is key-gated, but the dashboard DATA endpoints (status/usage/
  // events — which expose account emails, usage, and live requests) are only
  // gated when DASHBOARD_AUTH=1. Bound off-loopback without it, they're open.
  if (exposed && !DASHBOARD_AUTH) {
    console.warn(`WARNING: provider bound to ${BIND_HOST} with DASHBOARD_AUTH off — the dashboard data endpoints (status/usage/events) are reachable without a login. Set DASHBOARD_AUTH=1 before exposing this port beyond a trusted LAN.`);
  }
});

// Seed per-key budget counters from the durable ledger (async, additive —
// live traffic that races the seed is kept).
Promise.all([ledger.aggregate('today'), ledger.aggregate('month')])
  .then(([today, month]) => limitGuard.seed({ today, month }))
  .catch((err) => console.warn(`[limits] budget seed failed: ${err.message}`));

// A bridge dying must never orphan a quota-burning CLI run (audit H7).
installGracefulShutdown({ server });
// installGracefulShutdown (shared @bridge/core helper) owns the CLI-child
// reap; quota's own teardown (flush the pending snapshot write, clear
// pollers) is bridge-local, so it's a sibling listener on the same signals
// rather than a change to the shared helper. Guarded like the helper's own
// shutdownInstalled flag — server.js is require()'d fresh per boot in the
// test harness, and each reload must not stack another pair of listeners.
if (!globalThis.__bridgeQuotaShutdownHooked) {
  globalThis.__bridgeQuotaShutdownHooked = true;
  process.on('SIGTERM', () => quota.stop());
  process.on('SIGINT', () => quota.stop());
}

module.exports = { app, server };
