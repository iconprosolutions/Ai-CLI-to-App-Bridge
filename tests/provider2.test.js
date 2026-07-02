// Verification of the CONSOLIDATED provider (packages/provider) — /v1 served
// through in-process adapters against fake CLIs. No network, no quota.
// Run: node tests/provider2.test.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const FAKE_CLI = path.join(__dirname, 'fixtures', 'fake-cli.js');
const SERVER = path.join(REPO, 'packages', 'provider', 'server.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-p2-'));

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log(`  PASS  ${msg}`); }
  else { failed += 1; console.error(`  FAIL  ${msg}`); }
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

function errType(r) {
  try { return JSON.parse(r.body || '{}').error.type; } catch (_) { return null; }
}

// Write a wrapper stub that runs the fake CLI in a sim mode with baked env.
function writeStub(name, mode, env = {}) {
  const p = path.join(TMP, name);
  const exports = Object.entries(env).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`).join('\n');
  fs.writeFileSync(p, `#!/bin/sh\n${exports}\nexec ${process.execPath} ${JSON.stringify(FAKE_CLI)} ${mode} "$@"\n`, { mode: 0o755 });
  return p;
}

// Boot a fresh copy of the consolidated provider in-process.
async function bootProvider(port, env) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(`${path.sep}packages${path.sep}provider${path.sep}`)
      || key.includes(`${path.sep}packages${path.sep}adapters${path.sep}`)) {
      delete require.cache[key];
    }
  }
  const oldEnv = { ...process.env };
  process.env.PROVIDER_PORT = String(port);
  delete process.env.PROVIDER_API_KEY;
  delete process.env.BRIDGE_API_KEY;
  Object.assign(process.env, env);
  require(SERVER);
  process.env = oldEnv;
  await new Promise((r) => setTimeout(r, 150));
}

function parseSse(body) {
  return (body || '').split('\n\n')
    .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map((l) => { try { return JSON.parse(l.slice(6)); } catch (_) { return null; } })
    .filter(Boolean);
}

