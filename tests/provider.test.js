// Standalone verification of the provider-bridge OpenAI-style facade.
// No external test deps — uses only Node core http. Run: node tests/provider.test.js
//
// Loads the REAL provider-bridge/server.js in-process against fake HTTP
// upstreams (one standing in for the Claude bridge, one for the Gemini
// bridge). Verifies models list, auth, message conversion, routing,
// unsupported-parameter rejection, invalid model/messages, upstream-error
// mapping, and per-engine concurrency 429.

const http = require('http');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

// Reuse deps from claude-bridge (express, cors).
process.env.NODE_PATH = [
  path.join(REPO, 'claude-bridge', 'node_modules'),
  process.env.NODE_PATH || '',
].filter(Boolean).join(path.delimiter);
require('module').Module._initPaths();

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${msg}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${msg}`);
  }
}

function request(port, opts) {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const body = opts.body !== undefined ? JSON.stringify(opts.body) : null;
    if (body) headers['Content-Type'] = 'application/json';
    const req = http.request(
      { port, path: opts.path || '/', method: opts.method || 'GET', headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
      },
    );
    req.on('error', () => resolve({ status: 0, body: '', headers: {} }));
    if (body) req.write(body);
    req.end();
  });
}

// Fake upstream bridge. Records every request it sees. By default it replies
// 200 with { success: true, text }. opts.status forces an error status, and
// opts.hangMs delays the (500) reply to exercise concurrency.
function startFakeBridge(name, opts = {}) {
  const received = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(data || ''); } catch (_) {}
      received.push({ url: req.url, method: req.method, headers: req.headers, body: parsed });

      if (opts.neverReply) return;

      const reply = () => {
        if (opts.status) {
          res.writeHead(opts.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(opts.statusBody || { success: false, error: 'forced error' }));
          return;
        }
        const text = `[${name}] replied to "${parsed && parsed.prompt ? parsed.prompt.slice(0, 24) : ''}"`;
        if (parsed && parsed.stream) {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          res.write(JSON.stringify({ event: 'delta', text }) + '\n');
          res.write(JSON.stringify({ event: 'done', text }) + '\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          text,
        }));
      };

      if (opts.hangMs) setTimeout(reply, opts.hangMs);
      else reply();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, received }));
  });
}

// Re-require the provider module with a fresh env so each boot captures its
// own config (PORT, bridge URLs, API key, concurrency).
async function bootProvider(port, env) {
  const modPath = require.resolve(path.join(REPO, 'provider-bridge', 'server.js'));
  delete require.cache[modPath];
  const oldEnv = { ...process.env };
  process.env.PROVIDER_PORT = String(port);
  Object.assign(process.env, env);
  require(path.join(REPO, 'provider-bridge', 'server.js'));
  process.env = oldEnv;
  await new Promise((r) => setTimeout(r, 100));
}

function errType(r) {
  try { return JSON.parse(r.body || '{}').error.type; } catch (_) { return null; }
}
function errParam(r) {
  try { return JSON.parse(r.body || '{}').error.param; } catch (_) { return null; }
}

async function main() {
  console.log('# Provider bridge — verification');

  const claude = await startFakeBridge('claude');
  const gemini = await startFakeBridge('gemini');

  const OPEN_PORT = 19300;
  await bootProvider(OPEN_PORT, {
    PROVIDER_API_KEY: '',
    BRIDGE_API_KEY: '',
    CLAUDE_BRIDGE_URL: `http://127.0.0.1:${claude.port}`,
    GEMINI_BRIDGE_URL: `http://127.0.0.1:${gemini.port}`,
    PROVIDER_MAX_CONCURRENT_PER_ENGINE: '1',
  });

  console.log('\n## GET /v1/models — alias surface');
  let r = await request(OPEN_PORT, { path: '/v1/models' });
  assert(r.status === 200, '/v1/models returns 200 in open mode');
  const modelsBody = JSON.parse(r.body || '{}');
  assert(modelsBody.object === 'list', 'models payload object is "list"');
  assert(Array.isArray(modelsBody.data), 'models payload data is array');
  const ids = modelsBody.data.map((m) => m.id);
  for (const expected of [
    'bridge-agy-gemini-3.5-flash-medium-pulse',
    'bridge-agy-gemini-3.5-flash-high-forge',
    'bridge-agy-gemini-3.1-pro-high-atlas',
    'bridge-claude-haiku-4.5-spark',
    'bridge-claude-sonnet-4.6-northstar',
    'bridge-claude-opus-4.5-oracle',
  ]) {
    assert(ids.includes(expected), `alias exposed: ${expected}`);
  }
  for (const hidden of [
    'bridge-fast', 'bridge-smart', 'bridge-long', 'bridge-deep',
    'gemini-flash', 'gemini-pro',
    'claude-sonnet', 'claude-opus',
    'auto-fast', 'auto-reasoning', 'gemini-cli-pro', 'claude-subscription-sonnet',
  ]) {
    assert(!ids.includes(hidden), `legacy alias hidden from /v1/models: ${hidden}`);
  }
  for (const m of modelsBody.data) {
    assert(m.object === 'model' && (m.owned_by === 'claude' || m.owned_by === 'gemini'),
      `model entry well-formed: ${m.id}`);
  }

  console.log('\n## GET /health');
  r = await request(OPEN_PORT, { path: '/health' });
  assert(r.status === 200, '/health returns 200 without auth');
  const health = JSON.parse(r.body || '{}');
  assert(health.status === 'ok' && health.engine === 'provider-bridge', 'health reports provider-bridge ok');
  assert(typeof health.inflightClaude === 'number' && typeof health.inflightGemini === 'number',
    'health exposes inflight counts');

  console.log('\n## Browser dashboard');
  r = await request(OPEN_PORT, { path: '/' });
  assert(r.status === 200, 'dashboard root returns 200');
  assert((r.headers['content-type'] || '').includes('text/html'), 'dashboard root returns HTML');
  assert(r.body.includes('AI CLI Bridge'), 'dashboard HTML includes title');
  assert(r.body.includes('Prompt Tester'), 'dashboard HTML includes prompt tester');
  assert(r.body.includes('/v1/chat/completions'), 'dashboard can call provider completions');
  r = await request(OPEN_PORT, { path: '/dashboard/status' });
  assert(r.status === 200, 'dashboard status returns 200');
  const dashboard = JSON.parse(r.body || '{}');
  assert(dashboard.status === 'ok' && dashboard.engine === 'provider-bridge',
    'dashboard status reports provider-bridge ok');
  assert(dashboard.engines && dashboard.engines.claude && dashboard.engines.gemini,
    'dashboard status includes both engine health records');
  assert(dashboard.engines.claude.ok === true && dashboard.engines.gemini.ok === true,
    'dashboard status marks fake upstreams online');
  assert(Array.isArray(dashboard.routes) && dashboard.routes.some((a) => a.id === 'bridge-agy-gemini-3.5-flash-medium-pulse'),
    'dashboard status includes public routes');
  assert(dashboard.routes.some((a) => a.label.includes('Northstar') && a.bestFor.includes('planning')),
    'dashboard status includes friendly model labels and usage guidance');
  assert(dashboard.connection && dashboard.connection.baseUrl.endsWith('/v1'),
    'dashboard status includes app connection base URL');
  assert(dashboard.defaultRoute === 'bridge-agy-gemini-3.5-flash-medium-pulse',
    'dashboard status exposes default route');
  assert(dashboard.telemetry && typeof dashboard.telemetry.recentCount === 'number' && Array.isArray(dashboard.telemetry.perRoute),
    'dashboard status includes telemetry aggregates');
  assert(Array.isArray(dashboard.recentRequests), 'dashboard status includes recent request list');

  console.log('\n## POST /v1/chat/completions — Claude routing + shape');
  r = await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-claude-sonnet-4.6-northstar', messages: [{ role: 'user', content: 'hi there' }] },
  });
  assert(r.status === 200, 'bridge-claude-sonnet-4.6-northstar returns 200');
  let completion = JSON.parse(r.body || '{}');
  assert(completion.object === 'chat.completion', 'object is chat.completion');
  assert(completion.id && String(completion.id).startsWith('chatcmpl-'), 'id has chatcmpl- prefix');
  assert(completion.model === 'bridge-claude-sonnet-4.6-northstar', 'echoes requested model alias');
  assert(completion.choices && completion.choices[0].message.role === 'assistant', 'choice[0] is assistant');
  assert(typeof completion.choices[0].message.content === 'string' && completion.choices[0].message.content.length > 0,
    'choice[0].message.content is a non-empty string');
  assert(completion.choices[0].finish_reason === 'stop', 'finish_reason is stop');
  assert(completion.usage && typeof completion.usage.total_tokens === 'number' && completion.usage.total_tokens > 0,
    'usage fields report estimated tokens');
  const lastClaude = claude.received[claude.received.length - 1];
  assert(lastClaude && lastClaude.url === '/api/chat', 'upstream called at /api/chat');
  assert(typeof lastClaude.body.prompt === 'string' && lastClaude.body.prompt.includes('hi there'),
    'upstream prompt includes message content');
  assert(lastClaude.body.prompt.includes('[USER]'), 'prompt carries clear role labels');
  assert(lastClaude.body.model === 'claude-sonnet-4-6', 'northstar pins Claude Sonnet upstream');

  console.log('\n## POST /v1/chat/completions — Gemini routing + multi-turn prompt');
  r = await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: {
      model: 'bridge-agy-gemini-3.5-flash-medium-pulse',
      messages: [
        { role: 'system', content: 'You are a duck.' },
        { role: 'user', content: 'quack' },
        { role: 'assistant', content: 'quack indeed' },
        { role: 'user', content: 'fly' },
      ],
    },
  });
  assert(r.status === 200, 'bridge-agy-gemini-3.5-flash-medium-pulse returns 200');
  const lastGem = gemini.received[gemini.received.length - 1];
  assert(lastGem.body.prompt.includes('[SYSTEM]') && lastGem.body.prompt.includes('[USER]') && lastGem.body.prompt.includes('[ASSISTANT]'),
    'all three role labels present in prompt');
  assert(lastGem.body.prompt.includes('You are a duck.') && lastGem.body.prompt.includes('quack indeed'),
    'prior turns preserved in prompt');

  console.log('\n## Streaming chat completions — OpenAI SSE shape');
  r = await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-agy-gemini-3.5-flash-medium-pulse', stream: true, messages: [{ role: 'user', content: 'stream me' }] },
  });
  assert(r.status === 200, 'streaming request returns 200');
  assert((r.headers['content-type'] || '').includes('text/event-stream'), 'streaming response is event-stream');
  assert(r.body.includes('chat.completion.chunk'), 'streaming response includes completion chunks');
  assert(r.body.includes('[DONE]'), 'streaming response ends with [DONE]');
  assert(r.body.includes('[gemini]') && r.body.includes('replied'), 'streaming response includes upstream text content');

  console.log('\n## Model alias → upstream model mapping');
  await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-claude-haiku-4.5-spark', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(claude.received[claude.received.length - 1].body.model === 'claude-haiku-4-5',
    'bridge-claude-haiku-4.5-spark → claude-haiku-4-5 upstream');
  await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-claude-sonnet-4.6-northstar', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(claude.received[claude.received.length - 1].body.model === 'claude-sonnet-4-6',
    'bridge-claude-sonnet-4.6-northstar → claude-sonnet-4-6 upstream');
  await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-claude-opus-4.5-oracle', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(claude.received[claude.received.length - 1].body.model === 'claude-opus-4-5',
    'bridge-claude-opus-4.5-oracle → claude-opus-4-5 upstream');
  await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-agy-gemini-3.5-flash-high-forge', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(gemini.received[gemini.received.length - 1].body.model === 'Gemini 3.5 Flash (High)',
    'bridge-agy-gemini-3.5-flash-high-forge → Gemini 3.5 Flash (High) upstream');
  await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-agy-gemini-3.1-pro-high-atlas', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(gemini.received[gemini.received.length - 1].body.model === 'Gemini 3.1 Pro (High)',
    'bridge-agy-gemini-3.1-pro-high-atlas → Gemini 3.1 Pro (High) upstream');

  console.log('\n## Legacy aliases still route for old configs');
  await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-fast', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(gemini.received[gemini.received.length - 1].body.model === 'Gemini 3.5 Flash (Medium)',
    'legacy bridge-fast still routes to Pulse');
  await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(claude.received[claude.received.length - 1].body.model === 'claude-sonnet-4-6',
    'legacy bridge-smart still routes to Northstar');
  await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'auto-fast', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(gemini.received[gemini.received.length - 1].body.model === 'Gemini 3.5 Flash (Medium)',
    'legacy auto-fast still routes to Pulse');
  await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'claude-subscription-opus', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(claude.received[claude.received.length - 1].body.model === 'claude-opus-4-5',
    'legacy claude-subscription-opus still routes to Claude Opus');

  console.log('\n## Local telemetry + per-app token attribution');
  await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    headers: { 'X-App-Id': 'mobile-app' },
    body: { model: 'bridge-agy-gemini-3.5-flash-medium-pulse', messages: [{ role: 'user', content: 'telemetry check with a reasonably sized prompt body' }] },
  });
  r = await request(OPEN_PORT, { path: '/dashboard/status' });
  const telemStatus = JSON.parse(r.body || '{}');
  assert(telemStatus.telemetry && telemStatus.telemetry.recentCount > 0,
    'telemetry exposes a non-zero recent call count');
  assert(typeof telemStatus.telemetry.estTotalTokens === 'number' && telemStatus.telemetry.estTotalTokens > 0,
    'telemetry exposes estimated total tokens (local heuristic, no prompts stored)');
  assert(Array.isArray(telemStatus.telemetry.perApp) && telemStatus.telemetry.perApp.some((a) => a.appId === 'mobile-app' && a.count >= 1 && a.estTokens >= 0),
    'telemetry attributes calls to apps via X-App-Id');
  assert(Array.isArray(telemStatus.recentRequests) && telemStatus.recentRequests.some((rr) => rr.appId === 'mobile-app' && rr.estTotalTokens > 0 && rr.routeId === 'bridge-agy-gemini-3.5-flash-medium-pulse' && rr.statusClass === 'success'),
    'recent request entries carry appId, routeId, statusClass, and estimated tokens without prompt content');

  console.log('\n## Tool metadata & function calling support');
  r = await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: {
      model: 'bridge-fast',
      tools: [{ type: 'function', function: { name: 'read_file' } }],
      tool_choice: 'auto',
      messages: [{ role: 'user', content: 'answer' }],
    },
  });
  assert(r.status === 200, 'tool metadata accepted for tool calling');
  assert(gemini.received[gemini.received.length - 1].body.prompt.includes('read_file'),
    'upstream prompt includes tools definition');

  console.log('\n## Unsupported parameters → 400 unsupported_parameter');
  r = await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'x' }], logprobs: true },
  });
  assert(r.status === 400, 'logprobs rejected with 400');
  assert(errType(r) === 'unsupported_parameter', 'logprobs error type unsupported_parameter');
  assert(errParam(r) === 'logprobs', 'logprobs error param set');

  console.log('\n## Structured JSON output (response_format)');
  r = await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'x' }], response_format: { type: 'json_object' } },
  });
  assert(r.status === 200, 'response_format accepted for json output');

  console.log('\n## Multimodal content arrays');
  r = await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: {
      model: 'bridge-smart',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image_url', image_url: { url: 'x' } }] }],
    },
  });
  assert(r.status === 200, 'array content (multimodal) accepted');

  console.log('\n## Unknown model → 400 invalid_model');
  r = await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'gpt-9-nope', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(r.status === 400 && errType(r) === 'invalid_model', 'unknown model rejected as invalid_model');
  r = await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { messages: [{ role: 'user', content: 'x' }] },
  });
  assert(r.status === 400 && errType(r) === 'invalid_model', 'missing model rejected as invalid_model');

  console.log('\n## Bad / missing messages → 400 invalid_request_error');
  r = await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart' },
  });
  assert(r.status === 400 && errType(r) === 'invalid_request_error', 'missing messages rejected');
  r = await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', messages: [] },
  });
  assert(r.status === 400 && errType(r) === 'invalid_request_error', 'empty messages array rejected');
  r = await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', messages: 'hello' },
  });
  assert(r.status === 400 && errType(r) === 'invalid_request_error', 'non-array messages rejected');
  r = await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', messages: [{ role: 'alien', content: 'x' }] },
  });
  assert(r.status === 400 && errType(r) === 'invalid_request_error', 'bad role rejected');
  r = await request(OPEN_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: 42 }] },
  });
  assert(r.status === 400 && errType(r) === 'invalid_request_error', 'non-string content rejected');

  console.log('\n## Auth gate (PROVIDER_API_KEY)');
  const AUTH_PORT = 19310;
  await bootProvider(AUTH_PORT, {
    PROVIDER_API_KEY: 'prov-secret',
    CLAUDE_BRIDGE_URL: `http://127.0.0.1:${claude.port}`,
    GEMINI_BRIDGE_URL: `http://127.0.0.1:${gemini.port}`,
  });
  r = await request(AUTH_PORT, { path: '/v1/models' });
  assert(r.status === 401 && errType(r) === 'invalid_request_error', '/v1/models without token rejected');
  r = await request(AUTH_PORT, { path: '/v1/models', headers: { Authorization: 'Bearer wrong' } });
  assert(r.status === 401, 'wrong bearer token rejected');
  r = await request(AUTH_PORT, { path: '/v1/models', headers: { Authorization: 'Bearer prov-secret' } });
  assert(r.status === 200, 'correct bearer token accepted');
  r = await request(AUTH_PORT, { path: '/health' });
  assert(r.status === 200, '/health remains public with auth enabled');
  r = await request(AUTH_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    headers: { Authorization: 'Bearer prov-secret' },
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(r.status === 200, 'chat accepted with bearer token under auth');
  r = await request(AUTH_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(r.status === 401, 'chat without token rejected under auth');

  console.log('\n## Auth fallback to BRIDGE_API_KEY');
  const FALLBACK_PORT = 19320;
  await bootProvider(FALLBACK_PORT, {
    PROVIDER_API_KEY: '',
    BRIDGE_API_KEY: 'bridge-secret',
    CLAUDE_BRIDGE_URL: `http://127.0.0.1:${claude.port}`,
    GEMINI_BRIDGE_URL: `http://127.0.0.1:${gemini.port}`,
  });
  r = await request(FALLBACK_PORT, { path: '/v1/models' });
  assert(r.status === 401, 'fallback mode still gates without token');
  r = await request(FALLBACK_PORT, { path: '/v1/models', headers: { Authorization: 'Bearer bridge-secret' } });
  assert(r.status === 200, 'fallback mode accepts BRIDGE_API_KEY as bearer');

  console.log('\n## Upstream Authorization header forwarding');
  const UP_PORT = 19330;
  const authedClaude = await startFakeBridge('claude-upstream-auth');
  await bootProvider(UP_PORT, {
    PROVIDER_API_KEY: 'prov-secret',
    BRIDGE_API_KEY: 'upstream-key',
    CLAUDE_BRIDGE_URL: `http://127.0.0.1:${authedClaude.port}`,
    GEMINI_BRIDGE_URL: `http://127.0.0.1:${gemini.port}`,
  });
  await request(UP_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    headers: { Authorization: 'Bearer prov-secret' },
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(authedClaude.received[authedClaude.received.length - 1].headers.authorization === 'Bearer upstream-key',
    'BRIDGE_API_KEY forwarded as bearer to upstream');

  const UP2_PORT = 19340;
  const bareClaude = await startFakeBridge('claude-bare');
  await bootProvider(UP2_PORT, {
    PROVIDER_API_KEY: '',
    BRIDGE_API_KEY: '',
    CLAUDE_BRIDGE_URL: `http://127.0.0.1:${bareClaude.port}`,
    GEMINI_BRIDGE_URL: `http://127.0.0.1:${gemini.port}`,
  });
  await request(UP2_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(!bareClaude.received[bareClaude.received.length - 1].headers.authorization,
    'no Authorization header sent upstream when BRIDGE_API_KEY unset');

  console.log('\n## Upstream 5xx → 502 upstream_error');
  const FAIL_PORT = 19350;
  const failClaude = await startFakeBridge('claude-fail', { status: 500, statusBody: { success: false, error: 'boom' } });
  await bootProvider(FAIL_PORT, {
    PROVIDER_API_KEY: '',
    CLAUDE_BRIDGE_URL: `http://127.0.0.1:${failClaude.port}`,
    GEMINI_BRIDGE_URL: `http://127.0.0.1:${gemini.port}`,
  });
  r = await request(FAIL_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(r.status === 502, 'upstream 500 mapped to provider 502');
  assert(errType(r) === 'upstream_error', 'upstream error type set');
  assert((JSON.parse(r.body).error.message || '').includes('500'), 'error message includes upstream status');

  console.log('\n## Unreachable upstream → 502 upstream_error');
  const DEAD_PORT = 19360;
  await bootProvider(DEAD_PORT, {
    PROVIDER_API_KEY: '',
    // Point at a port that nothing is listening on.
    CLAUDE_BRIDGE_URL: 'http://127.0.0.1:9',
    GEMINI_BRIDGE_URL: `http://127.0.0.1:${gemini.port}`,
  });
  r = await request(DEAD_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(r.status === 502 && errType(r) === 'upstream_error', 'connection failure mapped to 502 upstream_error');

  console.log('\n## Hung upstream → bounded 502 upstream_error');
  const HANG_PORT = 19365;
  const hangClaude = await startFakeBridge('claude-hang', { neverReply: true });
  await bootProvider(HANG_PORT, {
    PROVIDER_API_KEY: '',
    CLAUDE_BRIDGE_URL: `http://127.0.0.1:${hangClaude.port}`,
    GEMINI_BRIDGE_URL: `http://127.0.0.1:${gemini.port}`,
    PROVIDER_UPSTREAM_TIMEOUT_MS: '1000',
  });
  const hangStarted = Date.now();
  r = await request(HANG_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'x' }] },
  });
  const hangElapsed = Date.now() - hangStarted;
  assert(r.status === 502 && errType(r) === 'upstream_error', 'hung upstream mapped to 502 upstream_error');
  assert(hangElapsed < 3000, `hung upstream timeout returns promptly (${hangElapsed}ms)`);

  console.log('\n## Per-engine concurrency 429');
  const CONC_PORT = 19370;
  const slowClaude = await startFakeBridge('claude-slow', { hangMs: 250, status: 200 });
  await bootProvider(CONC_PORT, {
    PROVIDER_API_KEY: '',
    CLAUDE_BRIDGE_URL: `http://127.0.0.1:${slowClaude.port}`,
    GEMINI_BRIDGE_URL: `http://127.0.0.1:${gemini.port}`,
    PROVIDER_MAX_CONCURRENT_PER_ENGINE: '1',
  });
  // Fire two concurrent Claude requests — only one slot available.
  const [r1, r2] = await Promise.all([
    request(CONC_PORT, {
      path: '/v1/chat/completions', method: 'POST',
      body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'first' }] },
    }),
    request(CONC_PORT, {
      path: '/v1/chat/completions', method: 'POST',
      body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'second' }] },
    }),
  ]);
  const ok = r1.status === 200 ? r1 : r2;
  const busy = r1.status === 200 ? r2 : r1;
  assert(ok.status === 200, 'one concurrent request succeeds (200)');
  assert(busy.status === 429, 'the other concurrent request is rejected (429)');
  assert(errType(busy) === 'engine_busy', '429 error type is engine_busy');
  assert((JSON.parse(busy.body).error.message || '').includes('claude'), '429 message names the busy engine');
  // Gemini slot is independent — still available while Claude is busy.
  const rGem = await request(CONC_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-fast', messages: [{ role: 'user', content: 'ok' }] },
  });
  assert(rGem.status === 200, 'gemini slot independent of claude load');

  console.log('\n## After Claude slot frees, requests flow again');
  r = await request(CONC_PORT, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'after' }] },
  });
  assert(r.status === 200, 'claude slot released after completion (inflight decremented)');

  console.log('\n## CORS allowlist parity with bridges');
  const CORS_PORT = 19380;
  await bootProvider(CORS_PORT, {
    PROVIDER_API_KEY: '',
    CORS_ORIGINS: 'https://allowed.example',
    CLAUDE_BRIDGE_URL: `http://127.0.0.1:${claude.port}`,
    GEMINI_BRIDGE_URL: `http://127.0.0.1:${gemini.port}`,
  });
  r = await request(CORS_PORT, { path: '/health', headers: { Origin: 'https://allowed.example' } });
  assert(r.headers['access-control-allow-origin'] === 'https://allowed.example',
    'CORS reflects allowlisted origin');
  r = await request(CORS_PORT, { path: '/health', headers: { Origin: 'https://evil.example' } });
  assert(!r.headers['access-control-allow-origin'], 'CORS withholds header for disallowed origin');

  console.log('\n## Unknown route → JSON 404 (no HTML leak)');
  r = await request(OPEN_PORT, { path: '/v1/nope' });
  assert(r.status === 404 && errType(r) === 'invalid_request_error', 'unknown v1 route returns JSON 404');

  console.log(`\n# Result: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
