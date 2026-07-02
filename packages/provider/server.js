'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');

const {
  httpFor, BridgeError, createSmoothPacer, installGracefulShutdown, intEnv, strEnv,
  extractJson, assertJsonSchema,
} = require('@bridge/core');
const { createClaudeAdapter, createAgyAdapter } = require('@bridge/adapters');
const { createRouteRegistry } = require('./routes');
const { createTelemetry } = require('./telemetry');
const { createUsageLedger } = require('./usage');
const { createBreaker } = require('./breaker');
const { createSemaphore } = require('./semaphore');
const { createEventBus } = require('./events');
const { createCapture } = require('./capture');
const { createAdminRouter } = require('./admin');
const {
  estimateTokens, parseToolCallsFromText, messagesToPrompt, openaiErrorBody,
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
app.use(express.json({ limit: '10mb' }));

const PORT = intEnv('PROVIDER_PORT', 9011);
// Bind to loopback by default; opt in to 0.0.0.0 only when you mean to expose it.
const BIND_HOST = strEnv('BIND_HOST', '127.0.0.1');
const API_KEY = process.env.PROVIDER_API_KEY || process.env.BRIDGE_API_KEY || '';
const MAX_CONCURRENT_PER_ENGINE = Math.max(1, intEnv('PROVIDER_MAX_CONCURRENT_PER_ENGINE', 1));

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

const events = createEventBus();
const capture = createCapture({ max: 50 });
const activeRequests = new Map(); // reqId → {id, routeId, engine, appId, startedAt, streaming, ac, killedByAdmin}
const enginesDisabled = {};
const breakers = {};
const semaphores = {};
for (const e of ENGINE_NAMES) {
  enginesDisabled[e] = false;
  breakers[e] = createBreaker({
    engine: e,
    quotaCooldownMs: intEnv('BREAKER_QUOTA_COOLDOWN_MS', 15 * 60 * 1000),
    timeoutCooldownMs: intEnv('BREAKER_TIMEOUT_COOLDOWN_MS', 2 * 60 * 1000),
    onChange: (s) => {
      console.log(`[breaker] ${e} → ${s.state}${s.reason ? ` (${s.reason})` : ''}`);
      events.emit('breaker.change', s);
    },
  });
  semaphores[e] = createSemaphore({
    max: MAX_CONCURRENT_PER_ENGINE,
    queueDepth: intEnv('PROVIDER_QUEUE_DEPTH', 4),
    queueTimeoutMs: intEnv('PROVIDER_QUEUE_TIMEOUT_MS', 30000),
  });
}

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

function appIdFrom(req) {
  const raw = req.headers['x-app-id'] || req.headers['x-client-id'] || '';
  const cleaned = String(raw).trim().slice(0, 64);
  return cleaned && /^[A-Za-z0-9_.\- ]+$/.test(cleaned) ? cleaned : 'default';
}

function sendError(res, status, message, type, param, retryAfterSec) {
  if (retryAfterSec) res.set('Retry-After', String(retryAfterSec));
  return res.status(status).json(openaiErrorBody(message, type, param));
}

// ── Auth (OpenAI error envelope, /v1 only) ─────────────────────────────
app.use('/v1', (req, res, next) => {
  if (!API_KEY) return next();
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(token);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return sendError(res, 401, 'Missing or invalid Authorization bearer token.', 'invalid_request_error', 'Authorization');
  }
  return next();
});

// ── Dashboard (static control center) + health ─────────────────────────
// Static middleware passes unknown paths through, so the /dashboard/status,
// /dashboard/events, and /dashboard/usage handlers below keep working.
app.get('/', (req, res) => res.redirect('/dashboard/'));
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));