async function main() {
  console.log('# Consolidated provider — verification (fake CLIs, in-process adapters)');

  // ── Routes registry unit checks ─────────────────────────────────────
  console.log('\n## routes.js — validation + reload');
  const { validateRoutes, createRouteRegistry } = require(path.join(REPO, 'packages', 'provider', 'routes.js'));
  let threw = false;
  try {
    validateRoutes({ defaultRoute: 'a', routes: [{ id: 'a', label: 'x', engine: 'claude', model: 'm', aliases: ['a2'] }, { id: 'b', label: 'x', engine: 'claude', model: 'm', aliases: ['a2'] }] });
  } catch (e) { threw = /collides|duplicate/.test(e.message); }
  assert(threw, 'duplicate alias rejected');
  const routesFile = path.join(TMP, 'routes.json');
  fs.writeFileSync(routesFile, JSON.stringify({ defaultRoute: 'r1', routes: [{ id: 'r1', label: 'R1', engine: 'claude', model: 'm1', aliases: ['fast'] }] }));
  const reg = createRouteRegistry(routesFile, { watch: false, logger: { log: () => {}, error: () => {} } });
  assert(reg.resolve('fast') && reg.resolve('fast').id === 'r1', 'alias resolves to route');
  fs.writeFileSync(routesFile, JSON.stringify({ defaultRoute: 'r1', routes: [{ id: 'r1', label: 'R1', engine: 'claude', model: 'm2', aliases: [] }] }));
  reg.reload();
  assert(reg.resolve('r1').model === 'm2' && reg.resolve('fast') === null, 'reload picks up edits and drops stale aliases');
  fs.writeFileSync(routesFile, 'not json');
  assert(reg.reload() === false && reg.resolve('r1').model === 'm2', 'invalid edit keeps last good config');

  // ── Default boot: happy paths ─────────────────────────────────────────
  const LOG = path.join(TMP, 'argv.log');
  const CLAUDE_STUB = writeStub('claude-stub.sh', 'claude-sim', { FAKE_CLI_LOG: LOG });
  const AGY_STUB = writeStub('agy-stub.sh', 'agy-sim', { FAKE_CLI_LOG: LOG });

  const P1 = 19400;
  await bootProvider(P1, { CLAUDE_PATH: CLAUDE_STUB, GEMINI_PATH: AGY_STUB, PROVIDER_MAX_CONCURRENT_PER_ENGINE: '1' });

  console.log('\n## /v1/models');
  let r = await request(P1, { path: '/v1/models' });
  const models = JSON.parse(r.body || '{}');
  assert(r.status === 200 && models.data.length === 6, `6 routes listed (got ${models.data && models.data.length})`);
  assert(!models.data.some((m) => m.id === 'bridge-smart'), 'aliases hidden from /v1/models');

  console.log('\n## Non-stream completion — claude, real usage, argv routing');
  r = await request(P1, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-claude-sonnet-4.6-northstar', messages: [{ role: 'user', content: 'hi there' }] },
  });
  let completion = JSON.parse(r.body || '{}');
  assert(r.status === 200 && completion.choices[0].message.content.includes('[claude] replied'), 'claude route answers');
  assert(completion.usage.prompt_tokens === 7 && completion.usage.completion_tokens === 9 && completion.usage.total_tokens === 16,
    `REAL usage from stream-json result (got ${completion.usage.prompt_tokens}/${completion.usage.completion_tokens})`);
  let argv = fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const lastClaude = argv[argv.length - 1];
  assert(lastClaude.includes('--model') && lastClaude.includes('claude-sonnet-4-6'), 'upstream model pinned via --model');
  assert(lastClaude.includes('--output-format') && lastClaude.includes('stream-json') && lastClaude.includes('--verbose'),
    'claude invoked in stream-json mode with --verbose');

  console.log('\n## Alias routing + gemini path');
  r = await request(P1, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'alias check' }] },
  });
  assert(r.status === 200, 'legacy alias bridge-smart still routes');
  r = await request(P1, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-fast', messages: [{ role: 'user', content: 'gem check' }] },
  });
  completion = JSON.parse(r.body || '{}');
  assert(r.status === 200 && completion.choices[0].message.content.includes('[gemini] replied'), 'gemini route answers');
  assert(!completion.choices[0].message.content.includes('\x1b'), 'ANSI stripped from gemini output');
  argv = fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const lastGem = argv[argv.length - 1];
  assert(lastGem.includes('--print') && lastGem.includes('Gemini 3.5 Flash (Medium)'), 'agy invoked with pinned display-name model');

  console.log('\n## Streaming');
  r = await request(P1, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-claude-sonnet-4.6-northstar', stream: true, messages: [{ role: 'user', content: 'stream me' }] },
  });
  assert((r.headers['content-type'] || '').includes('text/event-stream'), 'streaming is SSE');
  const chunks = parseSse(r.body);
  const streamed = chunks.map((c) => c.choices && c.choices[0].delta && c.choices[0].delta.content).filter(Boolean).join('');
  assert(streamed.includes('[claude] replied') && streamed.includes('stream me'),
    `deltas assemble the reply (got ${JSON.stringify(streamed.slice(0, 48))})`);
  assert(r.body.includes('data: [DONE]'), 'stream ends with [DONE]');
  assert(chunks.some((c) => c.choices && c.choices[0].finish_reason === 'stop'), 'finish_reason stop emitted');

  console.log('\n## Oversized prompt → 400 invalid_request_error (agy argv guard)');
  r = await request(P1, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-fast', messages: [{ role: 'user', content: 'y'.repeat(300 * 1024) }] },
  });
  assert(r.status === 400 && errType(r) === 'invalid_request_error', `oversized prompt rejected 400 (got ${r.status})`);

  // ── Tools boot (baked reply text) ─────────────────────────────────────
  const TOOLTXT = '```json\n' + JSON.stringify({ tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }) + '\n```';
  const TOOLTXT_FILE = path.join(TMP, 'tool-reply.txt');
  fs.writeFileSync(TOOLTXT_FILE, TOOLTXT);
  const CLAUDE_TOOLS = writeStub('claude-tools.sh', 'claude-sim', { FAKE_CLI_TEXT_FILE: TOOLTXT_FILE });
  const P2 = 19410;
  await bootProvider(P2, { CLAUDE_PATH: CLAUDE_TOOLS, GEMINI_PATH: AGY_STUB });

  console.log('\n## Tool-call gating (consolidated)');
  r = await request(P2, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'show example' }] },
  });
  completion = JSON.parse(r.body || '{}');
  assert(typeof completion.choices[0].message.content === 'string' && completion.choices[0].finish_reason === 'stop',
    'tool-shaped reply without tools stays content');
  r = await request(P2, {
    path: '/v1/chat/completions', method: 'POST',
    body: {
      model: 'bridge-smart',
      tools: [{ type: 'function', function: { name: 'read_file' } }],
      messages: [{ role: 'user', content: 'read a' }],
    },
  });
  completion = JSON.parse(r.body || '{}');
  assert(completion.choices[0].finish_reason === 'tool_calls' && completion.choices[0].message.tool_calls[0].function.name === 'read_file',
    'tools request parses tool_calls');

  // ── Failure taxonomy boot ─────────────────────────────────────────────
  const CLAUDE_QUOTA = writeStub('claude-quota.sh', 'claude-sim', { FAKE_CLI_STDERR: 'Claude usage limit reached. Your limit will reset at 5pm.' });
  const AGY_NOTFOUND = writeStub('agy-notfound.sh', 'agy-sim', { FAKE_CLI_STDERR: 'Requested entity was not found.' });
  const P3 = 19420;
  await bootProvider(P3, { CLAUDE_PATH: CLAUDE_QUOTA, GEMINI_PATH: AGY_NOTFOUND });

  console.log('\n## Error taxonomy at the HTTP edge');
  r = await request(P3, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(r.status === 429 && errType(r) === 'rate_limit_error', `quota maps to 429 rate_limit_error (got ${r.status}/${errType(r)})`);
  assert(Number(r.headers['retry-after']) >= 1, `429 carries Retry-After (got ${r.headers['retry-after']})`);
  r = await request(P3, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-fast', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(r.status === 400 && errType(r) === 'invalid_model', `model_not_found maps to 400 invalid_model (got ${r.status})`);

  console.log('\n## Dead binary → 502 + degraded health');
  const P4 = 19430;
  await bootProvider(P4, { CLAUDE_PATH: '/nonexistent/claude-xyz', GEMINI_PATH: AGY_STUB });
  r = await request(P4, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(r.status === 502 && errType(r) === 'upstream_error', 'missing binary maps to 502 upstream_error');
  r = await request(P4, { path: '/dashboard/status' });
  const dash = JSON.parse(r.body || '{}');
  assert(dash.engines.claude.ok === false && dash.engines.gemini.ok === true, 'health reflects dead claude, live gemini');
  assert(dash.routes.length === 6 && dash.defaultRoute === 'bridge-agy-gemini-3.5-flash-medium-pulse', 'dashboard payload keeps legacy shape');

  console.log('\n## Concurrency 429 + slot release');
  const CLAUDE_SLOW = writeStub('claude-slow.sh', 'claude-sim', { FAKE_CLI_DELAY: '400' });
  const P5 = 19440;
  await bootProvider(P5, { CLAUDE_PATH: CLAUDE_SLOW, GEMINI_PATH: AGY_STUB, PROVIDER_MAX_CONCURRENT_PER_ENGINE: '1' });
  const [r1, r2] = await Promise.all([
    request(P5, { path: '/v1/chat/completions', method: 'POST', body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'first' }] } }),
    request(P5, { path: '/v1/chat/completions', method: 'POST', body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'second' }] } }),
  ]);
  const busy = r1.status === 429 ? r1 : r2;
  const ok = r1.status === 429 ? r2 : r1;
  assert(ok.status === 200 && busy.status === 429 && errType(busy) === 'engine_busy', 'one wins the slot, the other gets 429 engine_busy');
  const rGem = await request(P5, { path: '/v1/chat/completions', method: 'POST', body: { model: 'bridge-fast', messages: [{ role: 'user', content: 'ok' }] } });
  assert(rGem.status === 200, 'gemini slot independent');
  r = await request(P5, { path: '/v1/chat/completions', method: 'POST', body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'after' }] } });
  assert(r.status === 200, 'slot released after completion');

  console.log('\n## Client abort mid-stream → 499, CLI child killed, health clean');
  await new Promise((resolve) => {
    const abortReq = http.request(
      { port: P5, path: '/v1/chat/completions', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      (res) => {
        res.once('data', () => {
          abortReq.destroy();
          setTimeout(resolve, 500);
        });
      },
    );
    abortReq.on('error', () => {});
    abortReq.end(JSON.stringify({ model: 'bridge-smart', stream: true, messages: [{ role: 'user', content: 'x' }] }));
  });
  r = await request(P5, { path: '/dashboard/status' });
  const abortDash = JSON.parse(r.body || '{}');
  const abortEntry = (abortDash.recentRequests || []).find((rr) => rr.status === 499);
  assert(abortEntry && abortEntry.statusClass === 'aborted', 'abort recorded 499/aborted');
  assert(!(abortDash.engines.claude.history || []).some((h) => h.source === 'traffic' && h.ok === false),
    'abort leaves no failed traffic sample');
  const { liveChildren } = require(path.join(REPO, 'packages', 'core'));
  assert(liveChildren() === 0, `no orphan CLI children after abort (got ${liveChildren()})`);

  console.log('\n## Phase 3 — tool-call hold-back in streaming');
  r = await request(P2, {
    path: '/v1/chat/completions', method: 'POST',
    body: {
      model: 'bridge-smart', stream: true,
      tools: [{ type: 'function', function: { name: 'read_file' } }],
      messages: [{ role: 'user', content: 'read a' }],
    },
  });
  let sse = parseSse(r.body);
  const contentDeltas = sse.map((c) => c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.content).filter(Boolean).join('');
  const tcChunk = sse.find((c) => c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.tool_calls);
  assert(!contentDeltas.includes('tool_calls') && !contentDeltas.includes('```'),
    `tool JSON never leaks as streamed content (got ${JSON.stringify(contentDeltas.slice(0, 40))})`);
  assert(tcChunk && tcChunk.choices[0].delta.tool_calls[0].index === 0 && tcChunk.choices[0].finish_reason === 'tool_calls',
    'held stream emits only indexed tool_calls');
  // With tools but a plain-text reply, content still streams (flushed).
  r = await request(P1, {
    path: '/v1/chat/completions', method: 'POST',
    body: {
      model: 'bridge-claude-sonnet-4.6-northstar', stream: true,
      tools: [{ type: 'function', function: { name: 'read_file' } }],
      messages: [{ role: 'user', content: 'plain please' }],
    },
  });
  sse = parseSse(r.body);
  const plainDeltas = sse.map((c) => c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.content).filter(Boolean).join('');
  assert(plainDeltas.includes('[claude] replied'), 'plain reply with tools present still streams as content');

  console.log('\n## Phase 3 — response_format enforcement + repair');
  const GOODJSON = path.join(TMP, 'good.json.txt');
  fs.writeFileSync(GOODJSON, 'Here you go:\n```json\n{"name":"ok","count":3}\n```\nEnjoy!');
  const STATE1 = path.join(TMP, 'state1');
  const CLAUDE_REPAIR = writeStub('claude-repair.sh', 'claude-sim', {
    FAKE_CLI_TEXT_FILE: GOODJSON, FAKE_CLI_GARBAGE_FIRST: '1', FAKE_CLI_STATE_FILE: STATE1, FAKE_CLI_LOG: LOG,
  });
  const P7 = 19460;
  await bootProvider(P7, { CLAUDE_PATH: CLAUDE_REPAIR, GEMINI_PATH: AGY_STUB });
  r = await request(P7, {
    path: '/v1/chat/completions', method: 'POST',
    body: {
      model: 'bridge-smart',
      response_format: { type: 'json_schema', json_schema: { name: 'thing', schema: { type: 'object', required: ['name', 'count'], properties: { name: { type: 'string' }, count: { type: 'integer' } } } } },
      messages: [{ role: 'user', content: 'give me the thing' }],
    },
  });
  completion = JSON.parse(r.body || '{}');
  let parsedContent = null;
  try { parsedContent = JSON.parse(completion.choices[0].message.content); } catch (_) {}
  assert(r.status === 200 && parsedContent && parsedContent.name === 'ok' && parsedContent.count === 3,
    `garbage first reply repaired via retry into schema-valid JSON (got ${r.status})`);
  // Always-garbage → 502 after exactly one retry.
  const CLAUDE_GARBAGE = writeStub('claude-garbage.sh', 'claude-sim', { FAKE_CLI_TEXT: 'no json here, ever', FAKE_CLI_LOG: LOG });
  const P8 = 19470;
  await bootProvider(P8, { CLAUDE_PATH: CLAUDE_GARBAGE, GEMINI_PATH: AGY_STUB });
  const argvBefore = fs.readFileSync(LOG, 'utf8').trim().split('\n').length;
  r = await request(P8, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: 'json please' }] },
  });
  const argvAfter = fs.readFileSync(LOG, 'utf8').trim().split('\n').length;
  assert(r.status === 502 && errType(r) === 'upstream_error', `unrepairable JSON → 502 (got ${r.status})`);
  assert(argvAfter - argvBefore === 2, `exactly one corrective retry (${argvAfter - argvBefore} invocations)`);

  console.log('\n## Phase 3 — honest params');
  r = await request(P1, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] },
  });
  assert(r.status === 400 && errType(r) === 'invalid_request_error', 'image content rejected 400 (was silent degradation)');
  r = await request(P1, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', n: 2, messages: [{ role: 'user', content: 'x' }] },
  });
  assert(r.status === 400 && errType(r) === 'unsupported_parameter', 'n=2 rejected 400 unsupported_parameter');
  r = await request(P1, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', temperature: 0.2, max_tokens: 100, messages: [{ role: 'user', content: 'x' }] },
  });
  completion = JSON.parse(r.body || '{}');
  assert(Array.isArray(completion.bridge_ignored_params) && completion.bridge_ignored_params.includes('temperature') && completion.bridge_ignored_params.includes('max_tokens'),
    'ignored sampling params reported in bridge_ignored_params');

  console.log('\n## Phase 3 — include_usage + heartbeat');
  r = await request(P1, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-claude-sonnet-4.6-northstar', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'usage me' }] },
  });
  sse = parseSse(r.body);
  const usageChunk = sse.find((c) => c.usage && Array.isArray(c.choices) && c.choices.length === 0);
  assert(usageChunk && usageChunk.usage.prompt_tokens === 7 && usageChunk.usage.completion_tokens === 9,
    'include_usage emits a real-usage chunk before [DONE]');
  const CLAUDE_SLOW2 = writeStub('claude-slow2.sh', 'claude-sim', { FAKE_CLI_DELAY: '450' });
  const P9 = 19480;
  await bootProvider(P9, { CLAUDE_PATH: CLAUDE_SLOW2, GEMINI_PATH: AGY_STUB, SSE_HEARTBEAT_MS: '100' });
  r = await request(P9, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', stream: true, messages: [{ role: 'user', content: 'slow' }] },
  });
  assert(r.body.includes(': ping'), 'SSE heartbeats keep silent streams alive');

  console.log('\n## Phase 3 — usage ledger');
  const USAGE_DIR = path.join(TMP, 'usage');
  const P10 = 19490;
  await bootProvider(P10, {
    CLAUDE_PATH: CLAUDE_STUB, GEMINI_PATH: AGY_STUB, BRIDGE_USAGE_DIR: USAGE_DIR, USAGE_FLUSH_MS: '80',
  });
  await request(P10, {
    path: '/v1/chat/completions', method: 'POST', headers: { 'X-App-Id': 'ledger-app' },
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'ledger one' }] },
  });
  await request(P10, {
    path: '/v1/chat/completions', method: 'POST', headers: { 'X-App-Id': 'ledger-app' },
    body: { model: 'bridge-fast', messages: [{ role: 'user', content: 'ledger two' }] },
  });
  await new Promise((rr) => setTimeout(rr, 250));
  const ledgerFiles = fs.readdirSync(USAGE_DIR).filter((f) => f.endsWith('.jsonl'));
  assert(ledgerFiles.length === 1, `ledger file written (${ledgerFiles.join(',')})`);
  const rows = fs.readFileSync(path.join(USAGE_DIR, ledgerFiles[0]), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert(rows.length >= 2 && rows.every((e) => e.appId === 'ledger-app' && e.ts && e.model), `ledger rows carry app + model (${rows.length} rows)`);
  assert(rows.some((e) => e.usageSource === 'real') && rows.some((e) => e.usageSource === 'estimated'),
    'ledger distinguishes real vs estimated usage');
  r = await request(P10, { path: '/dashboard/usage?range=today' });
  const usage = JSON.parse(r.body || '{}');
  assert(usage.totals && usage.totals.requests >= 2 && usage.totals.apiEquivalentUsd >= 0, 'usage aggregate totals served');
  const appRow = (usage.perApp || []).find((a) => a.appId === 'ledger-app');
  assert(appRow && appRow.requests >= 2 && appRow.usageAccuracy === 'mixed', `per-app rollup attributes usage (${appRow && appRow.usageAccuracy})`);
  assert(Array.isArray(usage.perDay) && usage.perDay.length >= 1 && usage.perDay[0].byEngine, 'per-day by-engine rollup present');

  console.log('\n## Auth gate');
  const P6 = 19450;
  await bootProvider(P6, { CLAUDE_PATH: CLAUDE_STUB, GEMINI_PATH: AGY_STUB, PROVIDER_API_KEY: 'prov-secret' });
  r = await request(P6, { path: '/v1/models' });
  assert(r.status === 401, 'keyed mode rejects missing token');
  r = await request(P6, { path: '/v1/models', headers: { Authorization: 'Bearer prov-secret' } });
  assert(r.status === 200, 'keyed mode accepts correct token');
  r = await request(P6, { path: '/health' });
  assert(r.status === 200, '/health stays public');

  console.log(`\n# Result: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
