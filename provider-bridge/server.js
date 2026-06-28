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

const PORT = Number(process.env.PROVIDER_PORT) || 9011;
// Bind to loopback by default; opt in to 0.0.0.0 only when you mean to expose it.
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
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

const PUBLIC_ROUTES = [
  {
    id: 'bridge-agy-gemini-3.5-flash-medium-pulse',
    label: 'Bridge AGY Gemini 3.5 Flash Medium · Pulse',
    engine: 'gemini',
    model: 'Gemini 3.5 Flash (Medium)',
    bestFor: 'Balanced everyday app calls',
  },
  {
    id: 'bridge-agy-gemini-3.5-flash-high-forge',
    label: 'Bridge AGY Gemini 3.5 Flash High · Forge',
    engine: 'gemini',
    model: 'Gemini 3.5 Flash (High)',
    bestFor: 'Stronger fast reasoning',
  },
  {
    id: 'bridge-agy-gemini-3.1-pro-high-atlas',
    label: 'Bridge AGY Gemini 3.1 Pro High · Atlas',
    engine: 'gemini',
    model: 'Gemini 3.1 Pro (High)',
    bestFor: 'Long context and broad project scans',
  },
  {
    id: 'bridge-claude-haiku-4.5-spark',
    label: 'Bridge Claude Haiku 4.5 · Spark',
    engine: 'claude',
    model: 'claude-haiku-4-5',
    bestFor: 'Quick Claude responses',
  },
  {
    id: 'bridge-claude-sonnet-4.6-northstar',
    label: 'Bridge Claude Sonnet 4.6 · Northstar',
    engine: 'claude',
    model: 'claude-sonnet-4-6',
    bestFor: 'Coding, planning, careful reasoning',
  },
  {
    id: 'bridge-claude-opus-4.5-oracle',
    label: 'Bridge Claude Opus 4.5 · Oracle',
    engine: 'claude',
    model: 'claude-opus-4-5',
    bestFor: 'Hard reasoning when Claude limits allow',
  },
];

const PULSE = 'bridge-agy-gemini-3.5-flash-medium-pulse';
const FORGE = 'bridge-agy-gemini-3.5-flash-high-forge';
const ATLAS = 'bridge-agy-gemini-3.1-pro-high-atlas';
const SPARK = 'bridge-claude-haiku-4.5-spark';
const NORTHSTAR = 'bridge-claude-sonnet-4.6-northstar';
const ORACLE = 'bridge-claude-opus-4.5-oracle';

const ALIAS_MAP = {
  'bridge-fast': PULSE,
  'bridge-smart': NORTHSTAR,
  'bridge-long': ATLAS,
  'bridge-deep': ORACLE,
  'gemini-flash': PULSE,
  'gemini-pro': ATLAS,
  'claude-haiku': SPARK,
  'claude-sonnet': NORTHSTAR,
  'claude-opus': ORACLE,
  'auto-fast': PULSE,
  'auto-reasoning': NORTHSTAR,
  'auto-long-context': ATLAS,
  'gemini-cli-flash': PULSE,
  'gemini-cli-pro': ATLAS,
  'claude-subscription-default': NORTHSTAR,
  'claude-subscription-haiku': SPARK,
  'claude-subscription-sonnet': NORTHSTAR,
  'claude-subscription-opus': ORACLE,
};

const PUBLIC_ROUTES_BY_ID = Object.fromEntries(PUBLIC_ROUTES.map((r) => [r.id, r]));
const DEFAULT_ROUTE_ID = PULSE;

function resolveRoute(id) {
  if (!id || typeof id !== 'string') return null;
  if (PUBLIC_ROUTES_BY_ID[id]) return PUBLIC_ROUTES_BY_ID[id];
  const target = ALIAS_MAP[id];
  return target ? PUBLIC_ROUTES_BY_ID[target] || null : null;
}

const inflight = { claude: 0, gemini: 0 };
const recentRequests = [];
const MAX_RECENT_REQUESTS = 200;

function newRequestId() {
  return crypto.randomBytes(6).toString('hex');
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.max(1, Math.round(String(text).length / 4));
}

function appIdFrom(req) {
  const raw = req.headers['x-app-id'] || req.headers['x-client-id'] || '';
  const cleaned = String(raw).trim().slice(0, 64);
  return cleaned && /^[A-Za-z0-9_.\- ]+$/.test(cleaned) ? cleaned : 'default';
}

function classForStatus(status) {
  if (status === 200) return 'success';
  if (status === 429) return 'rejected';
  if (status >= 400 && status < 500) return 'client_error';
  if (status >= 500) return 'server_error';
  return 'error';
}