app.get('/dashboard/status', async (req, res) => {
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
  const origin = `${req.protocol}://${req.get('host')}`;
  res.json({
    status: 'ok',
    engine: 'provider-bridge',
    authEnabled: Boolean(API_KEY),
    uptime: process.uptime(),
    inflight: Object.fromEntries(ENGINE_NAMES.map((e) => [e, semaphores[e].active])),
    queue: Object.fromEntries(ENGINE_NAMES.map((e) => [e, semaphores[e].queued])),
    breakers: Object.fromEntries(ENGINE_NAMES.map((e) => [e, breakers[e].status()])),
    capture: { enabled: capture.enabled, count: capture.size },
    activeRequests: [...activeRequests.values()].map((a) => ({
      id: a.id, routeId: a.routeId, engine: a.engine, appId: a.appId, startedAt: a.startedAt, streaming: a.streaming,
    })),
    engines,
    connection: {
      baseUrl: `${origin}/v1`,
      chatCompletionsUrl: `${origin}/v1/chat/completions`,
      authHeader: API_KEY ? 'Authorization: Bearer <key>' : 'none',
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
    inflightClaude: semaphores.claude.active,
    inflightGemini: semaphores.gemini.active,
  });
});

// Live event stream for the dashboard (SSE).
app.get('/dashboard/events', events.handler);

// Control plane (always key-gated; see admin.js).
app.use('/admin', createAdminRouter({
  apiKey: API_KEY, registry, breakers, adapters, activeRequests, capture, events, enginesDisabled,
}));

// Durable usage rollups (JSONL ledger; survives restarts).
app.get('/dashboard/usage', async (req, res) => {
  const range = ['today', '7d', '30d', 'all'].includes(String(req.query.range)) ? String(req.query.range) : '7d';
  res.json(await ledger.aggregate(range));
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
app.post('/v1/chat/completions', async (req, res) => {
  const reqId = newRequestId();
  const started = Date.now();
  const body = req.body || {};
  const aliasUsed = body.model;
  const route = registry.resolve(aliasUsed);
  const appId = appIdFrom(req);
  let estPromptTokens = 0;
  let estCompletionTokens = 0;
  let usageSource = 'estimated';

  const record = (status) => {
    telemetry.record({
      id: reqId,
      appId,
      aliasUsed: aliasUsed || '?',
      routeId: route ? route.id : null,
      label: route ? route.label : (aliasUsed || '?'),
      engine: route ? route.engine : null,
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
        routeId: route.id,
        engine: route.engine,
        model: route.model,
        promptTokens: estPromptTokens,
        completionTokens: estCompletionTokens,
        usageSource,
        durationMs: Date.now() - started,
        status,
      });
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
  const ignoredParams = ['temperature', 'top_p', 'max_tokens', 'stop', 'presence_penalty', 'frequency_penalty']
    .filter((p) => body[p] !== undefined && body[p] !== null);

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

  // Circuit breaker: a known-exhausted engine fails fast with Retry-After
  // instead of spawning a doomed CLI run. Half-open admits one trial.
  const gate = breakers[route.engine].allow();
  if (!gate.allowed) {
    record(429);
    return sendError(
      res,
      429,
      `Engine "${route.engine}" circuit is open (${gate.reason || 'capacity'}). Failing fast; retry in ~${gate.retryInSec}s.`,
      'rate_limit_error',
      null,
      gate.retryInSec,
    );
  }

  const adapter = adapters[route.engine];
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
    startedAt: new Date().toISOString(),
    streaming: body.stream === true,
    ac,
    killedByAdmin: false,
  };
  activeRequests.set(reqId, active);
  events.emit('request.start', { id: reqId, routeId: route.id, engine: route.engine, appId, streaming: active.streaming });

  let release;
  try {
    release = await semaphores[route.engine].acquire(ac.signal);
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
    const toolsList = body.tools || body.functions;
    // tool_choice: 'none' disables tools entirely; 'required' or a named
    // function demands a call (enforced with one corrective retry on the
    // non-streaming path).
    const tc = body.tool_choice;
    let toolChoice = 'auto';
    let forcedToolName = null;
    if (tc === 'none') toolChoice = 'none';
    else if (tc === 'required') toolChoice = 'required';
    else if (tc && typeof tc === 'object' && tc.type === 'function' && tc.function && tc.function.name) {
      toolChoice = 'required';
      forcedToolName = tc.function.name;
    }
    // Only ever interpret model output as tool calls when the caller actually
    // sent tools — otherwise a reply that *discusses* a tool_calls payload
    // would be hijacked into a real tool call.
    const toolsProvided = Array.isArray(toolsList) && toolsList.length > 0 && toolChoice !== 'none';
    const prompt = messagesToPrompt(messages, {
      tools: toolsProvided ? toolsList : null,
      toolChoice,
      forcedToolName,
      responseFormat: body.response_format,
    });
    estPromptTokens = estimateTokens(prompt);

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
    const breakerFeedback = (err) => {
      if (!err) return breakers[route.engine].recordSuccess();
      if (err.kind === 'aborted') return undefined; // says nothing about the engine
      return breakers[route.engine].recordFailure(err.kind); // quota/timeout count; others reset streaks
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
        const retry = await adapter.invoke({ prompt: retryPrompt, model: route.model, signal: ac.signal });
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
      res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);

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

      const pacer = createSmoothPacer((deltaText) => {
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
      const feed = (d) => {
        markFirstByte();
        if (!holding) { pacer.push(d); return; }
        held += d;
        const head = held.trimStart();
        if (!head) return;
        if (!(head.startsWith('```') || head.startsWith('{')) || held.length > HOLD_CAP) {
          holding = false;
          pacer.push(held);
          held = '';
        }
      };

      let result;
      try {
        result = await adapter.invoke({
          prompt, model: route.model, signal: ac.signal, onDelta: feed,
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

      const detectedTools = toolsProvided ? parseToolCallsFromText(result.text) : null;
      if (holding && held && !detectedTools) {
        pacer.push(held); // looked like JSON but wasn't a tool call — deliver it
        held = '';
      }
      await pacer.drain();
      applyUsage(result);
      breakerFeedback();
      capFinish(200, result);
      record(200);

      if (detectedTools) {
        res.write(`data: ${JSON.stringify({
          ...chunkBase,
          choices: [{
            index: 0,
            delta: { tool_calls: detectedTools.map((tc, i) => ({ index: i, ...tc })) },
            finish_reason: 'tool_calls',
          }],
        })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
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
      result = await adapter.invoke({ prompt, model: route.model, signal: ac.signal, onDelta: markFirstByte });
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
    // tool_choice=required / named-function enforcement: one corrective retry.
    const satisfiesChoice = () => {
      if (toolChoice !== 'required') return true;
      if (!detectedTools) return false;
      return !forcedToolName || detectedTools.some((t) => t.function.name === forcedToolName);
    };
    if (toolsProvided && !satisfiesChoice()) {
      const demand = forcedToolName
        ? `a call to the tool "${forcedToolName}"`
        : 'a tool call';
      const retryPrompt = `${prompt}\n\n[ASSISTANT]\n${text}\n\n[SYSTEM]\nThe reply above is not acceptable: this request requires ${demand}. Respond with ONLY the \`\`\`json\`\`\` tool_calls block — no plain text.`;
      let retry;
      try {
        retry = await adapter.invoke({ prompt: retryPrompt, model: route.model, signal: ac.signal });
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
      if (!satisfiesChoice()) {
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
          finish_reason: detectedTools ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: estPromptTokens,
        completion_tokens: estCompletionTokens,
        total_tokens: estPromptTokens + estCompletionTokens,
      },
    };
    if (ignoredParams.length) completion.bridge_ignored_params = ignoredParams;
    record(200);
    return res.status(200).json(completion);
  } finally {
    release();
    activeRequests.delete(reqId);
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

const server = app.listen(PORT, BIND_HOST, () => {
  console.log(`Provider (consolidated) running on ${BIND_HOST}:${PORT}`);
  console.log(`Auth: ${API_KEY ? 'ENABLED (Bearer token required)' : 'DISABLED (open)'}`);
  console.log(`Engines: ${ENGINE_NAMES.map((e) => `${e} (in-process)`).join(', ')}`);
  console.log(`Max concurrent per engine: ${MAX_CONCURRENT_PER_ENGINE}`);
  console.log(`Routes: ${registry.list().map((r) => r.id).join(', ')}`);
  if (!API_KEY && BIND_HOST !== '127.0.0.1' && BIND_HOST !== 'localhost') {
    console.warn(`WARNING: provider bound to ${BIND_HOST} with no API key set — anyone who can reach this port can spend your Claude/Gemini quota. Set PROVIDER_API_KEY or bind to 127.0.0.1.`);
  }
});

// A bridge dying must never orphan a quota-burning CLI run (audit H7).
installGracefulShutdown({ server });

module.exports = { app, server };
