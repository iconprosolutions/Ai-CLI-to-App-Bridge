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

const ROUTES = [
  {
    id: 'bridge-fast',
    label: 'Fast',
    engine: 'gemini',
    model: 'Gemini 3.5 Flash (Low)',
    bestFor: 'Quick app calls, summaries, drafts',
  },
  {
    id: 'bridge-smart',
    label: 'Smart',
    engine: 'claude',
    model: 'claude-sonnet-4-6',
    bestFor: 'Planning, coding, careful reasoning',
  },
  {
    id: 'bridge-long',
    label: 'Long Context',
    engine: 'gemini',
    model: 'Gemini 3.1 Pro (Low)',
    bestFor: 'Long documents and broad project scans',
  },
  {
    id: 'bridge-deep',
    label: 'Deep',
    engine: 'claude',
    model: 'claude-opus-4-5',
    bestFor: 'Hard reasoning when limits allow',
  },
  {
    id: 'gemini-flash',
    label: 'Gemini Flash',
    engine: 'gemini',
    model: 'Gemini 3.5 Flash (Low)',
    bestFor: 'Direct Gemini fast route',
  },
  {
    id: 'gemini-pro',
    label: 'Gemini Pro',
    engine: 'gemini',
    model: 'Gemini 3.1 Pro (Low)',
    bestFor: 'Direct Gemini stronger route',
  },
  {
    id: 'claude-sonnet',
    label: 'Claude Sonnet',
    engine: 'claude',
    model: 'claude-sonnet-4-6',
    bestFor: 'Direct Claude Sonnet route',
  },
  {
    id: 'claude-opus',
    label: 'Claude Opus',
    engine: 'claude',
    model: 'claude-opus-4-5',
    bestFor: 'Direct Claude Opus route',
  },
  { id: 'auto-fast', hidden: true, legacyOf: 'bridge-fast', engine: 'gemini', model: 'Gemini 3.5 Flash (Low)' },
  { id: 'auto-reasoning', hidden: true, legacyOf: 'bridge-smart', engine: 'claude', model: 'claude-sonnet-4-6' },
  { id: 'auto-long-context', hidden: true, legacyOf: 'bridge-long', engine: 'gemini', model: 'Gemini 3.1 Pro (Low)' },
  { id: 'gemini-cli-flash', hidden: true, legacyOf: 'gemini-flash', engine: 'gemini', model: 'Gemini 3.5 Flash (Low)' },
  { id: 'gemini-cli-pro', hidden: true, legacyOf: 'gemini-pro', engine: 'gemini', model: 'Gemini 3.1 Pro (Low)' },
  { id: 'claude-subscription-default', hidden: true, legacyOf: 'bridge-smart', engine: 'claude', model: 'claude-sonnet-4-6' },
  { id: 'claude-subscription-sonnet', hidden: true, legacyOf: 'claude-sonnet', engine: 'claude', model: 'claude-sonnet-4-6' },
  { id: 'claude-subscription-opus', hidden: true, legacyOf: 'claude-opus', engine: 'claude', model: 'claude-opus-4-5' },
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
  });
  recentRequests.splice(MAX_RECENT_REQUESTS);
}

function openaiErrorBody(message, type, param) {
  return { error: { message, type, param: param === undefined ? null : param, code: null } };
}

function sendError(res, status, message, type, param) {
  return res.status(status).json(openaiErrorBody(message, type, param));
}

