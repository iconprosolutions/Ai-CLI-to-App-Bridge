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

const ALIASES = {
  'auto-reasoning': { engine: 'claude' },
  'auto-fast': { engine: 'gemini' },
  'auto-long-context': { engine: 'gemini' },
  'claude-subscription-default': { engine: 'claude' },
  'claude-subscription-sonnet': { engine: 'claude', model: 'claude-sonnet-4-6' },
  'claude-subscription-opus': { engine: 'claude', model: 'claude-opus-4-5' },
  'gemini-cli-flash': { engine: 'gemini' },
  'gemini-cli-pro': { engine: 'gemini', model: 'Gemini 3.1 Pro (Low)' },
};

const inflight = { claude: 0, gemini: 0 };

function newRequestId() {
  return crypto.randomBytes(6).toString('hex');
}

function logReq(reqId, fields) {
  const parts = [`[req ${reqId}]`];
  for (const [k, v] of Object.entries(fields)) parts.push(`${k}=${v}`);
  console.log(parts.join(' '));
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
  const data = Object.keys(ALIASES).map((id) => ({
    id,
    object: 'model',
    created,
    owned_by: ALIASES[id].engine,
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
    return sendError(res, 400, `Model "${alias}" is not a known provider alias.`, 'invalid_model', 'model');
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
