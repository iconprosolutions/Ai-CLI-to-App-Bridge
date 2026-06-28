const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const http = require('http');

const app = express();

const CORS_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const corsOptions = CORS_ORIGINS.length
  ? { origin: (origin, cb) => cb(null, !origin || CORS_ORIGINS.includes(origin)) }
  : {};
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));

const PORT = Number(process.env.PROVIDER_PORT) || 9010;
const CLAUDE_BRIDGE_URL = (process.env.CLAUDE_BRIDGE_URL || 'http://127.0.0.1:9002').replace(/\/+$/, '');
const GEMINI_BRIDGE_URL = (process.env.GEMINI_BRIDGE_URL || 'http://127.0.0.1:9003').replace(/\/+$/, '');
const API_KEY = process.env.PROVIDER_API_KEY || process.env.BRIDGE_API_KEY || '';
const UPSTREAM_API_KEY = process.env.BRIDGE_API_KEY || '';
const MAX_CONCURRENT_PER_ENGINE = Math.max(1, Number(process.env.PROVIDER_MAX_CONCURRENT_PER_ENGINE) || 1);
const UPSTREAM_TIMEOUT_MS = Math.max(1000, Number(process.env.PROVIDER_UPSTREAM_TIMEOUT_MS) || 310000);

const ENGINES = {
  claude: { url: CLAUDE_BRIDGE_URL },
  gemini: { url: GEMINI_BRIDGE_URL },
};

const DEFAULT_ROUTE_ID = 'bridge-agy-gemini-3.5-flash-medium-pulse';

const ROUTES = [
  {
    id: DEFAULT_ROUTE_ID,
    label: 'Bridge AGY Gemini 3.5 Flash Medium - Pulse',
    engine: 'gemini',
    model: 'Gemini 3.5 Flash (Medium)',
    bestFor: 'Balanced everyday app calls, summaries, and drafts',
  },
  {
    id: 'bridge-agy-gemini-3.5-flash-high-forge',
    label: 'Bridge AGY Gemini 3.5 Flash High - Forge',
    engine: 'gemini',
    model: 'Gemini 3.5 Flash (High)',
    bestFor: 'Stronger fast reasoning while staying on Antigravity',
  },
  {
    id: 'bridge-agy-gemini-3.1-pro-high-atlas',
    label: 'Bridge AGY Gemini 3.1 Pro High - Atlas',
    engine: 'gemini',
    model: 'Gemini 3.1 Pro (High)',
    bestFor: 'Long documents and broad project scans',
  },
  {
    id: 'bridge-claude-haiku-4.5-spark',
    engine: 'claude',
    model: 'claude-haiku-4-5',
    label: 'Bridge Claude Haiku 4.5 - Spark',
    bestFor: 'Quick Claude responses and lightweight checks',
  },
  {
    id: 'bridge-claude-sonnet-4.6-northstar',
    label: 'Bridge Claude Sonnet 4.6 - Northstar',
    engine: 'claude',
    model: 'claude-sonnet-4-6',
    bestFor: 'Coding, planning, and careful reasoning',
  },
  {
    id: 'bridge-claude-opus-4.5-oracle',
    label: 'Bridge Claude Opus 4.5 - Oracle',
    engine: 'claude',
    model: 'claude-opus-4-5',
    bestFor: 'Hard reasoning when Claude limits allow',
  },
  { id: 'bridge-fast', hidden: true, legacyOf: DEFAULT_ROUTE_ID, engine: 'gemini', model: 'Gemini 3.5 Flash (Medium)' },
  { id: 'bridge-smart', hidden: true, legacyOf: 'bridge-claude-sonnet-4.6-northstar', engine: 'claude', model: 'claude-sonnet-4-6' },
  { id: 'bridge-long', hidden: true, legacyOf: 'bridge-agy-gemini-3.1-pro-high-atlas', engine: 'gemini', model: 'Gemini 3.1 Pro (High)' },
  { id: 'bridge-deep', hidden: true, legacyOf: 'bridge-claude-opus-4.5-oracle', engine: 'claude', model: 'claude-opus-4-5' },
  { id: 'gemini-flash', hidden: true, legacyOf: DEFAULT_ROUTE_ID, engine: 'gemini', model: 'Gemini 3.5 Flash (Medium)' },
  { id: 'gemini-pro', hidden: true, legacyOf: 'bridge-agy-gemini-3.1-pro-high-atlas', engine: 'gemini', model: 'Gemini 3.1 Pro (High)' },
  { id: 'claude-sonnet', hidden: true, legacyOf: 'bridge-claude-sonnet-4.6-northstar', engine: 'claude', model: 'claude-sonnet-4-6' },
  { id: 'claude-opus', hidden: true, legacyOf: 'bridge-claude-opus-4.5-oracle', engine: 'claude', model: 'claude-opus-4-5' },
  { id: 'auto-fast', hidden: true, legacyOf: DEFAULT_ROUTE_ID, engine: 'gemini', model: 'Gemini 3.5 Flash (Medium)' },
  { id: 'auto-reasoning', hidden: true, legacyOf: 'bridge-claude-sonnet-4.6-northstar', engine: 'claude', model: 'claude-sonnet-4-6' },
  { id: 'auto-long-context', hidden: true, legacyOf: 'bridge-agy-gemini-3.1-pro-high-atlas', engine: 'gemini', model: 'Gemini 3.1 Pro (High)' },
  { id: 'gemini-cli-flash', hidden: true, legacyOf: DEFAULT_ROUTE_ID, engine: 'gemini', model: 'Gemini 3.5 Flash (Medium)' },
  { id: 'gemini-cli-pro', hidden: true, legacyOf: 'bridge-agy-gemini-3.1-pro-high-atlas', engine: 'gemini', model: 'Gemini 3.1 Pro (High)' },
  { id: 'claude-subscription-default', hidden: true, legacyOf: 'bridge-claude-sonnet-4.6-northstar', engine: 'claude', model: 'claude-sonnet-4-6' },
  { id: 'claude-subscription-sonnet', hidden: true, legacyOf: 'bridge-claude-sonnet-4.6-northstar', engine: 'claude', model: 'claude-sonnet-4-6' },
  { id: 'claude-subscription-opus', hidden: true, legacyOf: 'bridge-claude-opus-4.5-oracle', engine: 'claude', model: 'claude-opus-4-5' },
];
const ALIASES = Object.fromEntries(ROUTES.map((route) => [route.id, route]));
const VISIBLE_ROUTES = ROUTES.filter((route) => !route.hidden);