function messagesToPrompt(messages) {
  return messages
    .map((m) => `[${String(m.role).toUpperCase()}]\n${m.content}`)
    .join('\n\n');
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
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #17191f;
      --muted: #667085;
      --line: #d9dee8;
      --good: #147d4f;
      --bad: #b42318;
      --warn: #b54708;
      --accent: #2563eb;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main { max-width: 1280px; margin: 0 auto; padding: 28px 18px 40px; }
    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 18px;
      margin-bottom: 22px;
    }
    h1 { margin: 0; font-size: 30px; line-height: 1.1; letter-spacing: 0; }
    h2 { margin: 0 0 12px; font-size: 16px; letter-spacing: 0; }
    p { margin: 6px 0 0; color: var(--muted); }
    button {
      appearance: none;
      border: 1px solid var(--line);
      background: var(--panel);
      color: var(--text);
      min-height: 38px;
      padding: 0 14px;
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
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
    .overview-grid { grid-template-columns: .9fr .75fr .75fr 1.4fr; }
    .two { grid-template-columns: minmax(0, .9fr) minmax(0, 1.5fr); margin-top: 14px; }
    .tester-grid { grid-template-columns: minmax(0, .9fr) minmax(0, 1.1fr); margin-top: 14px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
    }
    .metric { font-size: 28px; font-weight: 750; margin-top: 8px; }
    .muted { color: var(--muted); }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 26px;
      padding: 0 10px;
      border-radius: 999px;
      border: 1px solid var(--line);
      font-size: 13px;
      font-weight: 650;
      color: var(--muted);
      background: #fbfcfe;
    }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
    .ok .dot { background: var(--good); }
    .down .dot { background: var(--bad); }
    .busy .dot { background: var(--warn); }
    .engine-row, .model-row, .request-row {
      display: grid;
      gap: 8px;
      align-items: center;
      padding: 10px 0;
      border-top: 1px solid var(--line);
    }
    .engine-row { grid-template-columns: 86px 96px minmax(0, 1fr) 62px; }
    .model-row { grid-template-columns: minmax(150px, .8fr) minmax(120px, .6fr) minmax(180px, 1fr) minmax(180px, 1fr); }
    .request-row { grid-template-columns: 88px minmax(140px, 1fr) 90px 88px; }
    .engine-row:first-of-type, .model-row:first-of-type, .request-row:first-of-type { border-top: 0; }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 13px;
      background: #f1f4f8;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 2px 6px;
      overflow-wrap: anywhere;
    }
    .kv {
      display: grid;
      grid-template-columns: 78px minmax(0, 1fr);
      gap: 8px;
      align-items: center;
      margin-top: 10px;
    }
    .kv span, .model-meta { color: var(--muted); font-size: 13px; }
    .model-name { font-weight: 750; }
    .model-id { margin-top: 3px; }
    .model-id code, .kv code, .engine-row code, .request-row code { display: block; width: 100%; }
    .small { font-size: 13px; }
    .empty { color: var(--muted); padding: 12px 0 4px; }
    .form-row { margin-top: 12px; }
    .actions { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
    .actions button { background: var(--accent); border-color: var(--accent); color: white; }
    .actions button:disabled { cursor: wait; opacity: .7; }
    @media (max-width: 820px) {
      header { display: block; }
      button { margin-top: 14px; width: 100%; }
      .grid, .overview-grid, .two, .tester-grid { grid-template-columns: 1fr; }
      .engine-row, .model-row, .request-row, .kv { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>AI CLI Bridge</h1>
        <p>Local provider facade for Claude Code and Antigravity/Gemini CLI.</p>
      </div>
      <button id="refresh">Refresh</button>
    </header>

    <section class="grid overview-grid">
      <div class="panel">
        <h2>Provider</h2>
        <span id="provider-pill" class="pill"><span class="dot"></span><span>Loading</span></span>
        <div id="uptime" class="metric">-</div>
        <div class="muted small">uptime</div>
      </div>
      <div class="panel">
        <h2>Claude Slot</h2>
        <div id="claude-inflight" class="metric">-</div>
        <div class="muted small">requests running</div>
      </div>
      <div class="panel">
        <h2>Gemini Slot</h2>
        <div id="gemini-inflight" class="metric">-</div>
        <div class="muted small">requests running</div>
      </div>
      <div class="panel">
        <h2>App Connection</h2>
        <div class="kv"><span>Base</span><code id="base-url">-</code></div>
        <div class="kv"><span>Header</span><code>Authorization: Bearer &lt;key&gt;</code></div>
        <div class="kv"><span>Default</span><code>bridge-fast</code></div>
      </div>
    </section>

    <section class="grid two">
      <div class="panel">
        <h2>Engines</h2>
        <div id="engines"></div>
      </div>
      <div class="panel">
        <h2>Models For Apps</h2>
        <div id="aliases"></div>
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
      <h2>Recent Calls</h2>
      <div id="requests"></div>
    </section>
  </main>
  <script>
    const fmtUptime = (seconds) => {
      if (!Number.isFinite(seconds)) return '-';
      const s = Math.floor(seconds % 60);
      const m = Math.floor((seconds / 60) % 60);
      const h = Math.floor(seconds / 3600);
      return h ? h + 'h ' + m + 'm' : m ? m + 'm ' + s + 's' : s + 's';
    };
    const clsFor = (ok, busy) => ok ? (busy ? 'busy' : 'ok') : 'down';
    const pill = (label, cls) => '<span class="pill ' + cls + '"><span class="dot"></span><span>' + label + '</span></span>';
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const apiKey = document.getElementById('api-key');
    apiKey.value = localStorage.getItem('providerApiKey') || '';

    async function refresh() {
      const res = await fetch('/dashboard/status');
      const data = await res.json();
      document.getElementById('provider-pill').className = 'pill ok';
      document.querySelector('#provider-pill span:last-child').textContent = data.status;
      document.getElementById('uptime').textContent = fmtUptime(data.uptime);
      document.getElementById('claude-inflight').textContent = data.inflight.claude;
      document.getElementById('gemini-inflight').textContent = data.inflight.gemini;
      document.getElementById('base-url').textContent = data.connection.baseUrl;

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
        '<div class="model-row">' +
          '<div><div class="model-name">' + esc(a.label) + '</div><div class="model-id"><code>' + esc(a.id) + '</code></div></div>' +
          '<span class="model-meta">' + esc(a.engine) + '</span>' +
          '<span class="small">' + esc(a.bestFor) + '</span>' +
          '<span class="small">' + esc(a.upstreamModel) + '</span>' +
        '</div>'
      ).join('');

      document.getElementById('requests').innerHTML = data.recentRequests.length ? data.recentRequests.map((r) =>
        '<div class="request-row">' +
          '<span class="muted small">' + esc(new Date(r.at).toLocaleTimeString()) + '</span>' +
          '<div><div class="model-name">' + esc(r.label || r.alias) + '</div><div class="model-id"><code>' + esc(r.alias) + '</code></div></div>' +
          '<span class="muted">' + esc(r.engine) + '</span>' +
          '<span class="small">' + esc(r.status) + ' / ' + esc(r.durationMs) + 'ms</span>' +
        '</div>'
      ).join('') : '<div class="empty">No calls recorded since this provider bridge started.</div>';

      const model = document.getElementById('model');
      const selected = model.value || 'bridge-fast';
      model.innerHTML = data.aliases.map((a) =>
        '<option value="' + esc(a.id) + '">' + esc(a.label) + ' - ' + esc(a.id) + '</option>'
      ).join('');
      model.value = data.aliases.some((a) => a.id === selected) ? selected : 'bridge-fast';
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
    },
    aliases: VISIBLE_ROUTES.map((route) => ({
      id: route.id,
      label: route.label,
      engine: route.engine,
      bestFor: route.bestFor,
      upstreamModel: route.model,
    })),
    recentRequests: recentRequests.map((request) => ({
      ...request,
      label: ALIASES[request.alias] ? ALIASES[request.alias].label || ALIASES[request.alias].legacyOf : request.alias,
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
  const logEnd = (status, engine) =>
    logReq(reqId, { alias: alias || '?', engine: engine || '-', status, duration: Date.now() - started });

  const unsupportedChecks = [
    ['stream', body.stream],
    ['tools', body.tools],
    ['functions', body.functions],
    ['function_call', body.function_call],
    ['tool_choice', body.tool_choice],
    ['logprobs', body.logprobs],
    ['response_format', body.response_format],
  ];
  for (const [name, val] of unsupportedChecks) {
    if (val !== undefined && val !== null && val !== false) {
      logEnd(400, '-');
      return sendError(res, 400, `Parameter "${name}" is not supported by provider-bridge.`, 'unsupported_parameter', name);
    }
  }

  const mapping = ALIASES[alias];
  if (!mapping) {
    logEnd(400, '-');
    return sendError(res, 400, `Model "${alias}" is not a known provider route.`, 'invalid_model', 'model');
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    logEnd(400, '-');
    return sendError(res, 400, '`messages` must be a non-empty array.', 'invalid_request_error', 'messages');
  }
  for (const m of messages) {
    if (!m || typeof m !== 'object') {
      logEnd(400, '-');
      return sendError(res, 400, 'Each message must be an object.', 'invalid_request_error', 'messages');
    }
    if (!['system', 'user', 'assistant'].includes(m.role)) {
      logEnd(400, '-');
      return sendError(res, 400, `Message role "${m.role}" is not supported.`, 'invalid_request_error', 'messages');
    }
    if (Array.isArray(m.content)) {
      logEnd(400, '-');
      return sendError(res, 400, 'Multimodal content (image/audio arrays) is not supported.', 'unsupported_parameter', 'messages');
    }
    if (typeof m.content !== 'string') {
      logEnd(400, '-');
      return sendError(res, 400, 'Message content must be a string.', 'invalid_request_error', 'messages');
    }
  }

  if (inflight[mapping.engine] >= MAX_CONCURRENT_PER_ENGINE) {
    logEnd(429, mapping.engine);
    return sendError(
      res,
      429,
      `Engine "${mapping.engine}" is busy (max concurrent ${MAX_CONCURRENT_PER_ENGINE}). Please retry shortly.`,
      'engine_busy',
    );
  }

  inflight[mapping.engine] += 1;
  try {
    const prompt = messagesToPrompt(messages);
    const payload = { task: 'chat', prompt };
    if (mapping.model) payload.model = mapping.model;

    let upstream;
    try {
      upstream = await callUpstream(mapping.engine, payload);
    } catch (err) {
      logEnd(502, mapping.engine);
      return sendError(res, 502, `Failed to reach upstream "${mapping.engine}": ${err.message}`, 'upstream_error');
    }

    if (upstream.status < 200 || upstream.status >= 300) {
      let detail = upstream.body || '';
      try {
        const parsed = JSON.parse(upstream.body);
        detail = parsed.error || parsed.message || upstream.body;
      } catch (_) { /* keep raw body */ }
      logEnd(502, mapping.engine);
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