function computeTelemetry(requests) {
  let success = 0;
  let error = 0;
  let latencySum = 0;
  let latencyN = 0;
  let estPrompt = 0;
  let estCompletion = 0;
  const perEngine = {};
  const perRoute = {};
  const perApp = {};
  const latestErrors = [];

  for (const r of requests) {
    if (r.statusClass === 'success') success += 1;
    else error += 1;
    if (typeof r.durationMs === 'number') {
      latencySum += r.durationMs;
      latencyN += 1;
    }
    estPrompt += r.estPromptTokens || 0;
    estCompletion += r.estCompletionTokens || 0;

    if (r.engine) perEngine[r.engine] = (perEngine[r.engine] || 0) + 1;

    if (r.routeId) {
      const e = perRoute[r.routeId] || (perRoute[r.routeId] = {
        routeId: r.routeId, label: r.label, engine: r.engine, count: 0, success: 0, error: 0, estTokens: 0,
      });
      e.count += 1;
      if (r.statusClass === 'success') e.success += 1; else e.error += 1;
      e.estTokens += r.estTotalTokens || 0;
    }

    const appKey = r.appId || 'default';
    const a = perApp[appKey] || (perApp[appKey] = {
      appId: appKey, count: 0, success: 0, error: 0, estPromptTokens: 0, estCompletionTokens: 0, estTokens: 0, latencySum: 0, latencyN: 0,
    });
    a.count += 1;
    if (r.statusClass === 'success') a.success += 1; else a.error += 1;
    a.estPromptTokens += r.estPromptTokens || 0;
    a.estCompletionTokens += r.estCompletionTokens || 0;
    a.estTokens += r.estTotalTokens || 0;
    a.latencySum += r.durationMs || 0;
    a.latencyN += 1;

    if (r.statusClass !== 'success') latestErrors.push(r);
  }

  const perAppList = Object.values(perApp)
    .map((a) => ({
      appId: a.appId, count: a.count, success: a.success, error: a.error,
      estPromptTokens: a.estPromptTokens, estCompletionTokens: a.estCompletionTokens,
      estTokens: a.estTokens, avgLatencyMs: a.latencyN ? Math.round(a.latencySum / a.latencyN) : 0,
    }))
    .sort((x, y) => y.count - x.count);

  return {
    label: 'Local request telemetry',
    note: 'Estimated tokens via local heuristic (~4 chars/token). No billing or accurate tokenizer data.',
    recentCount: requests.length,
    successCount: success,
    errorCount: error,
    avgLatencyMs: latencyN ? Math.round(latencySum / latencyN) : 0,
    perEngine,
    perRoute: Object.values(perRoute)
      .map((e) => ({ routeId: e.routeId, label: e.label, engine: e.engine, count: e.count, success: e.success, error: e.error, estTokens: e.estTokens }))
      .sort((x, y) => y.count - x.count),
    perApp: perAppList,
    estPromptTokens: estPrompt,
    estCompletionTokens: estCompletion,
    estTotalTokens: estPrompt + estCompletion,
    latestErrors: latestErrors.slice(0, 10),
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

function createSmoothPacer(onToken, delayMs = 12) {
  const queue = [];
  let processing = false;

  const processQueue = async () => {
    if (processing) return;
    processing = true;
    while (queue.length > 0) {
      const token = queue.shift();
      onToken(token);
      if (delayMs > 0 && queue.length > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    processing = false;
  };

  return {
    push(text) {
      if (!text) return;
      const tokens = text.match(/\s+|-|[^\s|-]+/g) || [text];
      queue.push(...tokens);
      processQueue();
    },
    async drain() {
      while (processing || queue.length > 0) {
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

function formatContent(content) {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') {
        if (item.type === 'text') return item.text || '';
        if (item.type === 'image_url') return `[Image: ${item.image_url?.url || item.image_url}]`;
      }
      return JSON.stringify(item);
    }).join('\n');
  }
  return String(content);
}

function parseToolCallsFromText(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];
  const candidate = (match[1] || text).trim();
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && Array.isArray(parsed.tool_calls) && parsed.tool_calls.length > 0) {
      return parsed.tool_calls.map((tc) => ({
        id: tc.id || `call_${crypto.randomBytes(6).toString('hex')}`,
        type: tc.type || 'function',
        function: {
          name: tc.function?.name || tc.name || 'unknown_tool',
          arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || tc.arguments || {}),
        },
      }));
    }
  } catch (_) {}
  return null;
}

function messagesToPrompt(messages, opts = {}) {
  const parts = [];
  if (opts.tools && Array.isArray(opts.tools) && opts.tools.length > 0) {
    parts.push(`[SYSTEM]\nYou have access to the following tools:\n${JSON.stringify(opts.tools, null, 2)}\n\nIf you decide to call a tool, respond ONLY with a JSON object inside a \`\`\`json\`\`\` code block matching this exact schema:\n{\n  "tool_calls": [\n    {\n      "id": "call_abc123",\n      "type": "function",\n      "function": {\n        "name": "tool_name",\n        "arguments": "{\\"arg\\": \\"val\\"}"\n      }\n    }\n  ]\n}\nIf no tool call is needed, reply directly with plain text.`);
  } else if (opts.textOnlyTools) {
    parts.push('[SYSTEM]\nThe caller supplied tool/function metadata, but this bridge route is text-only. Do not emit tool calls. Answer directly from the conversation context.');
  }

  parts.push('[SYSTEM]\nWhen executing shell or terminal commands to launch web servers or long-running daemons, never execute blocking foreground commands. Always launch them in the background (e.g., using & or nohup) so execution completes promptly.');

  if (opts.responseFormat) {
    if (typeof opts.responseFormat === 'object' && opts.responseFormat.type === 'json_object') {
      parts.push('[SYSTEM]\nCRITICAL: You MUST output valid JSON only. Do not include introductory text or explanations outside JSON.');
    } else if (typeof opts.responseFormat === 'object' && opts.responseFormat.json_schema) {
      parts.push(`[SYSTEM]\nCRITICAL: You MUST output valid JSON strictly matching this schema:\n${JSON.stringify(opts.responseFormat.json_schema, null, 2)}`);
    }
  }

  for (const m of messages) {
    const roleStr = String(m.role || 'user').toUpperCase();
    let text = formatContent(m.content);
    if (m.tool_calls && Array.isArray(m.tool_calls)) {
      text += `\n[TOOL CALLS]\n${JSON.stringify(m.tool_calls, null, 2)}`;
    }
    if (m.role === 'tool') {
      text = `[TOOL RESULT for call_id=${m.tool_call_id || 'unknown'}]\n${text}`;
    }
    parts.push(`[${roleStr}]\n${text}`);
  }
  return parts.join('\n\n');
}

function callUpstream(engine, payload, opts = {}) {
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
    if (opts && typeof opts.onReq === 'function') {
      opts.onReq(req);
    }
    timer = setTimeout(() => {
      req.destroy(new Error(`Upstream "${engine}" timed out after ${Math.round(UPSTREAM_TIMEOUT_MS / 1000)}s`));
    }, UPSTREAM_TIMEOUT_MS);
    timer.unref();
    req.on('error', (err) => finish(reject, err));
    req.write(body);
    req.end();
  });
}