const inflight = { claude: 0, gemini: 0 };
const recentRequests = [];
const MAX_RECENT_REQUESTS = 50;

function newRequestId() {
  return crypto.randomBytes(6).toString('hex');
}

function logReq(reqId, fields) {
  const parts = [`[req ${reqId}]`];
  for (const [k, v] of Object.entries(fields)) parts.push(`${k}=${v}`);
  console.log(parts.join(' '));
  recentRequests.unshift({
    id: reqId,
    at: new Date().toISOString(),
    alias: fields.alias,
    engine: fields.engine,
    status: fields.status,
    durationMs: fields.duration,
    message: fields.message || '',
  });
  recentRequests.splice(MAX_RECENT_REQUESTS);
}

function routeDisplayFor(alias) {
  const route = ALIASES[alias];
  if (!route) return { label: alias || '?', id: alias || '?', engine: '-', model: '-', bestFor: '' };
  if (route.legacyOf && ALIASES[route.legacyOf]) return ALIASES[route.legacyOf];
  return route;
}

function routeSummary(route) {
  return {
    id: route.id,
    label: route.label,
    engine: route.engine,
    bestFor: route.bestFor,
    upstreamModel: route.model,
  };
}

function buildDashboardTelemetry() {
  const byEngine = {};
  const byRoute = {};
  let success = 0;
  let errors = 0;
  let totalDuration = 0;

  for (const request of recentRequests) {
    const status = Number(request.status) || 0;
    const ok = status >= 200 && status < 400;
    if (ok) success += 1;
    else errors += 1;
    totalDuration += Number(request.durationMs) || 0;

    const engineKey = request.engine || '-';
    byEngine[engineKey] = (byEngine[engineKey] || 0) + 1;

    const routeKey = request.alias || '?';
    const display = routeDisplayFor(routeKey);
    if (!byRoute[routeKey]) {
      byRoute[routeKey] = {
        id: routeKey,
        label: display.label || routeKey,
        count: 0,
        success: 0,
        errors: 0,
        avgDurationMs: 0,
        totalDurationMs: 0,
      };
    }
    byRoute[routeKey].count += 1;
    byRoute[routeKey].totalDurationMs += Number(request.durationMs) || 0;
    if (ok) byRoute[routeKey].success += 1;
    else byRoute[routeKey].errors += 1;
  }

  const routes = Object.values(byRoute)
    .map((route) => ({
      ...route,
      avgDurationMs: route.count ? Math.round(route.totalDurationMs / route.count) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  return {
    windowSize: MAX_RECENT_REQUESTS,
    total: recentRequests.length,
    success,
    errors,
    avgDurationMs: recentRequests.length ? Math.round(totalDuration / recentRequests.length) : 0,
    byEngine,
    byRoute: routes,
    latestErrors: recentRequests
      .filter((request) => Number(request.status) >= 400)
      .slice(0, 5)
      .map((request) => ({
        id: request.id,
        at: request.at,
        alias: request.alias,
        label: routeDisplayFor(request.alias).label,
        engine: request.engine,
        status: request.status,
        durationMs: request.durationMs,
        message: request.message,
      })),
  };
}

function openaiErrorBody(message, type, param) {
  return { error: { message, type, param: param === undefined ? null : param, code: null } };
}

function sendError(res, status, message, type, param) {
  return res.status(status).json(openaiErrorBody(message, type, param));
}

function sendStreamingCompletion(res, completion) {
  const choice = completion.choices[0];
  const chunkBase = {
    id: completion.id,
    object: 'chat.completion.chunk',
    created: completion.created,
    model: completion.model,
  };

  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({
    ...chunkBase,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    ...chunkBase,
    choices: [{ index: 0, delta: { content: choice.message.content }, finish_reason: null }],
  })}\n\n`);
  res.write(`data: ${JSON.stringify({
    ...chunkBase,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
  })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function messagesToPrompt(messages, opts = {}) {
  const parts = [];
  if (opts.textOnlyTools) {
    parts.push('[SYSTEM]\nThe caller supplied tool/function metadata, but this bridge route is text-only. Do not emit tool calls. Answer directly from the conversation context.');
  }
  parts.push(...messages
    .map((m) => `[${String(m.role).toUpperCase()}]\n${m.content}`)
  );
  return parts.join('\n\n');
}

function callUpstream(engine, payload) {
  const url = new URL(ENGINES[engine].url + '/api/chat');
  const body = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Accept': 'application/json',
  };
  if (UPSTREAM_API_KEY) headers.Authorization = `Bearer ${UPSTREAM_API_KEY}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => finish(resolve, { status: res.statusCode, body: data }));
    });
    timer = setTimeout(() => {
      req.destroy(new Error(`Upstream "${engine}" timed out after ${Math.round(UPSTREAM_TIMEOUT_MS / 1000)}s`));
    }, UPSTREAM_TIMEOUT_MS);
    timer.unref();
    req.on('error', (err) => finish(reject, err));
    req.write(body);
    req.end();
  });
}

function checkEngineHealth(engine) {
  const url = new URL(ENGINES[engine].url + '/health');
  return new Promise((resolve) => {
    const started = Date.now();
    const req = http.request(url, { method: 'GET', timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(data || '{}'); } catch (_) {}
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          durationMs: Date.now() - started,
          detail: body && (body.engine || body.status || body.message || body.error),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({
      ok: false,
      status: 0,
      durationMs: Date.now() - started,
      detail: err.message,
    }));
    req.end();
  });
}

function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AI CLI Bridge</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f6f8;
      --panel: #ffffff;
      --panel-2: #fbfcfe;
      --text: #17202c;
      --muted: #657286;
      --line: #d8dee9;
      --line-strong: #c5cedd;
      --good: #0f7a5f;
      --good-bg: #e8f5ef;
      --bad: #b42318;
      --bad-bg: #fff0ed;
      --warn: #a15c08;
      --warn-bg: #fff4df;
      --accent: #2457d6;
      --accent-soft: #edf2ff;
      --ink: #111827;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      overflow-x: hidden;
    }
    main { width: 100%; max-width: 1480px; margin: 0 auto; padding: 24px 18px 42px; }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 18px;
    }
    h1 { margin: 0; font-size: 28px; line-height: 1.1; letter-spacing: 0; }
    h2 { margin: 0; font-size: 15px; letter-spacing: 0; }
    h3 { margin: 0; font-size: 14px; letter-spacing: 0; }
    p { margin: 4px 0 0; color: var(--muted); overflow-wrap: anywhere; }
    button {
      appearance: none;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      min-height: 34px;
      padding: 0 12px;
      border-radius: 8px;
      font-weight: 650;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    select, textarea, input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #ffffff;
      color: var(--text);
      font: inherit;
    }
    select, input { min-height: 38px; padding: 0 10px; }
    textarea {
      min-height: 118px;
      resize: vertical;
      padding: 10px;
      line-height: 1.4;
    }
    label {
      display: block;
      margin: 0 0 6px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 650;
    }
    pre {
      min-height: 118px;
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      background: #f8fafc;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.4;
    }
    .grid { display: grid; gap: 14px; }
    .grid > * { min-width: 0; }
    .summary-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); }
    .main-grid { grid-template-columns: minmax(0, 1.45fr) minmax(360px, .8fr); margin-top: 14px; }
    .ops-grid { grid-template-columns: minmax(0, .75fr) minmax(0, 1.25fr); margin-top: 14px; }
    .tester-grid { grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr); margin-top: 14px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      min-width: 0;
    }
    .metric { font-size: 26px; font-weight: 760; margin-top: 8px; color: var(--ink); }
    .muted { color: var(--muted); }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 24px;
      padding: 0 9px;
      border-radius: 999px;
      border: 1px solid var(--line);
      font-size: 13px;
      font-weight: 650;
      color: var(--muted);
      background: #fbfcfe;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
    .ok { color: var(--good); background: var(--good-bg); border-color: #bde5d4; }
    .ok .dot { background: var(--good); }
    .down { color: var(--bad); background: var(--bad-bg); border-color: #fac5bd; }
    .down .dot { background: var(--bad); }
    .busy { color: var(--warn); background: var(--warn-bg); border-color: #f3d19b; }
    .busy .dot { background: var(--warn); }
    .section-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
    }
    .stack { display: grid; gap: 10px; }
    .row, .route-row, .request-row, .engine-row {
      display: grid;
      gap: 8px;
      align-items: center;
      padding: 10px 0;
      border-top: 1px solid var(--line);
    }
    .row:first-child, .route-row:first-child, .request-row:first-child, .engine-row:first-child { border-top: 0; }
    .route-row { grid-template-columns: minmax(250px, 1fr) 92px minmax(160px, .65fr) minmax(190px, .75fr) 68px; }
    .request-row { grid-template-columns: 92px minmax(220px, 1fr) 82px 80px 92px; }
    .engine-row { grid-template-columns: 86px 96px minmax(0, 1fr) 62px; }
    .usage-row { display: grid; grid-template-columns: minmax(0, 1fr) 74px 78px; gap: 8px; align-items: center; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      background: #f1f4f8;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 2px 6px;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .kv {
      display: grid;
      grid-template-columns: 72px minmax(0, 1fr);
      gap: 8px;
      align-items: center;
      margin-top: 8px;
    }
    .kv span, .model-meta { color: var(--muted); font-size: 13px; }
    .model-name { font-weight: 750; }
    .route-label strong, h1, h2, h3 { overflow-wrap: anywhere; }
    .model-id { margin-top: 4px; }
    .model-id code, .kv code, .engine-row code, .request-row code, .route-row code { display: block; width: 100%; }
    .small { font-size: 13px; }
    .empty { color: var(--muted); padding: 12px 0 4px; }
    .form-row { margin-top: 12px; }
    .actions { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
    .actions button { background: var(--accent); border-color: var(--accent); color: white; }
    .actions button:disabled { cursor: wait; opacity: .7; }
    .copy-btn {
      min-height: 28px;
      padding: 0 9px;
      font-size: 12px;
      background: var(--accent-soft);
      border-color: #c8d5ff;
      color: #1d3e9c;
    }
    .snippet-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
    .snippet-tabs button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: white; }
    .split-line { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .status-number { font-variant-numeric: tabular-nums; }
    .route-label { display: grid; gap: 4px; }
    .route-label strong { line-height: 1.25; }
    .route-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
    .tag {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 0 8px;
      border-radius: 999px;
      background: var(--panel-2);
      border: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
      font-weight: 650;
    }
    .warning {
      border-color: #efc16e;
      background: #fffaf0;
    }
    @media (max-width: 820px) {
      header { display: block; }
      header p { max-width: calc(100vw - 36px); word-break: break-all; }
      header button { margin-top: 14px; width: 100%; }
      .grid, .summary-grid, .main-grid, .ops-grid, .tester-grid { grid-template-columns: 1fr; }
      .engine-row, .route-row, .request-row, .usage-row, .kv { grid-template-columns: 1fr; }
      .section-head { display: block; }
      .section-head .pill, .section-head button { margin-top: 10px; }
      code { word-break: break-all; }
      .copy-btn { width: 100%; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>AI CLI Bridge</h1>
        <p>Local provider console.</p>
      </div>
      <button id="refresh">Refresh</button>
    </header>

    <section class="grid summary-grid">
      <div class="panel">
        <h2>Provider</h2>
        <span id="provider-pill" class="pill"><span class="dot"></span><span>Loading</span></span>
        <div id="uptime" class="metric">-</div>
        <div class="muted small">uptime</div>
      </div>
      <div class="panel">
        <h2>Claude</h2>
        <div id="claude-health" style="margin-top: 10px;">-</div>
        <div id="claude-inflight" class="metric">-</div>
        <div class="muted small">running now</div>
      </div>
      <div class="panel">
        <h2>Gemini</h2>
        <div id="gemini-health" style="margin-top: 10px;">-</div>
        <div id="gemini-inflight" class="metric">-</div>
        <div class="muted small">running now</div>
      </div>
      <div class="panel">
        <h2>Calls</h2>
        <div id="total-calls" class="metric">-</div>
        <div class="muted small">recent request window</div>
      </div>
      <div class="panel">
        <h2>Success</h2>
        <div id="success-calls" class="metric">-</div>
        <div class="muted small">recent 2xx/3xx</div>
      </div>
      <div class="panel">
        <h2>Average</h2>
        <div id="avg-latency" class="metric">-</div>
        <div class="muted small">latency</div>
      </div>
    </section>

    <section class="grid main-grid">
      <div class="panel">
        <div class="section-head">
          <div>
            <h2>Model Routes</h2>
            <p class="small">Public model IDs for apps and Hermes.</p>
          </div>
          <span class="pill"><span class="dot"></span><span id="route-count">-</span></span>
        </div>
        <div id="aliases"></div>
      </div>
      <div class="panel">
        <div class="section-head">
          <div>
            <h2>App Connection</h2>
            <p class="small">OpenAI-compatible local endpoint.</p>
          </div>
          <button class="copy-btn" data-copy-target="base-url">Copy Base</button>
        </div>
        <div class="kv"><span>Base</span><code id="base-url">-</code></div>
        <div class="kv"><span>Header</span><code>Authorization: Bearer &lt;key&gt;</code></div>
        <div class="kv"><span>Default</span><code id="default-route">-</code></div>
        <div class="form-row">
          <label>Examples</label>
          <div class="snippet-tabs">
            <button type="button" data-snippet="curl" aria-pressed="true">curl</button>
            <button type="button" data-snippet="js" aria-pressed="false">JS SDK</button>
            <button type="button" data-snippet="python" aria-pressed="false">Python SDK</button>
            <button type="button" data-snippet="hermes" aria-pressed="false">Hermes</button>
          </div>
          <pre id="snippet-output"></pre>
          <div class="actions"><button class="copy-btn" id="copy-snippet" type="button">Copy Example</button></div>
        </div>
      </div>
    </section>

    <section class="grid ops-grid">
      <div class="panel">
        <div class="section-head">
          <div>
            <h2>Engines</h2>
            <p class="small">Health and local upstream URLs.</p>
          </div>
        </div>
        <div id="engines"></div>
      </div>
      <div class="panel">
        <div class="section-head">
          <div>
            <h2>Local Request Telemetry</h2>
            <p class="small">In-memory request metadata only. No prompts or response bodies.</p>
          </div>
          <span id="error-pill" class="pill"><span class="dot"></span><span>-</span></span>
        </div>
        <div id="usage"></div>
      </div>
    </section>

    <section class="grid tester-grid">
      <div class="panel">
        <h2>Prompt Tester</h2>
        <div class="form-row">
          <label for="api-key">Provider API Key</label>
          <input id="api-key" type="password" autocomplete="off" placeholder="Bearer token">
        </div>
        <div class="form-row">
          <label for="model">Model Route</label>
          <select id="model"></select>
        </div>
        <div class="form-row">
          <label for="prompt">Prompt</label>
          <textarea id="prompt">Reply with exactly: bridge-dashboard-ok</textarea>
        </div>
        <div class="actions">
          <button id="run-test">Run</button>
          <span id="tester-status" class="muted small">Ready</span>
        </div>
      </div>
      <div class="panel">
        <h2>Response</h2>
        <pre id="tester-output">No response yet.</pre>
      </div>
    </section>

    <section class="panel" style="margin-top: 14px;">
      <div class="section-head">
        <div>
          <h2>Recent Calls</h2>
          <p class="small">Newest requests first, scoped to this provider process.</p>
        </div>
      </div>
      <div id="requests"></div>
    </section>
  </main>
  <script>
    const DEFAULT_MODEL = '${DEFAULT_ROUTE_ID}';
    let currentSnippet = 'curl';
    let latestData = null;
    const fmtUptime = (seconds) => {
      if (!Number.isFinite(seconds)) return '-';
      const s = Math.floor(seconds % 60);
      const m = Math.floor((seconds / 60) % 60);
      const h = Math.floor(seconds / 3600);
      return h ? h + 'h ' + m + 'm' : m ? m + 'm ' + s + 's' : s + 's';
    };
    const fmtMs = (value) => Number.isFinite(Number(value)) ? Math.round(Number(value)) + 'ms' : '-';
    const clsFor = (ok, busy) => ok ? (busy ? 'busy' : 'ok') : 'down';
    const pill = (label, cls) => '<span class="pill ' + cls + '"><span class="dot"></span><span>' + label + '</span></span>';
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const apiKey = document.getElementById('api-key');
    apiKey.value = localStorage.getItem('providerApiKey') || '';
    const snippetOutput = document.getElementById('snippet-output');

    function copyText(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(() => {});
      }
    }

    function buildSnippet(type, data) {
      const base = data.connection.baseUrl;
      const model = data.connection.defaultRoute || DEFAULT_MODEL;
      if (type === 'js') {
        return "import OpenAI from 'openai';\\n\\n" +
          "const client = new OpenAI({\\n" +
          "  baseURL: '" + base + "',\\n" +
          "  apiKey: process.env.AI_CLI_BRIDGE_API_KEY,\\n" +
          "});\\n\\n" +
          "const res = await client.chat.completions.create({\\n" +
          "  model: '" + model + "',\\n" +
          "  messages: [{ role: 'user', content: 'Summarize this for me.' }],\\n" +
          "});\\n\\n" +
          "console.log(res.choices[0].message.content);";
      }
      if (type === 'python') {
        return "from openai import OpenAI\\n\\n" +
          "client = OpenAI(\\n" +
          "    base_url='" + base + "',\\n" +
          "    api_key='test-key',\\n" +
          ")\\n\\n" +
          "res = client.chat.completions.create(\\n" +
          "    model='" + model + "',\\n" +
          "    messages=[{'role': 'user', 'content': 'Summarize this for me.'}],\\n" +
          ")\\n\\n" +
          "print(res.choices[0].message.content)";
      }
      if (type === 'hermes') {
        return 'hermes -z "Reply with exactly: bridge-ok" --provider ai-cli-bridge -m ' + model + ' -t ""';
      }
      return "curl -s " + base + "/chat/completions \\\\\\n" +
        "  -H 'Authorization: Bearer test-key' \\\\\\n" +
        "  -H 'Content-Type: application/json' \\\\\\n" +
        "  -d '{\\n" +
        '    "model": "' + model + '",\\n' +
        '    "messages": [{"role":"user","content":"Reply with exactly: bridge-ok"}]\\n' +
        "  }'";
    }

    function renderSnippet() {
      if (!latestData) return;
      snippetOutput.textContent = buildSnippet(currentSnippet, latestData);
      document.querySelectorAll('[data-snippet]').forEach((button) => {
        button.setAttribute('aria-pressed', button.dataset.snippet === currentSnippet ? 'true' : 'false');
      });
    }

    async function refresh() {
      const res = await fetch('/dashboard/status');
      const data = await res.json();
      latestData = data;
      document.getElementById('provider-pill').className = 'pill ok';
      document.querySelector('#provider-pill span:last-child').textContent = data.status;
      document.getElementById('uptime').textContent = fmtUptime(data.uptime);
      document.getElementById('claude-inflight').textContent = data.inflight.claude;
      document.getElementById('gemini-inflight').textContent = data.inflight.gemini;
      document.getElementById('claude-health').innerHTML = pill(data.engines.claude.ok ? 'online' : 'down', clsFor(data.engines.claude.ok, data.inflight.claude > 0));
      document.getElementById('gemini-health').innerHTML = pill(data.engines.gemini.ok ? 'online' : 'down', clsFor(data.engines.gemini.ok, data.inflight.gemini > 0));
      document.getElementById('base-url').textContent = data.connection.baseUrl;
      document.getElementById('default-route').textContent = data.connection.defaultRoute || DEFAULT_MODEL;
      document.getElementById('total-calls').textContent = data.telemetry.total;
      document.getElementById('success-calls').textContent = data.telemetry.success;
      document.getElementById('avg-latency').textContent = fmtMs(data.telemetry.avgDurationMs);
      document.getElementById('route-count').textContent = data.aliases.length + ' routes';
      const errors = data.telemetry.errors;
      const errorPill = document.getElementById('error-pill');
      errorPill.className = 'pill ' + (errors ? 'down' : 'ok');
      errorPill.querySelector('span:last-child').textContent = errors ? errors + ' errors' : 'no errors';

      document.getElementById('engines').innerHTML = Object.entries(data.engines).map(([name, e]) => {
        const busy = data.inflight[name] > 0;
        return '<div class="engine-row">' +
          '<strong>' + esc(name) + '</strong>' +
          pill(e.ok ? (busy ? 'busy' : 'online') : 'down', clsFor(e.ok, busy)) +
          '<code>' + esc(e.url) + '</code>' +
          '<span class="muted small">' + esc(e.durationMs) + 'ms</span>' +
        '</div>';
      }).join('');

      document.getElementById('aliases').innerHTML = data.aliases.map((a) =>
        '<div class="route-row">' +
          '<div class="route-label"><strong>' + esc(a.label) + '</strong><div class="model-id"><code>' + esc(a.id) + '</code></div></div>' +
          '<span class="model-meta">' + esc(a.engine) + '</span>' +
          '<span class="small">' + esc(a.upstreamModel) + '</span>' +
          '<span class="small">' + esc(a.bestFor) + '</span>' +
          '<button type="button" class="copy-btn" data-copy-value="' + esc(a.id) + '">Copy</button>' +
        '</div>'
      ).join('');

      document.getElementById('usage').innerHTML =
        '<div class="stack">' +
          '<div class="usage-row"><strong>Recent window</strong><span class="status-number">' + esc(data.telemetry.total) + '</span><span class="muted small">' + esc(data.telemetry.windowSize) + ' max</span></div>' +
          '<div class="usage-row"><strong>Success</strong><span class="status-number">' + esc(data.telemetry.success) + '</span><span class="muted small">2xx/3xx</span></div>' +
          '<div class="usage-row"><strong>Errors</strong><span class="status-number">' + esc(data.telemetry.errors) + '</span><span class="muted small">4xx/5xx</span></div>' +
          '<div class="usage-row"><strong>Claude calls</strong><span class="status-number">' + esc(data.telemetry.byEngine.claude || 0) + '</span><span class="muted small">recent</span></div>' +
          '<div class="usage-row"><strong>Gemini calls</strong><span class="status-number">' + esc(data.telemetry.byEngine.gemini || 0) + '</span><span class="muted small">recent</span></div>' +
          (data.telemetry.byRoute.length ? data.telemetry.byRoute.slice(0, 6).map((r) =>
            '<div class="usage-row"><strong>' + esc(r.label) + '</strong><span class="status-number">' + esc(r.count) + '</span><span class="muted small">' + esc(r.avgDurationMs) + 'ms avg</span></div>'
          ).join('') : '<div class="empty">No route usage recorded yet.</div>') +
          (data.telemetry.latestErrors.length ? '<div class="panel warning" style="padding: 10px;"><strong>Latest errors</strong>' + data.telemetry.latestErrors.map((e) =>
            '<div class="small" style="margin-top: 6px;"><code>' + esc(e.status) + '</code> ' + esc(e.label) + ' - ' + esc(e.message || 'no message') + '</div>'
          ).join('') + '</div>' : '') +
        '</div>';

      document.getElementById('requests').innerHTML = data.recentRequests.length ? data.recentRequests.map((r) =>
        '<div class="request-row">' +
          '<span class="muted small">' + esc(new Date(r.at).toLocaleTimeString()) + '</span>' +
          '<div><div class="model-name">' + esc(r.label || r.alias) + '</div><div class="model-id"><code>' + esc(r.alias) + '</code></div></div>' +
          '<span class="muted">' + esc(r.engine) + '</span>' +
          '<span>' + pill(esc(r.status), r.ok ? 'ok' : 'down') + '</span>' +
          '<span class="small">' + esc(r.durationMs) + 'ms</span>' +
        '</div>'
      ).join('') : '<div class="empty">No calls recorded since this provider bridge started.</div>';

      const model = document.getElementById('model');
      const selected = model.value || DEFAULT_MODEL;
      model.innerHTML = data.aliases.map((a) =>
        '<option value="' + esc(a.id) + '">' + esc(a.label) + ' - ' + esc(a.id) + '</option>'
      ).join('');
      model.value = data.aliases.some((a) => a.id === selected) ? selected : DEFAULT_MODEL;
      renderSnippet();
    }

    async function runPrompt() {
      const button = document.getElementById('run-test');
      const status = document.getElementById('tester-status');
      const output = document.getElementById('tester-output');
      localStorage.setItem('providerApiKey', apiKey.value);
      button.disabled = true;
      status.textContent = 'Running';
      output.textContent = '';
      try {
        const res = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + apiKey.value,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: document.getElementById('model').value,
            messages: [{ role: 'user', content: document.getElementById('prompt').value }],
          }),
        });
        const data = await res.json();
        output.textContent = data.choices && data.choices[0]
          ? data.choices[0].message.content
          : JSON.stringify(data, null, 2);
        status.textContent = res.ok ? 'Done' : 'Error ' + res.status;
      } catch (err) {
        output.textContent = err.message;
        status.textContent = 'Network error';
      } finally {
        button.disabled = false;
        refresh();
      }
    }
    document.getElementById('refresh').addEventListener('click', refresh);
    document.getElementById('run-test').addEventListener('click', runPrompt);
    document.getElementById('copy-snippet').addEventListener('click', () => copyText(snippetOutput.textContent));
    document.querySelectorAll('[data-snippet]').forEach((button) => {
      button.addEventListener('click', () => {
        currentSnippet = button.dataset.snippet;
        renderSnippet();
      });
    });
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-copy-value], [data-copy-target]');
      if (!button) return;
      if (button.dataset.copyValue) copyText(button.dataset.copyValue);
      if (button.dataset.copyTarget) copyText(document.getElementById(button.dataset.copyTarget).textContent);
    });
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}

app.use('/v1', (req, res, next) => {
  if (!API_KEY) return next();
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(token);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return sendError(res, 401, 'Missing or invalid Authorization bearer token.', 'invalid_request_error', 'Authorization');
  }
  next();
});

app.get(['/', '/dashboard'], (req, res) => {
  res.type('html').send(dashboardHtml());
});

app.get('/dashboard/status', async (req, res) => {
  const [claudeHealth, geminiHealth] = await Promise.all([
    checkEngineHealth('claude'),
    checkEngineHealth('gemini'),
  ]);
  const origin = `${req.protocol}://${req.get('host')}`;
  const telemetry = buildDashboardTelemetry();
  res.json({
    status: 'ok',
    engine: 'provider-bridge',
    authEnabled: Boolean(API_KEY),
    uptime: process.uptime(),
    inflight: { ...inflight },
    engines: {
      claude: { url: CLAUDE_BRIDGE_URL, ...claudeHealth },
      gemini: { url: GEMINI_BRIDGE_URL, ...geminiHealth },
    },
    connection: {
      baseUrl: `${origin}/v1`,
      chatCompletionsUrl: `${origin}/v1/chat/completions`,
      authHeader: API_KEY ? 'Authorization: Bearer <key>' : 'none',
      defaultRoute: DEFAULT_ROUTE_ID,
    },
    aliases: VISIBLE_ROUTES.map(routeSummary),
    telemetry,
    recentRequests: recentRequests.map((request) => ({
      ...request,
      label: routeDisplayFor(request.alias).label,
      ok: Number(request.status) >= 200 && Number(request.status) < 400,
    })),
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    engine: 'provider-bridge',
    uptime: process.uptime(),
    inflightClaude: inflight.claude,
    inflightGemini: inflight.gemini,
  });
});

app.get('/v1/models', (req, res) => {
  const created = Math.floor(Date.now() / 1000);
  const data = VISIBLE_ROUTES.map((route) => ({
    id: route.id,
    object: 'model',
    created,
    owned_by: route.engine,
  }));
  res.json({ object: 'list', data });
});

app.post('/v1/chat/completions', async (req, res) => {
  const reqId = newRequestId();
  const started = Date.now();
  const body = req.body || {};
  const alias = body.model;
  const logEnd = (status, engine, message = '') =>
    logReq(reqId, { alias: alias || '?', engine: engine || '-', status, duration: Date.now() - started, message });

  const unsupportedChecks = [
    ['logprobs', body.logprobs],
    ['response_format', body.response_format],
  ];
  for (const [name, val] of unsupportedChecks) {
    if (val !== undefined && val !== null && val !== false) {
      console.log(`[req ${reqId}] rejected unsupported parameter: ${name}`);
      logEnd(400, '-', `Unsupported parameter: ${name}`);
      return sendError(res, 400, `Parameter "${name}" is not supported by provider-bridge.`, 'unsupported_parameter', name);
    }
  }

  const mapping = ALIASES[alias];
  if (!mapping) {
    logEnd(400, '-', `Unknown model: ${alias}`);
    return sendError(res, 400, `Model "${alias}" is not a known provider route.`, 'invalid_model', 'model');
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    logEnd(400, '-', 'Missing or empty messages');
    return sendError(res, 400, '`messages` must be a non-empty array.', 'invalid_request_error', 'messages');
  }
  for (const m of messages) {
    if (!m || typeof m !== 'object') {
      logEnd(400, '-', 'Invalid message object');
      return sendError(res, 400, 'Each message must be an object.', 'invalid_request_error', 'messages');
    }
    if (!['system', 'user', 'assistant'].includes(m.role)) {
      logEnd(400, '-', `Unsupported message role: ${m.role}`);
      return sendError(res, 400, `Message role "${m.role}" is not supported.`, 'invalid_request_error', 'messages');
    }
    if (Array.isArray(m.content)) {
      logEnd(400, '-', 'Multimodal content is not supported');
      return sendError(res, 400, 'Multimodal content (image/audio arrays) is not supported.', 'unsupported_parameter', 'messages');
    }
    if (typeof m.content !== 'string') {
      logEnd(400, '-', 'Message content must be a string');
      return sendError(res, 400, 'Message content must be a string.', 'invalid_request_error', 'messages');
    }
  }

  if (inflight[mapping.engine] >= MAX_CONCURRENT_PER_ENGINE) {
    logEnd(429, mapping.engine, `Engine "${mapping.engine}" is busy`);
    return sendError(
      res,
      429,
      `Engine "${mapping.engine}" is busy (max concurrent ${MAX_CONCURRENT_PER_ENGINE}). Please retry shortly.`,
      'engine_busy',
    );
  }

  inflight[mapping.engine] += 1;
  try {
    const hasToolMetadata = Boolean(
      body.tools
      || body.functions
      || body.function_call
      || body.tool_choice
    );
    if (hasToolMetadata) {
      console.log(`[req ${reqId}] received tool/function metadata; running text-only compatibility mode`);
    }
    const prompt = messagesToPrompt(messages, { textOnlyTools: hasToolMetadata });
    const payload = { task: 'chat', prompt };
    if (mapping.model) payload.model = mapping.model;

    let upstream;
    try {
      upstream = await callUpstream(mapping.engine, payload);
    } catch (err) {
      logEnd(502, mapping.engine, err.message);
      return sendError(res, 502, `Failed to reach upstream "${mapping.engine}": ${err.message}`, 'upstream_error');
    }

    if (upstream.status < 200 || upstream.status >= 300) {
      let detail = upstream.body || '';
      try {
        const parsed = JSON.parse(upstream.body);
        detail = parsed.error || parsed.message || upstream.body;
      } catch (_) { /* keep raw body */ }
      logEnd(502, mapping.engine, String(detail).slice(0, 160));
      return sendError(
        res,
        502,
        `Upstream "${mapping.engine}" returned status ${upstream.status}: ${String(detail).slice(0, 300)}`,
        'upstream_error',
      );
    }

    let text = '';
    try {
      const parsed = JSON.parse(upstream.body);
      text = parsed.text !== undefined ? parsed.text : (parsed.result !== undefined ? parsed.result : upstream.body);
    } catch (_) {
      text = upstream.body;
    }
    if (typeof text !== 'string') text = JSON.stringify(text);

    const completion = {
      id: 'chatcmpl-' + crypto.randomBytes(8).toString('hex'),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: alias,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    logEnd(200, mapping.engine);
    if (body.stream === true) {
      return sendStreamingCompletion(res, completion);
    }
    return res.status(200).json(completion);
  } finally {
    inflight[mapping.engine] -= 1;
  }
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Provider bridge running on port ${PORT}`);
  console.log(`Auth: ${API_KEY ? 'ENABLED (Bearer token required)' : 'DISABLED (open)'}`);
  console.log(`Claude bridge: ${CLAUDE_BRIDGE_URL}`);
  console.log(`Gemini bridge: ${GEMINI_BRIDGE_URL}`);
  console.log(`Max concurrent per engine: ${MAX_CONCURRENT_PER_ENGINE}`);
  console.log(`Upstream timeout: ${UPSTREAM_TIMEOUT_MS}ms`);
});