function callUpstreamStream(engine, payload, onChunk, opts = {}) {
  const url = new URL(ENGINES[engine].url + '/api/chat');
  const body = JSON.stringify({ ...payload, stream: true });
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'Accept': 'application/x-ndjson',
  };
  if (UPSTREAM_API_KEY) headers.Authorization = `Bearer ${UPSTREAM_API_KEY}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let buffer = '';
    let totalText = '';
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        let errData = '';
        res.on('data', (c) => (errData += c));
        res.on('end', () => finish(resolve, { status: res.statusCode, body: errData }));
        return;
      }
      res.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.event === 'delta' && parsed.text) {
              totalText += parsed.text;
              onChunk(parsed.text);
            } else if (parsed.event === 'done' && parsed.text !== undefined) {
              totalText = parsed.text;
            } else if (parsed.event === 'error') {
              finish(reject, new Error(parsed.error));
              return;
            } else if (parsed.text !== undefined) {
              totalText = parsed.text;
              onChunk(parsed.text);
            }
          } catch (_) { /* ignore parse error */ }
        }
      });
      res.on('end', () => {
        if (buffer.trim()) {
          try {
            const parsed = JSON.parse(buffer);
            if (parsed.event === 'delta' && parsed.text) {
              totalText += parsed.text;
              onChunk(parsed.text);
            } else if (parsed.event === 'done' && parsed.text !== undefined) {
              totalText = parsed.text;
            } else if (parsed.text !== undefined) {
              totalText = parsed.text;
              onChunk(parsed.text);
            }
          } catch (_) {}
        }
        finish(resolve, { status: res.statusCode, body: JSON.stringify({ text: totalText }) });
      });
    });
    if (opts && typeof opts.onReq === 'function') {
      opts.onReq(req);
    }
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
  <meta name="color-scheme" content="light">
  <title>Provider Console · AI CLI Bridge</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root {
      --canvas: #ffffff;
      --canvas-dark: #010120;
      --surface-dark-soft: #1a1a35;
      --hairline: #eceef2;
      --hairline-soft: #f5f6f9;
      --hairline-strong: #dadde4;
      --ink: #0a0a12;
      --body: #656973;
      --body-soft: #9094a0;
      --on-dark: #ffffff;
      --on-dark-soft: #c3c7dc;
      --on-dark-muted: #7b7f99;
      --mint: #c8f6f9;
      --mint-deep: #01525a;
      --good: #0f8a5f;
      --good-soft: #e2f4ea;
      --bad: #d12d2d;
      --bad-soft: #fde7e7;
      --warn: #b54708;
      --warn-soft: #fff0dc;
      --grad-1: #fc4c02;
      --grad-2: #ef2cc1;
      --grad-3: #bdbbff;
      --brand-grad: linear-gradient(90deg, var(--grad-1), var(--grad-2) 52%, var(--grad-3));
      --r-sm: 6px;
      --r: 8px;
      --r-md: 12px;
      --font-sans: 'Inter', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      background: var(--canvas);
      color: var(--ink);
      font-family: var(--font-sans);
      font-size: 14.5px;
      line-height: 1.5;
      letter-spacing: -0.011em;
      font-feature-settings: "ss01", "cv01";
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    .ribbon { height: 3px; background: var(--brand-grad); }

    .console {
      background:
        radial-gradient(900px 260px at 84% -50%, rgba(189,187,255,.12), transparent 60%),
        radial-gradient(680px 220px at 8% 140%, rgba(239,44,193,.08), transparent 55%),
        var(--canvas-dark);
      color: var(--on-dark);
      border-bottom: 1px solid var(--surface-dark-soft);
    }
    .console-inner {
      max-width: 1200px; margin: 0 auto; padding: 22px 28px;
      display: flex; align-items: center; gap: 26px; flex-wrap: wrap;
    }
    .console-brand { min-width: 0; }
    .kicker {
      font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .14em;
      font-size: 10.5px; font-weight: 500; color: var(--on-dark-muted);
    }
    .console-title {
      margin: 6px 0 0; font-size: 24px; font-weight: 600; letter-spacing: -.028em; line-height: 1;
      background: var(--brand-grad); -webkit-background-clip: text; background-clip: text; color: transparent;
    }
    .console-stats { display: flex; gap: 8px; flex: 1 1 auto; flex-wrap: wrap; }
    .stat {
      background: rgba(255,255,255,.035); border: 1px solid var(--surface-dark-soft);
      border-radius: var(--r); padding: 9px 14px; min-width: 96px;
    }
    .stat-label {
      font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .1em;
      font-size: 9.5px; font-weight: 500; color: var(--on-dark-muted);
    }
    .stat-value {
      margin-top: 5px; font-size: 16px; font-weight: 600; letter-spacing: -.02em;
      display: flex; align-items: center; gap: 7px;
    }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--on-dark-muted); flex: 0 0 auto; display: inline-block; }
    .dot.ok { background: #3ddc84; box-shadow: 0 0 0 3px rgba(61,220,132,.18); }
    .dot.down { background: var(--bad); box-shadow: 0 0 0 3px rgba(209,45,45,.18); }
    .dot.busy { background: var(--warn); box-shadow: 0 0 0 3px rgba(181,71,8,.18); }
    .btn-ghost {
      font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .08em;
      font-size: 11.5px; font-weight: 600; background: rgba(255,255,255,.06); color: var(--on-dark);
      border: 1px solid var(--surface-dark-soft); border-radius: var(--r); padding: 9px 16px; cursor: pointer; transition: .15s;
    }
    .btn-ghost:hover { background: rgba(255,255,255,.12); border-color: #3a3a5a; }

    main { max-width: 1200px; margin: 0 auto; padding: 24px 28px 48px; }
    section.card { margin-top: 18px; }
    .card {
      background: var(--canvas); border: 1px solid var(--hairline);
      border-radius: var(--r-md); padding: 20px 22px;
    }
    .card-head {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px; margin-bottom: 14px; flex-wrap: wrap;
    }
    .eyebrow {
      font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .13em;
      font-size: 10.5px; font-weight: 600; color: var(--body);
    }
    .eyebrow .num { color: var(--body-soft); margin-right: 8px; }
    .sub-eyebrow {
      font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .1em;
      font-size: 10px; font-weight: 600; color: var(--body-soft); margin: 18px 0 8px;
    }
    .muted-note { font-size: 11px; color: var(--body-soft); font-family: var(--font-mono); letter-spacing: .02em; }

    .tbl { width: 100%; border: 1px solid var(--hairline); border-radius: var(--r); overflow: hidden; }
    .tbl-row {
      display: grid; gap: 12px; align-items: center;
      padding: 11px 14px; border-top: 1px solid var(--hairline-soft);
      font-size: 13.5px; min-width: 0;
    }
    .tbl-row.head {
      border-top: 0; background: var(--hairline-soft);
      font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .1em;
      font-size: 9.5px; font-weight: 600; color: var(--body-soft);
    }
    .tbl-row:not(.head):hover { background: var(--hairline-soft); }
    .route-row { grid-template-columns: minmax(180px,1.5fr) minmax(210px,1.7fr) 78px minmax(150px,1.05fr) minmax(140px,1.1fr) 52px; }
    .recent-head, .recent-row { grid-template-columns: 80px minmax(180px,1.6fr) 80px 104px 74px 78px; }
    .tbl-row .name { font-weight: 600; letter-spacing: -.013em; overflow: hidden; text-overflow: ellipsis; }
    .tbl-row .id { font-family: var(--font-mono); font-size: 11.5px; color: var(--body); word-break: break-all; }
    .recent-row .id { margin-top: 3px; }
    .when { font-family: var(--font-mono); font-size: 11.5px; color: var(--body); }

    .pill {
      display: inline-flex; align-items: center; font-family: var(--font-mono);
      text-transform: uppercase; letter-spacing: .06em; font-size: 9.5px; font-weight: 600;
      color: var(--body); background: var(--hairline-soft); border: 1px solid var(--hairline);
      border-radius: 999px; padding: 2px 9px;
    }
    .pill.claude { color: #6b3fb6; background: #f4effc; border-color: #e7dcf7; }
    .pill.gemini { color: var(--mint-deep); background: #e0f6f9; border-color: #cdeeef; }
    .pill.na { opacity: .65; }
    .upstream { font-family: var(--font-mono); font-size: 12px; color: var(--ink); word-break: break-all; }
    .best { font-size: 12.5px; color: var(--body); }
    .copy-btn {
      font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .05em;
      font-size: 9.5px; font-weight: 600; background: var(--canvas); color: var(--body);
      border: 1px solid var(--hairline-strong); border-radius: var(--r-sm); padding: 4px 8px; cursor: pointer; transition: .15s;
    }
    .copy-btn:hover { color: var(--ink); border-color: var(--ink); }
    .copy-btn.copied { background: var(--brand-grad); color: #fff; border-color: transparent; }

    .kv { display: grid; grid-template-columns: 120px 1fr; gap: 10px; align-items: center; margin-bottom: 8px; }
    .kv-k { font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .08em; font-size: 10px; color: var(--body-soft); font-weight: 600; }
    code.inline {
      font-family: var(--font-mono); font-size: 12px; background: var(--hairline-soft);
      border: 1px solid var(--hairline); border-radius: var(--r-sm); padding: 2px 7px; word-break: break-all;
    }
    .editor {
      margin-top: 14px; border: 1px solid var(--surface-dark-soft); border-radius: var(--r);
      overflow: hidden; background: var(--canvas-dark);
    }
    .editor-bar {
      display: flex; align-items: center; gap: 10px; padding: 8px 14px;
      border-bottom: 1px solid var(--surface-dark-soft); background: rgba(255,255,255,.03);
    }
    .editor-tag {
      font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .08em;
      font-size: 10px; font-weight: 600; color: var(--on-dark);
      background: var(--brand-grad); -webkit-background-clip: text; background-clip: text; color: transparent;
    }
    .editor-method { font-family: var(--font-mono); font-size: 10.5px; color: var(--on-dark-muted); }
    pre.code {
      margin: 0; padding: 15px 16px; font-family: var(--font-mono); font-size: 12px; line-height: 1.6;
      color: var(--on-dark-soft); white-space: pre-wrap; overflow-wrap: anywhere; min-height: 60px;
    }

    .tabs { display: flex; gap: 4px; flex-wrap: wrap; }
    .tab {
      font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .06em;
      font-size: 10px; font-weight: 600; color: var(--body); background: var(--canvas);
      border: 1px solid var(--hairline); border-radius: 999px; padding: 5px 12px; cursor: pointer; transition: .15s;
    }
    .tab:hover { border-color: var(--hairline-strong); }
    .tab.active { background: var(--ink); color: #fff; border-color: var(--ink); }

    .tiles { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
    .tile { border: 1px solid var(--hairline); border-radius: var(--r); padding: 15px 16px; background: var(--canvas); }
    .tile.featured { background: var(--mint); border-color: var(--mint); }
    .tile-num { font-size: 26px; font-weight: 600; letter-spacing: -.03em; line-height: 1; }
    .tile.featured .tile-num { color: var(--mint-deep); }
    .tile-label {
      margin-top: 8px; font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .08em;
      font-size: 9.5px; font-weight: 600; color: var(--body-soft);
    }
    .tile.featured .tile-label { color: var(--mint-deep); opacity: .75; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
    .mini-tbl { border: 1px solid var(--hairline); border-radius: var(--r); overflow: hidden; }
    .mini-row {
      display: grid; grid-template-columns: minmax(0,1fr) 54px 54px 74px; gap: 8px;
      padding: 8px 12px; border-top: 1px solid var(--hairline-soft); align-items: center; font-size: 12px;
    }
    .mini-row.head {
      border-top: 0; background: var(--hairline-soft);
      font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .08em;
      font-size: 9px; font-weight: 600; color: var(--body-soft);
    }
    .mini-row > span + span { text-align: right; }
    .mini-row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: 11px; }
    .mini-row .num { font-family: var(--font-mono); font-size: 11px; color: var(--body); }
    .engines-line { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 12px; }
    .badge {
      font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .05em;
      font-size: 9.5px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
    }
    .badge.ok { background: var(--good-soft); color: var(--good); }
    .badge.err { background: var(--bad-soft); color: var(--bad); }
    .badge.rej { background: var(--warn-soft); color: var(--warn); }

    .tester { display: grid; grid-template-columns: 1fr 1fr; gap: 22px; }
    .field label {
      display: block; font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .08em;
      font-size: 10px; font-weight: 600; color: var(--body-soft); margin: 0 0 6px;
    }
    .field input, .field select, .field textarea {
      width: 100%; border: 1px solid var(--hairline-strong); border-radius: var(--r);
      padding: 9px 11px; font: inherit; font-size: 13.5px; background: var(--canvas);
      color: var(--ink); margin-bottom: 12px; transition: .15s;
    }
    .field input:focus, .field select:focus, .field textarea:focus {
      outline: none; border-color: var(--ink); box-shadow: 0 0 0 3px rgba(10,10,18,.06);
    }
    .field textarea { min-height: 84px; resize: vertical; font-family: var(--font-mono); font-size: 12px; line-height: 1.5; }
    .tester .editor { margin-top: 0; }
    .actions { display: flex; align-items: center; gap: 12px; margin-top: 2px; }
    .btn-primary {
      font-family: var(--font-mono); text-transform: uppercase; letter-spacing: .08em;
      font-size: 11.5px; font-weight: 600; border: none; border-radius: var(--r);
      padding: 10px 22px; cursor: pointer; color: #fff; background: var(--brand-grad);
      transition: .15s; box-shadow: 0 1px 2px rgba(239,44,193,.25);
    }
    .btn-primary:hover { filter: brightness(1.06); box-shadow: 0 2px 8px rgba(239,44,193,.32); }
    .btn-primary:disabled { opacity: .6; cursor: wait; filter: grayscale(.3); }

    .filters { display: flex; gap: 6px; }
    .filters select {
      font-family: var(--font-mono); font-size: 9.5px; text-transform: uppercase; letter-spacing: .06em;
      font-weight: 600; border: 1px solid var(--hairline); border-radius: 999px;
      background: var(--canvas); color: var(--body); padding: 5px 10px; cursor: pointer;
    }
    .empty { color: var(--body-soft); font-size: 12px; padding: 14px; text-align: center; font-family: var(--font-mono); }

    footer.foot {
      max-width: 1200px; margin: 0 auto; padding: 14px 28px 40px;
      font-family: var(--font-mono); font-size: 10px; text-transform: uppercase;
      letter-spacing: .12em; color: var(--body-soft);
    }

    @media (max-width: 980px) {
      .tiles { grid-template-columns: repeat(3, 1fr); }
      .two-col, .tester { grid-template-columns: 1fr; }
    }
    @media (max-width: 760px) {
      .console-inner { gap: 16px; padding: 18px; }
      .console-stats { gap: 6px; }
      .stat { flex: 1 1 calc(50% - 6px); min-width: 0; }
      .tbl-row.head { display: none; }
      .route-row, .recent-row { grid-template-columns: 1fr; gap: 5px; padding: 14px; }
      .copy-btn { justify-self: start; }
      .tiles { grid-template-columns: 1fr 1fr; }
      .kv { grid-template-columns: 1fr; }
    }
    @media (max-width: 480px) {
      main { padding: 18px 16px 40px; }
      .console-inner { padding: 16px; }
      .tiles { grid-template-columns: 1fr 1fr; }
      .mini-row { grid-template-columns: 1fr 54px 74px; }
      .mini-row .col-ok { display: none; }
    }
  </style>
</head>
<body>
  <div class="ribbon"></div>
  <header class="console">
    <div class="console-inner">
      <div class="console-brand">
        <div class="kicker">AI CLI Bridge · Provider</div>
        <h1 class="console-title">Provider Console</h1>
      </div>
      <div class="console-stats">
        <div class="stat"><div class="stat-label">Provider</div><div class="stat-value" id="provider-status"><span class="dot ok"></span><span>—</span></div></div>
        <div class="stat"><div class="stat-label">Claude</div><div class="stat-value" id="claude-status"><span class="dot"></span><span>—</span></div></div>
        <div class="stat"><div class="stat-label">Gemini</div><div class="stat-value" id="gemini-status"><span class="dot"></span><span>—</span></div></div>
        <div class="stat"><div class="stat-label">Uptime</div><div class="stat-value" id="uptime">—</div></div>
        <div class="stat"><div class="stat-label">Inflight</div><div class="stat-value" id="inflight">—</div></div>
        <div class="stat"><div class="stat-label">Calls</div><div class="stat-value" id="recent-count">—</div></div>
      </div>
      <button id="refresh" class="btn-ghost">Refresh</button>
    </div>
  </header>

  <main>
    <section class="card">
      <div class="card-head">
        <span class="eyebrow"><span class="num">01</span>Model Routes</span>
        <span class="muted-note">public ids · click copy</span>
      </div>
      <div class="tbl">
        <div class="tbl-row head route-row">
          <span>Label</span><span>Route ID</span><span>Engine</span><span>Upstream Model</span><span>Best For</span><span></span>
        </div>
        <div id="routes"></div>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <span class="eyebrow"><span class="num">02</span>App Connection</span>
        <div class="tabs" id="snippet-tabs">
          <button class="tab active" data-snippet="curl">curl</button>
          <button class="tab" data-snippet="js">JS</button>
          <button class="tab" data-snippet="python">Python</button>
          <button class="tab" data-snippet="hermes">Hermes</button>
        </div>
      </div>
      <div class="kv"><span class="kv-k">Base URL</span><code class="inline" id="base-url">—</code></div>
      <div class="kv"><span class="kv-k">Auth</span><code class="inline" id="auth-header">—</code></div>
      <div class="kv"><span class="kv-k">Default</span><code class="inline" id="default-route">—</code></div>
      <div class="editor">
        <div class="editor-bar"><span class="editor-tag" id="editor-tag">CURL</span><span class="editor-method" id="editor-method">POST /v1/chat/completions</span></div>
        <pre class="code" id="snippet"></pre>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <span class="eyebrow"><span class="num">03</span>Local Request Telemetry</span>
        <span class="muted-note">estimated tokens · not billing data · resets on restart</span>
      </div>
      <div class="tiles">
        <div class="tile featured"><div class="tile-num" id="t-total">—</div><div class="tile-label">Total Calls</div></div>
        <div class="tile"><div class="tile-num" id="t-success">—</div><div class="tile-label">Success</div></div>
        <div class="tile"><div class="tile-num" id="t-error">—</div><div class="tile-label">Errors</div></div>
        <div class="tile"><div class="tile-num" id="t-tokens">—</div><div class="tile-label">Est. Tokens</div></div>
        <div class="tile"><div class="tile-num" id="t-latency">—</div><div class="tile-label">Avg Latency</div></div>
      </div>
      <div class="engines-line" id="by-engine"></div>
      <div class="two-col">
        <div>
          <div class="sub-eyebrow">By App</div>
          <div class="mini-tbl" id="by-app"></div>
        </div>
        <div>
          <div class="sub-eyebrow">By Route</div>
          <div class="mini-tbl" id="by-route"></div>
        </div>
      </div>
      <div class="sub-eyebrow">Latest Errors</div>
      <div class="mini-tbl" id="latest-errors"></div>
    </section>

    <section class="card">
      <div class="card-head">
        <span class="eyebrow"><span class="num">04</span>Recent Calls</span>
        <div class="filters">
          <select id="filter-engine"><option value="all">All Engines</option><option value="claude">Claude</option><option value="gemini">Gemini</option><option value="-">N/A</option></select>
          <select id="filter-status"><option value="all">All Status</option><option value="success">Success</option><option value="error">Errors</option></select>
        </div>
      </div>
      <div class="tbl">
        <div class="tbl-row head recent-head">
          <span>When</span><span>Route</span><span>Engine</span><span>Status</span><span>Latency</span><span>Tokens</span>
        </div>
        <div id="recent"></div>
      </div>
    </section>

    <section class="card">
      <div class="card-head">
        <span class="eyebrow"><span class="num">05</span>Prompt Tester</span>
        <span class="muted-note">POST /v1/chat/completions</span>
      </div>
      <div class="tester">
        <div class="field">
          <label for="api-key">Provider API Key</label>
          <input id="api-key" type="password" autocomplete="off" placeholder="Bearer token">
          <label for="model">Model Route</label>
          <select id="model"></select>
          <label for="prompt">Prompt</label>
          <textarea id="prompt">Reply with exactly: bridge-ok</textarea>
          <div class="actions">
            <button id="run-test" class="btn-primary">Run</button>
            <span id="tester-status" class="muted-note">Ready</span>
          </div>
        </div>
        <div class="editor">
          <div class="editor-bar"><span class="editor-tag">RESPONSE</span><span class="editor-method" id="tester-meta">awaiting run</span></div>
          <pre class="code" id="tester-output">No response yet.</pre>
        </div>
      </div>
    </section>
  </main>

  <footer class="foot">AI CLI Bridge · Provider Console · local only</footer>

  <script>
    var state = { data: null, engineFilter: 'all', statusFilter: 'all', snippet: 'curl', snippets: {} };
    var apiKeyInput = document.getElementById('api-key');
    apiKeyInput.value = localStorage.getItem('providerApiKey') || '';

    function esc(v) {
      return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function fmtUptime(seconds) {
      if (!Number.isFinite(seconds)) return '—';
      var s = Math.floor(seconds % 60);
      var m = Math.floor((seconds / 60) % 60);
      var h = Math.floor(seconds / 3600);
      return h ? h + 'h ' + m + 'm' : m ? m + 'm ' + s + 's' : s + 's';
    }
    function fmtNum(n) { n = Number(n) || 0; return n.toLocaleString(); }
    function fmtTokens(n) {
      n = Number(n) || 0;
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
      return String(n);
    }
    function clsFor(ok, busy) { return ok ? (busy ? 'busy' : 'ok') : 'down'; }
    function badgeClass(c) { return c === 'success' ? 'ok' : (c === 'rejected' ? 'rej' : 'err'); }
    function enginePill(e) {
      var cls = e === 'claude' ? 'claude' : (e === 'gemini' ? 'gemini' : 'na');
      return '<span class="pill ' + cls + '">' + esc(e || '—') + '</span>';
    }
    function setStatus(id, dotCls, label) {
      document.getElementById(id).innerHTML = '<span class="dot ' + dotCls + '"></span><span>' + esc(label) + '</span>';
    }
    function miniHead(cols) {
      return '<div class="mini-row head">' + cols.map(function (c) { return '<span>' + c + '</span>'; }).join('') + '</div>';
    }
    function emptyRow() { return '<div class="empty">No data yet</div>'; }

    function copyText(text, btn) {
      var done = function () {
        if (btn) {
          btn.classList.add('copied');
          btn.textContent = 'Copied';
          setTimeout(function () { btn.classList.remove('copied'); btn.textContent = 'Copy'; }, 1100);
        }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, done);
      else done();
    }

    function renderBand(d) {
      setStatus('provider-status', 'ok', d.status || 'ok');
      var c = d.engines.claude, g = d.engines.gemini;
      setStatus('claude-status', clsFor(c.ok, d.inflight.claude > 0), (c.ok ? (d.inflight.claude > 0 ? 'busy' : 'online') : 'down') + ' · ' + c.durationMs + 'ms');
      setStatus('gemini-status', clsFor(g.ok, d.inflight.gemini > 0), (g.ok ? (d.inflight.gemini > 0 ? 'busy' : 'online') : 'down') + ' · ' + g.durationMs + 'ms');
      document.getElementById('uptime').textContent = fmtUptime(d.uptime);
      document.getElementById('inflight').textContent = d.inflight.claude + ' / ' + d.inflight.gemini;
      document.getElementById('recent-count').textContent = fmtNum(d.telemetry.recentCount);
    }

    function renderRoutes(routes) {
      document.getElementById('routes').innerHTML = routes.map(function (r) {
        return '<div class="tbl-row route-row">' +
          '<div class="name">' + esc(r.label) + '</div>' +
          '<div class="id">' + esc(r.id) + '</div>' +
          '<span>' + enginePill(r.engine) + '</span>' +
          '<span class="upstream">' + esc(r.upstreamModel) + '</span>' +
          '<span class="best">' + esc(r.bestFor) + '</span>' +
          '<button class="copy-btn" data-copy="' + esc(r.id) + '">Copy</button>' +
        '</div>';
      }).join('');
    }

    function buildSnippets(conn, defaultRoute, authEnabled) {
      var chat = conn.chatCompletionsUrl;
      var base = conn.baseUrl;
      var key = authEnabled ? '<key>' : 'none';
      return {
        curl: 'curl ' + chat + ' \\\n  -H "Authorization: Bearer ' + key + '" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"model":"' + defaultRoute + '","messages":[{"role":"user","content":"Hello"}]}\'',
        js: 'import OpenAI from "openai";\n\nconst client = new OpenAI({ baseURL: "' + base + '", apiKey: "' + key + '" });\nconst res = await client.chat.completions.create({\n  model: "' + defaultRoute + '",\n  messages: [{ role: "user", content: "Hello" }],\n});\nconsole.log(res.choices[0].message.content);',
        python: 'from openai import OpenAI\n\nclient = OpenAI(base_url="' + base + '", api_key="' + key + '")\nres = client.chat.completions.create(\n    model="' + defaultRoute + '",\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(res.choices[0].message.content)',
        hermes: 'hermes -z "Hello" --provider ai-cli-bridge -m ' + defaultRoute + ' -t ""'
      };
    }

    function renderConnection(d) {
      document.getElementById('base-url').textContent = d.connection.baseUrl;
      document.getElementById('auth-header').textContent = d.connection.authHeader;
      document.getElementById('default-route').textContent = d.defaultRoute;
      state.snippets = buildSnippets(d.connection, d.defaultRoute, d.authEnabled);
      renderSnippet();
    }
    function renderSnippet() {
      document.getElementById('snippet').textContent = state.snippets[state.snippet] || '';
      document.getElementById('editor-tag').textContent = state.snippet.toUpperCase();
      document.getElementById('editor-method').textContent = state.snippet === 'hermes' ? 'hermes cli' : 'POST /v1/chat/completions';
      var tabs = document.querySelectorAll('#snippet-tabs .tab');
      for (var i = 0; i < tabs.length; i++) {
        tabs[i].classList.toggle('active', tabs[i].getAttribute('data-snippet') === state.snippet);
      }
    }

    function renderTelemetry(t) {
      document.getElementById('t-total').textContent = fmtNum(t.recentCount);
      document.getElementById('t-success').textContent = fmtNum(t.successCount);
      document.getElementById('t-error').textContent = fmtNum(t.errorCount);
      document.getElementById('t-tokens').textContent = fmtTokens(t.estTotalTokens);
      document.getElementById('t-latency').textContent = t.avgLatencyMs + 'ms';

      var eng = Object.keys(t.perEngine);
      document.getElementById('by-engine').innerHTML = eng.length ? eng.map(function (k) {
        return '<span class="pill ' + k + '">' + esc(k) + ' · ' + esc(t.perEngine[k]) + '</span>';
      }).join('') : '';

      document.getElementById('by-app').innerHTML = miniHead(['App', 'Calls', 'OK', 'Tokens']) + (t.perApp.length ? t.perApp.map(function (a) {
        return '<div class="mini-row"><span class="name" title="' + esc(a.appId) + '">' + esc(a.appId) + '</span><span class="num">' + esc(a.count) + '</span><span class="num col-ok">' + esc(a.success) + '</span><span class="num">' + fmtTokens(a.estTokens) + '</span></div>';
      }).join('') : emptyRow());

      document.getElementById('by-route').innerHTML = miniHead(['Route', 'Calls', 'OK', 'Tokens']) + (t.perRoute.length ? t.perRoute.map(function (r) {
        return '<div class="mini-row"><span class="name" title="' + esc(r.label) + '">' + esc(r.label) + '</span><span class="num">' + esc(r.count) + '</span><span class="num col-ok">' + esc(r.success) + '</span><span class="num">' + fmtTokens(r.estTokens) + '</span></div>';
      }).join('') : emptyRow());

      document.getElementById('latest-errors').innerHTML = miniHead(['Route', 'Engine', 'Status', 'When']) + (t.latestErrors.length ? t.latestErrors.map(function (r) {
        return '<div class="mini-row"><span class="name" title="' + esc(r.label) + '">' + esc(r.label) + '</span><span class="num">' + esc(r.engine || '—') + '</span><span class="num"><span class="badge ' + badgeClass(r.statusClass) + '">' + esc(r.status) + '</span></span><span class="num">' + new Date(r.at).toLocaleTimeString() + '</span></div>';
      }).join('') : emptyRow());
    }

    function renderRecent(requests) {
      var list = requests.filter(function (r) {
        if (state.engineFilter !== 'all' && (r.engine || '-') !== state.engineFilter) return false;
        if (state.statusFilter === 'success' && r.statusClass !== 'success') return false;
        if (state.statusFilter === 'error' && r.statusClass === 'success') return false;
        return true;
      });
      document.getElementById('recent').innerHTML = list.length ? list.map(function (r) {
        return '<div class="tbl-row recent-row">' +
          '<span class="when">' + esc(new Date(r.at).toLocaleTimeString()) + '</span>' +
          '<div><div class="name">' + esc(r.label) + '</div><div class="id">' + esc(r.aliasUsed) + '</div></div>' +
          '<span>' + enginePill(r.engine) + '</span>' +
          '<span><span class="badge ' + badgeClass(r.statusClass) + '">' + esc(r.status) + '</span></span>' +
          '<span class="when">' + esc(r.durationMs) + 'ms</span>' +
          '<span class="when">' + fmtTokens(r.estTotalTokens) + '</span>' +
        '</div>';
      }).join('') : '<div class="empty">No matching calls</div>';
    }

    function renderTesterOptions(routes) {
      var sel = document.getElementById('model');
      var prev = sel.value || (state.data && state.data.defaultRoute);
      sel.innerHTML = routes.map(function (r) {
        return '<option value="' + esc(r.id) + '">' + esc(r.label) + ' — ' + esc(r.id) + '</option>';
      }).join('');
      var found = routes.some(function (r) { return r.id === prev; });
      sel.value = found ? prev : (state.data && state.data.defaultRoute);
    }

    async function refresh() {
      try {
        var res = await fetch('/dashboard/status');
        var d = await res.json();
        state.data = d;
        renderBand(d);
        renderRoutes(d.routes);
        renderConnection(d);
        renderTelemetry(d.telemetry);
        renderRecent(d.recentRequests);
        renderTesterOptions(d.routes);
      } catch (err) {
        setStatus('provider-status', 'down', 'refresh failed');
      }
    }

    async function runPrompt() {
      var button = document.getElementById('run-test');
      var status = document.getElementById('tester-status');
      var meta = document.getElementById('tester-meta');
      var output = document.getElementById('tester-output');
      localStorage.setItem('providerApiKey', apiKeyInput.value);
      button.disabled = true;
      status.textContent = 'Running';
      meta.textContent = 'running…';
      output.textContent = '';
      try {
        var res = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + apiKeyInput.value, 'Content-Type': 'application/json', 'X-App-Id': 'dashboard-tester' },
          body: JSON.stringify({
            model: document.getElementById('model').value,
            messages: [{ role: 'user', content: document.getElementById('prompt').value }],
          }),
        });
        var data = await res.json();
        output.textContent = data.choices && data.choices[0] ? data.choices[0].message.content : JSON.stringify(data, null, 2);
        status.textContent = res.ok ? 'Done' : 'Error ' + res.status;
        meta.textContent = res.ok ? '200 · ok' : 'error ' + res.status;
      } catch (err) {
        output.textContent = err.message;
        status.textContent = 'Network error';
        meta.textContent = 'network error';
      } finally {
        button.disabled = false;
        refresh();
      }
    }

    document.getElementById('refresh').addEventListener('click', refresh);
    document.getElementById('run-test').addEventListener('click', runPrompt);
    document.getElementById('filter-engine').addEventListener('change', function (e) { state.engineFilter = e.target.value; if (state.data) renderRecent(state.data.recentRequests); });
    document.getElementById('filter-status').addEventListener('change', function (e) { state.statusFilter = e.target.value; if (state.data) renderRecent(state.data.recentRequests); });
    document.getElementById('snippet-tabs').addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('.tab') : null;
      if (!t) return;
      state.snippet = t.getAttribute('data-snippet');
      renderSnippet();
    });
    document.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('.copy-btn') : null;
      if (btn && btn.getAttribute('data-copy')) copyText(btn.getAttribute('data-copy'), btn);
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
    defaultRoute: DEFAULT_ROUTE_ID,
    routes: PUBLIC_ROUTES.map((route) => ({
      id: route.id,
      label: route.label,
      engine: route.engine,
      upstreamModel: route.model,
      bestFor: route.bestFor,
    })),
    telemetry: computeTelemetry(recentRequests),
    recentRequests: recentRequests.map((r) => ({ ...r })),
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
  const data = PUBLIC_ROUTES.map((route) => ({
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
  const aliasUsed = body.model;
  const route = resolveRoute(aliasUsed);
  const appId = appIdFrom(req);
  let estPromptTokens = 0;
  let estCompletionTokens = 0;

  const record = (status) => {
    recentRequests.unshift({
      id: reqId,
      at: new Date().toISOString(),
      appId,
      aliasUsed: aliasUsed || '?',
      routeId: route ? route.id : null,
      label: route ? route.label : (aliasUsed || '?'),
      engine: route ? route.engine : null,
      status,
      statusClass: classForStatus(status),
      durationMs: Date.now() - started,
      estPromptTokens,
      estCompletionTokens,
      estTotalTokens: estPromptTokens + estCompletionTokens,
    });
    recentRequests.splice(MAX_RECENT_REQUESTS);
    console.log(`[req ${reqId}] ${status} model=${aliasUsed || '?'} app=${appId} ${Date.now() - started}ms`);
  };

  const unsupportedChecks = [
    ['logprobs', body.logprobs],
  ];
  for (const [name, val] of unsupportedChecks) {
    if (val !== undefined && val !== null && val !== false) {
      console.log(`[req ${reqId}] rejected unsupported parameter: ${name}`);
      record(400);
      return sendError(res, 400, `Parameter "${name}" is not supported by provider-bridge.`, 'unsupported_parameter', name);
    }
  }

  if (!route) {
    record(400);
    return sendError(res, 400, `Model "${aliasUsed}" is not a known provider route.`, 'invalid_model', 'model');
  }

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    record(400);
    return sendError(res, 400, '`messages` must be a non-empty array.', 'invalid_request_error', 'messages');
  }
  for (const m of messages) {
    if (!m || typeof m !== 'object') {
      record(400);
      return sendError(res, 400, 'Each message must be an object.', 'invalid_request_error', 'messages');
    }
    const allowedRoles = ['system', 'user', 'assistant', 'tool', 'developer', 'function'];
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
      }
    } else if (typeof m.content !== 'string' && m.content !== null && m.content !== undefined) {
      record(400);
      return sendError(res, 400, 'Message content must be a string, array, or null.', 'invalid_request_error', 'messages');
    }
  }

  if (inflight[route.engine] >= MAX_CONCURRENT_PER_ENGINE) {
    record(429);
    return sendError(
      res,
      429,
      `Engine "${route.engine}" is busy (max concurrent ${MAX_CONCURRENT_PER_ENGINE}). Please retry shortly.`,
      'engine_busy',
    );
  }

  inflight[route.engine] += 1;
  try {
    const toolsList = body.tools || body.functions;
    const prompt = messagesToPrompt(messages, {
      tools: Array.isArray(toolsList) ? toolsList : null,
      responseFormat: body.response_format,
    });
    estPromptTokens = estimateTokens(prompt);
    const payload = { task: 'chat', prompt };
    if (route.model) payload.model = route.model;

    let activeUpstreamReq = null;
    res.on('close', () => {
      if (activeUpstreamReq && !res.writableEnded) {
        try { activeUpstreamReq.destroy(); } catch (_) {}
      }
    });

    let upstream;
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
      res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`);

      const pacer = createSmoothPacer((deltaText) => {
        res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: { content: deltaText }, finish_reason: null }] })}\n\n`);
      }, 10);

      try {
        upstream = await callUpstreamStream(route.engine, payload, (deltaText) => {
          pacer.push(deltaText);
        }, { onReq: (r) => { activeUpstreamReq = r; } });
        await pacer.drain();
        activeUpstreamReq = null;
      } catch (err) {
        activeUpstreamReq = null;
        record(502);
        res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: { content: `\n[Error: ${err.message}]` }, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      if (upstream.status < 200 || upstream.status >= 300) {
        record(502);
        res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: { content: `\n[Upstream Error status ${upstream.status}]` }, finish_reason: 'stop' }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      let text = '';
      try {
        const parsed = JSON.parse(upstream.body);
        text = parsed.text !== undefined ? parsed.text : upstream.body;
      } catch (_) { text = upstream.body; }
      estCompletionTokens = estimateTokens(text);
      record(200);

      const detectedTools = parseToolCallsFromText(text);
      if (detectedTools) {
        res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: { tool_calls: detectedTools }, finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    try {
      upstream = await callUpstream(route.engine, payload, { onReq: (r) => { activeUpstreamReq = r; } });
      activeUpstreamReq = null;
    } catch (err) {
      activeUpstreamReq = null;
      record(502);
      return sendError(res, 502, `Failed to reach upstream "${route.engine}": ${err.message}`, 'upstream_error');
    }

    if (upstream.status < 200 || upstream.status >= 300) {
      let detail = upstream.body || '';
      try {
        const parsed = JSON.parse(upstream.body);
        detail = parsed.error || parsed.message || upstream.body;
      } catch (_) { /* keep raw body */ }
      record(502);
      return sendError(
        res,
        502,
        `Upstream "${route.engine}" returned status ${upstream.status}: ${String(detail).slice(0, 300)}`,
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
    estCompletionTokens = estimateTokens(text);

    const detectedTools = parseToolCallsFromText(text);
    const messageObj = detectedTools
      ? { role: 'assistant', content: null, tool_calls: detectedTools }
      : { role: 'assistant', content: text };
    const finishReason = detectedTools ? 'tool_calls' : 'stop';

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
    record(200);
    return res.status(200).json(completion);
  } finally {
    inflight[route.engine] -= 1;
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

app.listen(PORT, BIND_HOST, () => {
  console.log(`Provider bridge running on ${BIND_HOST}:${PORT}`);
  console.log(`Auth: ${API_KEY ? 'ENABLED (Bearer token required)' : 'DISABLED (open)'}`);
  console.log(`Claude bridge: ${CLAUDE_BRIDGE_URL}`);
  console.log(`Gemini bridge: ${GEMINI_BRIDGE_URL}`);
  console.log(`Max concurrent per engine: ${MAX_CONCURRENT_PER_ENGINE}`);
  console.log(`Upstream timeout: ${UPSTREAM_TIMEOUT_MS}ms`);
  console.log(`Public routes: ${PUBLIC_ROUTES.map((r) => r.id).join(', ')}`);
  if (!API_KEY && BIND_HOST !== '127.0.0.1' && BIND_HOST !== 'localhost') {
    console.warn(`WARNING: provider bound to ${BIND_HOST} with no API key set — anyone who can reach this port can spend your Claude/Gemini quota. Set PROVIDER_API_KEY or bind to 127.0.0.1.`);
  }
});
