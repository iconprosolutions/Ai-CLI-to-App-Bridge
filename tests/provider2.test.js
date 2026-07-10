// Verification of the CONSOLIDATED provider (packages/provider) — /v1 served
// through in-process adapters against fake CLIs. No network, no quota.
// Run: node tests/provider2.test.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

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
  // Never let test traffic pollute the real usage ledger or routes.json, and
  // never read/migrate the real credentials.json — each boot gets its own file
  // (absent unless the test writes one, so auth is open by default as before).
  process.env.BRIDGE_USAGE_DIR = path.join(TMP, `usage-${port}`);
  // The shipped catalogue declares cross-engine fallbacks (overflow/quota).
  // Default boots strip them so error-path tests keep their no-fallback
  // semantics; fallback behavior is tested by boots that pass their own
  // BRIDGE_ROUTES_FILE (overflow: P22, quota: P31).
  const routesCopy = path.join(TMP, `routes-${port}.json`);
  {
    const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'packages', 'provider', 'routes.json'), 'utf8'));
    for (const rt of doc.routes) { delete rt.overflowFallback; delete rt.quotaFallback; }
    fs.writeFileSync(routesCopy, JSON.stringify(doc, null, 2));
  }
  process.env.BRIDGE_ROUTES_FILE = routesCopy;
  process.env.BRIDGE_CREDENTIALS_FILE = path.join(TMP, `creds-${port}.json`);
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

  // ── Account identity readers (pure, no HTTP/CLI) ──────────────────────
  console.log('\n## identity.js — signed-in account readers');
  {
    const { claudeIdentity, geminiIdentity } = require(path.join(REPO, 'packages', 'adapters', 'identity.js'));
    const idDir = fs.mkdtempSync(path.join(os.tmpdir(), 'id-'));
    fs.writeFileSync(path.join(idDir, '.claude.json'), JSON.stringify({
      oauthAccount: { emailAddress: 'a@b.com', displayName: 'A', organizationName: 'Org', organizationType: 'claude_max' },
    }));
    const ci = claudeIdentity(idDir);
    assert(ci && ci.email === 'a@b.com' && ci.label === 'A' && ci.plan === 'claude_max', 'claudeIdentity reads oauthAccount from <dir>/.claude.json');
    assert(claudeIdentity(path.join(idDir, 'nope')) === null, 'claudeIdentity → null when no config (no crash)');
    fs.writeFileSync(path.join(idDir, 'blank.json'), '{}');
    fs.mkdirSync(path.join(idDir, '.gemini'));
    fs.writeFileSync(path.join(idDir, '.gemini', 'google_accounts.json'), JSON.stringify({ active: 'g@b.com', old: ['x@y.com'] }));
    const gi = geminiIdentity(idDir);
    assert(gi && gi.email === 'g@b.com', 'geminiIdentity reads the active Google account');
    assert(geminiIdentity(path.join(idDir, 'nope')) === null, 'geminiIdentity → null when no config (no crash)');
  }

  // ── Session continuity store (pure) ───────────────────────────────────
  console.log('\n## continuity.js — session resume store');
  {
    const { createContinuityStore } = require(path.join(REPO, 'packages', 'provider', 'continuity.js'));
    const store = createContinuityStore({ enabled: true });
    const m1 = [{ role: 'user', content: 'hello' }];
    assert(store.lookup('r', m1) === null, 'no match before anything is stored');
    store.remember('r', 'claude', 'acctA', m1, 'hi there', 'sess-1');
    const m2 = [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi there' }, { role: 'user', content: 'and now?' }];
    const hit = store.lookup('r', m2);
    assert(hit && hit.resumeId === 'sess-1' && hit.account === 'acctA' && hit.engine === 'claude', 'extending request matches the stored session');
    assert(hit.deltaMessages.length === 1 && hit.deltaMessages[0].content === 'and now?', 'delta is only the new trailing turn');
    const edited = [{ role: 'user', content: 'HELLO EDITED' }, { role: 'assistant', content: 'hi there' }, { role: 'user', content: 'and now?' }];
    assert(store.lookup('r', edited) === null, 'edited history falls back to full prompt (no match)');
    assert(store.lookup('other', m2) === null, 'route id is part of the key');
    store.remember('r', 'claude', 'acctA', m2, 'reply', null);
    const m3 = m2.concat([{ role: 'assistant', content: 'reply' }, { role: 'user', content: 'x' }]);
    assert(store.lookup('r', m3) === null, 'remember without a sessionId stores nothing');
    const off = createContinuityStore({ enabled: false });
    off.remember('r', 'claude', 'a', m1, 'hi', 'sess-x');
    assert(off.enabled === false && off.lookup('r', m2) === null, 'BRIDGE_SESSIONS=0 disables lookup + remember');
    const small = createContinuityStore({ enabled: true, max: 2 });
    for (const n of ['a', 'b', 'c']) small.remember('r', 'claude', 'x', [{ role: 'user', content: n }], 'ok', `sid-${n}`);
    assert(small.size() === 2, 'LRU caps the store at max entries');
  }

  // ── Output shaping (stop / max_tokens) — pure helpers ─────────────────
  console.log('\n## translate.js — stop sequences + max_tokens');
  {
    const { normalizeStops, applyStopAndMax, createOutputLimiter } = require(path.join(REPO, 'packages', 'provider', 'translate.js'));
    assert(JSON.stringify(normalizeStops('END')) === '["END"]', 'a string stop normalizes to a one-element array');
    assert(normalizeStops(['a', '', 'b', 'c', 'd', 'e']).length === 4, 'stops are capped at 4 and empties dropped');
    assert(normalizeStops(undefined).length === 0, 'no stop → empty');

    let s = applyStopAndMax('hello STOP world', { stop: 'STOP' });
    assert(s.text === 'hello ' && s.finishReason === 'stop' && s.truncated, 'stop truncates and removes the sequence');
    s = applyStopAndMax('keep all of this', { stop: 'NOPE' });
    assert(s.text === 'keep all of this' && !s.truncated, 'a stop that never appears leaves the text intact');
    s = applyStopAndMax('a'.repeat(400), { maxTokens: 10 }); // 10 tokens ≈ 40 chars
    assert(s.text.length === 40 && s.finishReason === 'length' && s.truncated, 'max_tokens caps length with finish_reason length');
    s = applyStopAndMax('aaa STOP ' + 'b'.repeat(400), { stop: 'STOP', maxTokens: 100 });
    assert(s.text === 'aaa ' && s.finishReason === 'stop', 'stop wins when it lands before the token cap');

    // Streaming limiter: a stop sequence split across two chunks.
    const lim = createOutputLimiter({ stop: 'END' });
    let out = lim.push('hello E');   // holds back a possible 'E…' prefix
    out += lim.push('ND of line');   // 'END' completes → cut before it
    assert(out === 'hello ' && lim.done && lim.finishReason === 'stop', 'streaming limiter catches a stop spanning a chunk boundary');
    // max_tokens across chunks stops mid-stream.
    const lim2 = createOutputLimiter({ maxTokens: 5 }); // ~20 chars
    let acc = lim2.push('x'.repeat(12));
    acc += lim2.push('y'.repeat(30));
    assert(acc.length === 20 && lim2.done && lim2.finishReason === 'length', 'streaming limiter enforces max_tokens across chunks');
    // No limits → passthrough, never done.
    const lim3 = createOutputLimiter({});
    assert(lim3.push('anything') === 'anything' && !lim3.done, 'no limits → passthrough limiter');
  }

  // ── Routes registry unit checks ─────────────────────────────────────
  console.log('\n## routes.js — validation + reload');
  const { validateRoutes, createRouteRegistry } = require(path.join(REPO, 'packages', 'provider', 'routes.js'));
  let threw = false;
  try {
    validateRoutes({ defaultRoute: 'a', routes: [{ id: 'a', label: 'x', engine: 'claude', model: 'm', aliases: ['a2'] }, { id: 'b', label: 'x', engine: 'claude', model: 'm', aliases: ['a2'] }] });
  } catch (e) { threw = /collides|duplicate/.test(e.message); }
  assert(threw, 'duplicate alias rejected');
  const pinnedRoute = { defaultRoute: 'a', routes: [{ id: 'a', label: 'x', engine: 'claude', model: 'm', account: 'work' }] };
  assert(validateRoutes(pinnedRoute).routes[0].account === 'work', 'route account pin accepted');
  threw = false;
  try { validateRoutes({ defaultRoute: 'a', routes: [{ id: 'a', label: 'x', engine: 'claude', model: 'm', account: 'bad name!' }] }); } catch (e) { threw = /account/.test(e.message); }
  assert(threw, 'bad account pin rejected');
  // overflowFallback validation
  assert(validateRoutes({ defaultRoute: 'a', routes: [{ id: 'a', label: 'x', engine: 'gemini', model: 'm', overflowFallback: 'b' }, { id: 'b', label: 'y', engine: 'claude', model: 'm' }] }).routes[0].overflowFallback === 'b',
    'overflowFallback to a different engine accepted');
  threw = false;
  try { validateRoutes({ defaultRoute: 'a', routes: [{ id: 'a', label: 'x', engine: 'gemini', model: 'm', overflowFallback: 'nope' }] }); } catch (e) { threw = /overflowFallback/.test(e.message); }
  assert(threw, 'overflowFallback to a nonexistent route rejected');
  threw = false;
  try { validateRoutes({ defaultRoute: 'a', routes: [{ id: 'a', label: 'x', engine: 'gemini', model: 'm', overflowFallback: 'b' }, { id: 'b', label: 'y', engine: 'gemini', model: 'm' }] }); } catch (e) { threw = /overflowFallback/.test(e.message); }
  assert(threw, 'overflowFallback to the same engine rejected');
  try {
    validateRoutes({ defaultRoute: 'a', routes: [{ id: 'a', label: 'x', engine: 'claude', model: 'm', quotaFallback: 'b' }, { id: 'b', label: 'y', engine: 'gemini', model: 'm' }] });
    threw = false;
  } catch (_) { threw = true; }
  assert(!threw, 'quotaFallback to a different engine accepted');
  threw = false;
  try { validateRoutes({ defaultRoute: 'a', routes: [{ id: 'a', label: 'x', engine: 'claude', model: 'm', quotaFallback: 'nope' }] }); } catch (e) { threw = /quotaFallback/.test(e.message); }
  assert(threw, 'quotaFallback to a nonexistent route rejected');
  threw = false;
  try { validateRoutes({ defaultRoute: 'a', routes: [{ id: 'a', label: 'x', engine: 'claude', model: 'm', quotaFallback: 'b' }, { id: 'b', label: 'y', engine: 'claude', model: 'm' }] }); } catch (e) { threw = /quotaFallback/.test(e.message); }
  assert(threw, 'quotaFallback to the same engine rejected');
  const routesFile = path.join(TMP, 'routes.json');
  fs.writeFileSync(routesFile, JSON.stringify({ defaultRoute: 'r1', routes: [{ id: 'r1', label: 'R1', engine: 'claude', model: 'm1', aliases: ['fast'] }] }));
  const reg = createRouteRegistry(routesFile, { watch: false, logger: { log: () => {}, error: () => {} } });
  assert(reg.resolve('fast') && reg.resolve('fast').id === 'r1', 'alias resolves to route');
  fs.writeFileSync(routesFile, JSON.stringify({ defaultRoute: 'r1', routes: [{ id: 'r1', label: 'R1', engine: 'claude', model: 'm2', aliases: [] }] }));
  reg.reload();
  assert(reg.resolve('r1').model === 'm2' && reg.resolve('fast') === null, 'reload picks up edits and drops stale aliases');
  fs.writeFileSync(routesFile, 'not json');
  assert(reg.reload() === false && reg.resolve('r1').model === 'm2', 'invalid edit keeps last good config');

  // ── Account pool unit checks ──────────────────────────────────────────
  console.log('\n## accounts.js — registry, rotation, breakers, pinning');
  const { createAccountPool, validateAccounts } = require(path.join(REPO, 'packages', 'provider', 'accounts.js'));
  const { BridgeError } = require(path.join(REPO, 'packages', 'core'));
  const acctDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acct-'));
  const acctFile = path.join(acctDir, 'accounts.json');

  {
    const pool = createAccountPool({ file: acctFile, baseDir: acctDir, engines: ['claude', 'gemini'], watch: false });
    const sel = pool.select('claude');
    assert(sel.ok && sel.account.name === 'default' && sel.account.implicit, 'implicit default account when no accounts.json');
    assert(pool.envFor('claude', sel.account) === null, 'implicit default leaves env untouched');
  }

  fs.writeFileSync(acctFile, JSON.stringify({
    claude: [{ name: 'a', dir: 'accounts/claude/a' }, { name: 'b', dir: 'accounts/claude/b' }],
    gemini: [{ name: 'g', dir: 'accounts/gemini/g' }],
  }));
  const pool = createAccountPool({
    file: acctFile, baseDir: acctDir, engines: ['claude', 'gemini'], watch: false,
    breakerOpts: { quotaThreshold: 2, quotaCooldownMs: 60000 },
    logger: { log: () => {}, error: () => {} },
  });

  const s1 = pool.select('claude'); const s2 = pool.select('claude'); const s3 = pool.select('claude');
  assert(s1.account.name === 'a' && s2.account.name === 'b' && s3.account.name === 'a', 'round-robin rotation');
  assert(pool.envFor('claude', s1.account).CLAUDE_CONFIG_DIR === path.join(acctDir, 'accounts/claude/a'), 'claude env → CLAUDE_CONFIG_DIR');
  const gsel = pool.select('gemini');
  assert(pool.envFor('gemini', gsel.account).HOME === path.join(acctDir, 'accounts/gemini/g'), 'gemini env → HOME');

  const quotaErr = new BridgeError('quota', 'limit');
  pool.feedback('claude', s1.account, quotaErr); pool.feedback('claude', s1.account, quotaErr);
  let onlyB = true;
  for (let i = 0; i < 4; i += 1) {
    const s = pool.select('claude');
    if (!s.ok || s.account.name !== 'b') onlyB = false;
  }
  assert(onlyB, 'open breaker excluded from rotation');
  pool.feedback('claude', s2.account, quotaErr); pool.feedback('claude', s2.account, quotaErr);
  const exhausted = pool.select('claude');
  assert(!exhausted.ok && exhausted.status === 429 && exhausted.retryInSec > 0, 'all accounts open → 429 + retry hint');

  pool.resetBreakers('claude');
  pool.feedback('claude', s1.account, new BridgeError('auth', 'Not logged in'));
  assert(pool.select('claude').account.name === 'b', 'needs-login account excluded');
  assert(pool.snapshot().claude.find((x) => x.name === 'a').needsLogin === true, 'snapshot reports needsLogin');

  const pinned = pool.select('claude', { pin: 'a' });
  assert(!pinned.ok && pinned.status === 503, 'pinned needs-login account fails loud, no rotation');
  assert(pool.select('claude', { pin: 'nope' }).status === 400, 'unknown pin → 400');

  pool.clearNeedsLogin('claude', 'a');
  assert(pool.select('claude', { exclude: 'a' }).account.name === 'b', 'exclude skips the named account');

  let acctThrew = false;
  try { validateAccounts({ claude: [{ name: 'x', dir: 'd' }, { name: 'x', dir: 'd2' }] }); } catch (e) { acctThrew = /duplicate/.test(e.message); }
  assert(acctThrew, 'duplicate names rejected');
  acctThrew = false;
  try { validateAccounts({ claude: [{ name: 'bad name!', dir: 'd' }] }); } catch (e) { acctThrew = /name/.test(e.message); }
  assert(acctThrew, 'bad name characters rejected');

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

  // ── §6 tool-call hardening: malformed tool JSON → one corrective retry ──
  console.log('\n## Tool-call hardening (malformed → retry)');
  const MALFORMED_FILE = path.join(TMP, 'tool-malformed.txt');
  fs.writeFileSync(MALFORMED_FILE, '```json\n{"tool_calls":[{"id":"call_1","type":"function","function":{"name":"read_file","arguments":{bad not a string}}}]}\n```');
  const TOOLGOOD_FILE = path.join(TMP, 'tool-good.txt');
  fs.writeFileSync(TOOLGOOD_FILE, '```json\n' + JSON.stringify({ tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] }) + '\n```');
  const THLOG = path.join(TMP, 'th.log');
  const CLAUDE_TH = writeStub('claude-th.sh', 'claude-sim', {
    FAKE_CLI_TEXT_FILE: TOOLGOOD_FILE, FAKE_CLI_GARBAGE_FIRST: '1', FAKE_CLI_GARBAGE_TEXT_FILE: MALFORMED_FILE, FAKE_CLI_STATE_FILE: path.join(TMP, 'state-th'), FAKE_CLI_LOG: THLOG,
  });
  const P20 = 19590;
  await bootProvider(P20, { CLAUDE_PATH: CLAUDE_TH, GEMINI_PATH: AGY_STUB });
  const thBefore = fs.existsSync(THLOG) ? fs.readFileSync(THLOG, 'utf8').trim().split('\n').filter(Boolean).length : 0;
  r = await request(P20, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', tools: [{ type: 'function', function: { name: 'read_file' } }], messages: [{ role: 'user', content: 'read a' }] },
  });
  completion = JSON.parse(r.body || '{}');
  assert(r.status === 200 && completion.choices[0].finish_reason === 'tool_calls' && completion.choices[0].message.tool_calls[0].function.name === 'read_file',
    'malformed tool JSON is corrected via one retry (non-stream)');
  const thAfter = fs.readFileSync(THLOG, 'utf8').trim().split('\n').filter(Boolean).length;
  assert(thAfter - thBefore === 2, `exactly one corrective retry for malformed tool (${thAfter - thBefore} invocations)`);
  r = await request(P20, { path: '/dashboard/status' });
  assert(JSON.parse(r.body).telemetry.toolRetries >= 1, 'toolRetries telemetry counter increments');

  // Streaming: the malformed head is held pre-first-byte, so the retry emits a
  // clean tool_calls delta and no raw JSON ever leaks as content.
  const CLAUDE_THS = writeStub('claude-ths.sh', 'claude-sim', {
    FAKE_CLI_TEXT_FILE: TOOLGOOD_FILE, FAKE_CLI_GARBAGE_FIRST: '1', FAKE_CLI_GARBAGE_TEXT_FILE: MALFORMED_FILE, FAKE_CLI_STATE_FILE: path.join(TMP, 'state-ths'),
  });
  const P21 = 19600;
  await bootProvider(P21, { CLAUDE_PATH: CLAUDE_THS, GEMINI_PATH: AGY_STUB });
  r = await request(P21, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-smart', stream: true, tools: [{ type: 'function', function: { name: 'read_file' } }], messages: [{ role: 'user', content: 'read a' }] },
  });
  {
    const evs = parseSse(r.body);
    const toolDelta = evs.find((e) => e.choices && e.choices[0].delta && e.choices[0].delta.tool_calls);
    const leaked = evs.some((e) => e.choices && e.choices[0].delta && typeof e.choices[0].delta.content === 'string' && /tool_calls|```json/.test(e.choices[0].delta.content));
    assert(toolDelta && toolDelta.choices[0].delta.tool_calls[0].function.name === 'read_file' && !leaked,
      'streaming malformed tool JSON is retried pre-first-byte; no raw JSON leaks as content');
  }

  // ── §5 oversized-prompt policy: loud 400 + opt-in reroute ──────────────
  console.log('\n## Oversized-prompt policy (overflow → 400 / reroute)');
  const OV_ROUTES = path.join(TMP, 'ov-routes.json');
  fs.writeFileSync(OV_ROUTES, JSON.stringify({
    defaultRoute: 'ov-claude',
    routes: [
      { id: 'ov-claude', label: 'C', engine: 'claude', model: 'claude-x', enabled: true, aliases: [] },
      { id: 'ov-gem', label: 'G', engine: 'gemini', model: 'Gemini X', enabled: true, aliases: [], overflowFallback: 'ov-claude' },
      { id: 'ov-gem-nofb', label: 'G2', engine: 'gemini', model: 'Gemini X', enabled: true, aliases: [] },
    ],
  }));
  const OVLOG = path.join(TMP, 'ov.log');
  const CLAUDE_OV = writeStub('claude-ov.sh', 'claude-sim', { FAKE_CLI_LOG: OVLOG });
  const AGY_OV = writeStub('agy-ov.sh', 'agy-sim', { FAKE_CLI_LOG: OVLOG });
  const P22 = 19610;
  await bootProvider(P22, { CLAUDE_PATH: CLAUDE_OV, GEMINI_PATH: AGY_OV, BRIDGE_ROUTES_FILE: OV_ROUTES, MAX_PROMPT_BYTES: '80' });
  const bigPrompt = 'x'.repeat(500);
  // gemini route with a fallback → reroutes to the claude route, marks it.
  r = await request(P22, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'ov-gem', messages: [{ role: 'user', content: bigPrompt }] },
  });
  completion = JSON.parse(r.body || '{}');
  assert(r.status === 200 && completion.bridge_rerouted && completion.bridge_rerouted.from === 'ov-gem'
    && completion.bridge_rerouted.to === 'ov-claude' && completion.bridge_rerouted.reason === 'prompt_overflow',
  'oversized prompt on a route with overflowFallback reroutes and marks bridge_rerouted');
  assert(completion.choices[0].message.content.includes('[claude]'), 'rerouted request is served by the fallback (claude) engine');
  // gemini route without a fallback → loud 400 naming the cap + remedies.
  r = await request(P22, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'ov-gem-nofb', messages: [{ role: 'user', content: bigPrompt }] },
  });
  assert(r.status === 400 && errType(r) === 'invalid_request_error', 'oversized prompt without fallback → 400 invalid_request');
  {
    const msg = JSON.parse(r.body).error.message || '';
    assert(/cap/.test(msg) && /Claude/.test(msg) && /overflowFallback/.test(msg), '400 message names the cap and the remedies');
  }
  // under-cap prompt on the same gemini route → served normally, no reroute.
  r = await request(P22, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'ov-gem', messages: [{ role: 'user', content: 'hi' }] },
  });
  completion = JSON.parse(r.body || '{}');
  assert(r.status === 200 && !completion.bridge_rerouted, 'under-cap prompt is served normally (no reroute)');

  // ── §4 session continuity (claude): resume + delta-only prompt ─────────
  console.log('\n## Session continuity (claude --resume + delta)');
  const CONTLOG = path.join(TMP, 'cont.log');
  const CLAUDE_CONT = writeStub('claude-cont.sh', 'claude-sim', { FAKE_CLI_LOG: CONTLOG });
  const P23 = 19620;
  await bootProvider(P23, { CLAUDE_PATH: CLAUDE_CONT, GEMINI_PATH: AGY_STUB });
  const contCall = (messages) => request(P23, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-claude-haiku-4.5-spark', messages },
  });
  // Turn 1 — no resume; the session is remembered.
  const t1 = await contCall([{ role: 'user', content: 'hello' }]);
  const reply1 = JSON.parse(t1.body).choices[0].message.content;
  assert(!fs.readFileSync(CONTLOG, 'utf8').split('\n').filter((l) => l.includes('-p')).some((l) => l.includes('--resume')), 'first turn does not resume');
  // Turn 2 — client echoes the reply and adds a turn → extends turn 1 → resumes.
  const before2 = fs.readFileSync(CONTLOG, 'utf8').trim().split('\n').length;
  const t2 = await contCall([{ role: 'user', content: 'hello' }, { role: 'assistant', content: reply1 }, { role: 'user', content: 'continue please' }]);
  const reply2 = JSON.parse(t2.body).choices[0].message.content;
  const new2 = fs.readFileSync(CONTLOG, 'utf8').trim().split('\n').slice(before2).filter((l) => l.includes('-p'));
  assert(new2.some((l) => l.includes('--resume') && l.includes('fake-session-1')), 'extending turn resumes with --resume <session_id>');
  assert(reply2.includes('continue') && !reply2.includes('hello'), 'resumed turn sends only the new delta, not the full history');
  // Turn 3 — a STREAMING extension resumes the same way (delta only, pre-first-byte).
  const before3 = fs.readFileSync(CONTLOG, 'utf8').trim().split('\n').length;
  const t3 = await request(P23, {
    path: '/v1/chat/completions', method: 'POST',
    body: {
      model: 'bridge-claude-haiku-4.5-spark',
      stream: true,
      messages: [
        { role: 'user', content: 'hello' }, { role: 'assistant', content: reply1 },
        { role: 'user', content: 'continue please' }, { role: 'assistant', content: reply2 },
        { role: 'user', content: 'stream more' },
      ],
    },
  });
  const new3 = fs.readFileSync(CONTLOG, 'utf8').trim().split('\n').slice(before3).filter((l) => l.includes('-p'));
  const streamed3 = parseSse(t3.body).map((e) => (e.choices && e.choices[0].delta && e.choices[0].delta.content) || '').join('');
  assert(new3.some((l) => l.includes('--resume') && l.includes('fake-session-1')), 'streaming extension also resumes with --resume');
  assert(streamed3.includes('stream more') && !streamed3.includes('hello'), 'streaming resume streams only the new delta');
  // BRIDGE_SESSIONS=0 disables continuity end-to-end.
  const CONT2LOG = path.join(TMP, 'cont2.log');
  const CLAUDE_CONT2 = writeStub('claude-cont2.sh', 'claude-sim', { FAKE_CLI_LOG: CONT2LOG });
  const P24 = 19630;
  await bootProvider(P24, { CLAUDE_PATH: CLAUDE_CONT2, GEMINI_PATH: AGY_STUB, BRIDGE_SESSIONS: '0' });
  const cc2 = (messages) => request(P24, { path: '/v1/chat/completions', method: 'POST', body: { model: 'bridge-claude-haiku-4.5-spark', messages } });
  const d1 = await cc2([{ role: 'user', content: 'hi' }]);
  const drep1 = JSON.parse(d1.body).choices[0].message.content;
  await cc2([{ role: 'user', content: 'hi' }, { role: 'assistant', content: drep1 }, { role: 'user', content: 'more' }]);
  assert(!fs.readFileSync(CONT2LOG, 'utf8').includes('--resume'), 'BRIDGE_SESSIONS=0 disables resume end-to-end');

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

  console.log('\n## Concurrency 429 + slot release (queue depth 0 = legacy instant reject)');
  const CLAUDE_SLOW = writeStub('claude-slow.sh', 'claude-sim', { FAKE_CLI_DELAY: '400' });
  const P5 = 19440;
  await bootProvider(P5, { CLAUDE_PATH: CLAUDE_SLOW, GEMINI_PATH: AGY_STUB, PROVIDER_MAX_CONCURRENT_PER_ENGINE: '1', PROVIDER_QUEUE_DEPTH: '0' });
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

  console.log('\n## tool_choice + local-tool lockdown');
  // Lockdown: bridge requests must not let Claude Code touch local files/MCP.
  argv = fs.readFileSync(LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const claudeCalls = argv.filter((a) => a.includes('-p') && a.includes('--output-format'));
  const lockArgs = claudeCalls[claudeCalls.length - 1] || [];
  assert(lockArgs.includes('--disallowedTools') && lockArgs.includes('--strict-mcp-config'),
    'claude invocations carry local-tool lockdown flags');
  // A CLI that rejects a deny-rule name as unknown (claude ≥2.1.201 dropped
  // SlashCommand): the adapter must prune the name and retry, not fail the request.
  const PRUNE_LOG = path.join(TMP, 'prune-argv.log');
  const CLAUDE_PRUNE = writeStub('claude-prune.sh', 'claude-sim', { FAKE_CLI_UNKNOWN_DENY: 'SlashCommand', FAKE_CLI_LOG: PRUNE_LOG });
  const { createClaudeAdapter } = require(path.join(REPO, 'packages', 'adapters', 'claude.js'));
  const pruneAdapter = createClaudeAdapter({ bin: CLAUDE_PRUNE });
  const pruneRes = await pruneAdapter.invoke({ prompt: 'hello prune' });
  assert(pruneRes.text.includes('replied to'), 'invoke succeeds after pruning an unknown deny-rule name');
  const pruneCalls = fs.readFileSync(PRUNE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const pruneLast = pruneCalls[pruneCalls.length - 1];
  const pruneDi = pruneLast.indexOf('--disallowedTools');
  const pruneList = pruneDi !== -1 ? String(pruneLast[pruneDi + 1]).split(',') : [];
  assert(!pruneList.includes('SlashCommand') && pruneList.includes('Bash'),
    'retry keeps the lockdown list minus the unknown tool');

  // Prompt instruction shaping (unit level).
  const { messagesToPrompt } = require(path.join(REPO, 'packages', 'provider', 'translate.js'));
  const toolsFixture = [{ type: 'function', function: { name: 'read_file' } }];
  assert(messagesToPrompt([{ role: 'user', content: 'x' }], { tools: toolsFixture, toolChoice: 'required' }).includes('MUST respond with a tool call'),
    'tool_choice=required strengthens the instruction');
  assert(messagesToPrompt([{ role: 'user', content: 'x' }], { tools: toolsFixture, toolChoice: 'required', forcedToolName: 'read_file' }).includes('MUST respond with a call to the tool "read_file"'),
    'named tool_choice demands the specific tool');
  // tool_choice=none: tools present but disabled — tool-shaped reply stays content.
  r = await request(P2, {
    path: '/v1/chat/completions', method: 'POST',
    body: {
      model: 'bridge-smart', tools: toolsFixture, tool_choice: 'none',
      messages: [{ role: 'user', content: 'x' }],
    },
  });
  completion = JSON.parse(r.body || '{}');
  assert(typeof completion.choices[0].message.content === 'string' && completion.choices[0].finish_reason === 'stop',
    'tool_choice=none disables tool parsing');
  // tool_choice=required with a prose-first model: corrective retry lands the call.
  const REQ_STATE = path.join(TMP, 'req-state');
  const REQ_LOG = path.join(TMP, 'req-argv.log');
  const CLAUDE_REQ = writeStub('claude-req.sh', 'claude-sim', {
    FAKE_CLI_TEXT_FILE: TOOLTXT_FILE, FAKE_CLI_GARBAGE_FIRST: '1', FAKE_CLI_STATE_FILE: REQ_STATE, FAKE_CLI_LOG: REQ_LOG,
  });
  const P14 = 19530;
  await bootProvider(P14, { CLAUDE_PATH: CLAUDE_REQ, GEMINI_PATH: AGY_STUB });
  r = await request(P14, {
    path: '/v1/chat/completions', method: 'POST',
    body: {
      model: 'bridge-smart', tools: toolsFixture, tool_choice: 'required',
      messages: [{ role: 'user', content: 'read a' }],
    },
  });
  completion = JSON.parse(r.body || '{}');
  assert(completion.choices && completion.choices[0].finish_reason === 'tool_calls'
    && completion.choices[0].message.tool_calls[0].function.name === 'read_file',
    'tool_choice=required repaired via retry into a tool call');
  assert(fs.readFileSync(REQ_LOG, 'utf8').trim().split('\n').length === 2, 'exactly one corrective retry for required tool_choice');

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
    body: { model: 'bridge-smart', temperature: 0.2, top_p: 0.9, max_tokens: 100, messages: [{ role: 'user', content: 'x' }] },
  });
  completion = JSON.parse(r.body || '{}');
  assert(Array.isArray(completion.bridge_ignored_params) && completion.bridge_ignored_params.includes('temperature') && completion.bridge_ignored_params.includes('top_p'),
    'genuinely-ignored sampling params reported in bridge_ignored_params');
  assert(!completion.bridge_ignored_params.includes('max_tokens'),
    'max_tokens is honored now, not reported as ignored');

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
  const acctRow = (usage.perAccount || []).find((a) => a.account === 'default');
  assert(acctRow && acctRow.requests >= 2, 'per-account rollup groups the ledger by account (implicit default)');
  const keyRow = (usage.perKey || []).find((k) => k.keyName === 'legacy');
  assert(keyRow && keyRow.requests >= 2, 'per-key rollup groups the ledger by keyName (null → legacy)');

  console.log('\n## Dashboard static control center');
  r = await request(P1, { path: '/dashboard/' });
  assert(r.status === 200 && (r.headers['content-type'] || '').includes('text/html') && r.body.includes('Control Center') && r.body.includes('app.js'),
    'dashboard index served as static HTML');
  assert(r.body.includes('data-view="accounts"') && r.body.includes('id="view-accounts"'), 'dashboard exposes the Accounts tab');
  assert(r.body.includes('data-dim="account"') && r.body.includes('data-dim="key"') && r.body.includes('id="keys-table"'), 'dashboard exposes usage account/key dimension + key management');
  r = await request(P1, { path: '/dashboard/app.js' });
  assert(r.status === 200 && (r.headers['content-type'] || '').includes('javascript'), 'dashboard app.js served');
  assert(r.body.includes('renderAccounts') && r.body.includes('acct-probe'), 'dashboard app.js wires the Accounts tab');
  assert(r.body.includes('renderKeys') && r.body.includes('key-revoke') && r.body.includes('/admin/keys'), 'dashboard app.js wires key management');
  r = await request(P1, { path: '/dashboard/styles.css' });
  assert(r.status === 200 && (r.headers['content-type'] || '').includes('css'), 'dashboard styles.css served');
  r = await request(P1, { path: '/' });
  assert(r.status === 302 || r.status === 301, 'root redirects to the dashboard');

  console.log('\n## Auth gate');
  const P6 = 19450;
  await bootProvider(P6, { CLAUDE_PATH: CLAUDE_STUB, GEMINI_PATH: AGY_STUB, PROVIDER_API_KEY: 'prov-secret' });
  r = await request(P6, { path: '/v1/models' });
  assert(r.status === 401, 'keyed mode rejects missing token');
  r = await request(P6, { path: '/v1/models', headers: { Authorization: 'Bearer prov-secret' } });
  assert(r.status === 200, 'keyed mode accepts correct token');
  r = await request(P6, { path: '/health' });
  assert(r.status === 200, '/health stays public');

  console.log('\n## Phase 4 — breaker unit behavior');
  const { createBreaker } = require(path.join(REPO, 'packages', 'provider', 'breaker.js'));
  const b = createBreaker({ engine: 'claude', quotaCooldownMs: 200 });
  b.recordFailure('quota');
  assert(b.allow().allowed === true, 'one quota failure keeps circuit closed');
  b.recordFailure('quota');
  const denied = b.allow();
  assert(denied.allowed === false && denied.retryInSec >= 1, 'second consecutive quota opens the circuit');
  await new Promise((rr) => setTimeout(rr, 250));
  const trial = b.allow();
  assert(trial.allowed === true && trial.trial === true, 'cooldown elapsed → half-open admits one trial');
  assert(b.allow().allowed === false, 'second concurrent trial denied while half-open');
  b.recordSuccess();
  assert(b.allow().allowed === true && b.status().state === 'closed', 'trial success closes the circuit');

  console.log('\n## Phase 4 — wait queue smooths bursts');
  const P11 = 19500;
  const CLAUDE_SLOW3 = writeStub('claude-slow3.sh', 'claude-sim', { FAKE_CLI_DELAY: '300' });
  await bootProvider(P11, { CLAUDE_PATH: CLAUDE_SLOW3, GEMINI_PATH: AGY_STUB, PROVIDER_MAX_CONCURRENT_PER_ENGINE: '1', PROVIDER_QUEUE_DEPTH: '4' });
  const tq = Date.now();
  const [q1, q2] = await Promise.all([
    request(P11, { path: '/v1/chat/completions', method: 'POST', body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'q1' }] } }),
    request(P11, { path: '/v1/chat/completions', method: 'POST', body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'q2' }] } }),
  ]);
  assert(q1.status === 200 && q2.status === 200, 'burst of 2 both succeed via the wait queue');
  assert(Date.now() - tq >= 550, `second request waited for the slot (${Date.now() - tq}ms total)`);

  console.log('\n## Phase 4 — breaker integration: fail fast, no CLI spawn, admin reset');
  const P12 = 19510;
  const LOG12 = path.join(TMP, 'argv12.log');
  const CLAUDE_QUOTA2 = writeStub('claude-quota2.sh', 'claude-sim', { FAKE_CLI_STDERR: 'Claude usage limit reached.', FAKE_CLI_LOG: LOG12 });
  await bootProvider(P12, { CLAUDE_PATH: CLAUDE_QUOTA2, GEMINI_PATH: AGY_STUB, PROVIDER_API_KEY: 'adm-key' });
  const call12 = () => request(P12, {
    path: '/v1/chat/completions', method: 'POST', headers: { Authorization: 'Bearer adm-key' },
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'x' }] },
  });
  await call12(); // quota 1
  await call12(); // quota 2 → circuit opens
  const spawnsBefore = fs.readFileSync(LOG12, 'utf8').trim().split('\n').length;
  r = await call12(); // fail-fast, no spawn
  const spawnsAfter = fs.readFileSync(LOG12, 'utf8').trim().split('\n').length;
  assert(r.status === 429 && errType(r) === 'rate_limit_error' && (r.body || '').includes('circuit is open'),
    'open circuit fails fast with 429 rate_limit_error');
  assert(spawnsAfter === spawnsBefore, 'fail-fast spends no CLI spawn');
  r = await request(P12, { path: '/dashboard/status' });
  assert(JSON.parse(r.body).breakers.claude.state === 'open', 'breaker state visible on dashboard status');
  r = await request(P12, { path: '/admin/breakers/claude/reset', method: 'POST', headers: { Authorization: 'Bearer adm-key' }, body: {} });
  assert(r.status === 200 && JSON.parse(r.body).breaker.state === 'closed', 'admin reset closes the breaker');
  r = await request(P12, { path: '/admin/breakers/claude/reset', method: 'POST', body: {} });
  assert(r.status === 401, 'admin requires the bearer key');

  console.log('\n## Phase 4 — engine disable/enable + admin route mutations');
  r = await request(P12, { path: '/admin/engines/claude/disable', method: 'POST', headers: { Authorization: 'Bearer adm-key' }, body: {} });
  assert(r.status === 200, 'engine disable accepted');
  r = await call12();
  assert(r.status === 400 && (r.body || '').includes('disabled by the operator'), 'disabled engine rejects requests');
  r = await request(P12, { path: '/admin/engines/claude/enable', method: 'POST', headers: { Authorization: 'Bearer adm-key' }, body: {} });
  assert(r.status === 200, 'engine enable accepted');
  r = await request(P12, {
    path: '/admin/routes', method: 'POST', headers: { Authorization: 'Bearer adm-key' },
    body: { id: 'bridge-test-titan', label: 'Test Titan', engine: 'claude', model: 'claude-opus-4-8', bestFor: 'testing', aliases: ['titan'] },
  });
  assert(r.status === 200, 'admin adds a route');
  r = await request(P12, { path: '/v1/models', headers: { Authorization: 'Bearer adm-key' } });
  assert(JSON.parse(r.body).data.some((m) => m.id === 'bridge-test-titan'), 'added route appears in /v1/models');
  r = await request(P12, {
    path: '/admin/routes', method: 'POST', headers: { Authorization: 'Bearer adm-key' },
    body: { id: 'bridge-test-titan', label: 'dup', engine: 'claude', model: 'x' },
  });
  assert(r.status === 400, 'duplicate route id rejected 400');
  r = await request(P12, { path: '/admin/routes/bridge-test-titan', method: 'DELETE', headers: { Authorization: 'Bearer adm-key' } });
  assert(r.status === 200, 'admin deletes a route');
  r = await request(P12, { path: '/v1/models', headers: { Authorization: 'Bearer adm-key' } });
  assert(!JSON.parse(r.body).data.some((m) => m.id === 'bridge-test-titan'), 'deleted route gone from /v1/models');

  console.log('\n## Phase 4 — capture buffer (opt-in, memory only)');
  r = await request(P12, { path: '/admin/capture', headers: { Authorization: 'Bearer adm-key' } });
  assert(JSON.parse(r.body).enabled === false && JSON.parse(r.body).count === 0, 'capture off by default, empty');
  await request(P12, { path: '/admin/capture', method: 'POST', headers: { Authorization: 'Bearer adm-key' }, body: { enabled: true } });
  await call12();
  r = await request(P12, { path: '/admin/capture', headers: { Authorization: 'Bearer adm-key' } });
  const capList = JSON.parse(r.body);
  assert(capList.enabled === true && capList.count >= 1 && capList.requests[0].routeId === 'bridge-claude-sonnet-4.6-northstar',
    'capture records requests while enabled');
  r = await request(P12, { path: `/admin/capture/${capList.requests[0].id}`, headers: { Authorization: 'Bearer adm-key' } });
  const capEntry = JSON.parse(r.body);
  assert(typeof capEntry.sentPrompt === 'string' && capEntry.sentPrompt.includes('[USER]'), 'capture detail includes the sent prompt');
  assert(capEntry.error && capEntry.error.kind === 'quota', 'capture detail includes the classified error');
  await request(P12, { path: '/admin/capture', method: 'POST', headers: { Authorization: 'Bearer adm-key' }, body: { enabled: false } });
  r = await request(P12, { path: '/admin/capture', headers: { Authorization: 'Bearer adm-key' } });
  assert(JSON.parse(r.body).count === 0, 'disabling capture clears the buffer');

  console.log('\n## Phase 4 — kill a live request via admin');
  const P13 = 19520;
  const CLAUDE_SLOW4 = writeStub('claude-slow4.sh', 'claude-sim', { FAKE_CLI_DELAY: '3000' });
  await bootProvider(P13, { CLAUDE_PATH: CLAUDE_SLOW4, GEMINI_PATH: AGY_STUB, PROVIDER_API_KEY: 'adm-key' });
  const killVictim = request(P13, {
    path: '/v1/chat/completions', method: 'POST', headers: { Authorization: 'Bearer adm-key' },
    body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'kill me' }] },
  });
  await new Promise((rr) => setTimeout(rr, 400));
  r = await request(P13, { path: '/dashboard/status' });
  const act = JSON.parse(r.body).activeRequests;
  assert(Array.isArray(act) && act.length === 1 && act[0].engine === 'claude', 'active request visible on dashboard status');
  r = await request(P13, { path: `/admin/requests/${act[0].id}/kill`, method: 'POST', headers: { Authorization: 'Bearer adm-key' }, body: {} });
  assert(r.status === 200 && JSON.parse(r.body).killed === true, 'admin kill accepted');
  const victimRes = await killVictim;
  assert(victimRes.status === 500 && errType(victimRes) === 'request_cancelled', `killed request gets request_cancelled (got ${victimRes.status})`);
  await new Promise((rr) => setTimeout(rr, 300));
  assert(liveChildren() === 0, 'killed request leaves no orphan CLI child');

  console.log('\n## Phase 4 — SSE event bus');
  const eventsSeen = [];
  await new Promise((resolve) => {
    const evReq = http.request({ port: P13, path: '/dashboard/events', method: 'GET' }, (res2) => {
      let buf = '';
      res2.on('data', (c) => {
        buf += c.toString();
        for (const block of buf.split('\n\n')) {
          const m = block.match(/^event: (\S+)/m);
          if (m && !eventsSeen.includes(m[1])) eventsSeen.push(m[1]);
        }
        if (eventsSeen.includes('request.end')) {
          evReq.destroy();
          resolve();
        }
      });
      request(P13, {
        path: '/v1/chat/completions', method: 'POST', headers: { Authorization: 'Bearer adm-key' },
        body: { model: 'bridge-fast', messages: [{ role: 'user', content: 'event me' }] },
      });
      setTimeout(() => { evReq.destroy(); resolve(); }, 5000);
    });
    evReq.on('error', () => resolve());
    evReq.end();
  });
  assert(eventsSeen.includes('request.start') && eventsSeen.includes('request.end'),
    `event bus emits request lifecycle (saw: ${eventsSeen.join(',')})`);

  // ── Multi-account: rotation + env redirection + status ────────────────
  console.log('\n## accounts — rotation, env redirect, failover, needs-login, pinning');
  const P15 = 19540;
  const ENVLOG15 = path.join(TMP, 'env15.log');
  const ACCTS15 = path.join(TMP, 'accounts15.json');
  fs.writeFileSync(ACCTS15, JSON.stringify({
    claude: [{ name: 'w1', dir: 'acct/claude/w1' }, { name: 'w2', dir: 'acct/claude/w2' }],
    gemini: [{ name: 'g1', dir: 'acct/gemini/g1' }],
  }));
  const CLAUDE_ACCT = writeStub('claude-acct.sh', 'claude-sim', { FAKE_CLI_ENV_LOG: ENVLOG15 });
  const AGY_ACCT = writeStub('agy-acct.sh', 'agy-sim', { FAKE_CLI_ENV_LOG: ENVLOG15 });
  await bootProvider(P15, { CLAUDE_PATH: CLAUDE_ACCT, GEMINI_PATH: AGY_ACCT, BRIDGE_ACCOUNTS_FILE: ACCTS15, PROVIDER_API_KEY: 'adm15' });
  const call15 = (model) => request(P15, {
    path: '/v1/chat/completions', method: 'POST', headers: { Authorization: 'Bearer adm15' },
    body: { model, messages: [{ role: 'user', content: 'hi' }] },
  });
  await call15('bridge-claude-haiku-4.5-spark');
  await call15('bridge-claude-haiku-4.5-spark');
  await call15('bridge-agy-gemini-3.5-flash-medium-pulse');
  const envLines15 = fs.readFileSync(ENVLOG15, 'utf8').trim().split('\n').map(JSON.parse);
  const claudeDirs = new Set(envLines15.filter((l) => l.argv.includes('-p')).map((l) => l.CLAUDE_CONFIG_DIR).filter(Boolean));
  assert(claudeDirs.size === 2 && [...claudeDirs].every((d) => /acct\/claude\/w[12]$/.test(d)),
    `rotation spans both claude account config dirs (got ${[...claudeDirs].join(', ')})`);
  const agyHomes = envLines15.filter((l) => l.argv.includes('--print')).map((l) => l.HOME);
  assert(agyHomes.length === 1 && /acct\/gemini\/g1$/.test(agyHomes[0]), 'agy spawn HOME redirected to account dir');
  r = await request(P15, { path: '/dashboard/status' });
  {
    const st = JSON.parse(r.body);
    assert(Array.isArray(st.accounts.claude) && st.accounts.claude.length === 2
      && st.accounts.gemini.length === 1 && st.accounts.claude[0].needsLogin === false,
    'status exposes the account pool');
  }

  // Signed-in identity surfaces per account from its config dir. Write a
  // .claude.json into w1's dir (the pool created it under the runtime baseDir).
  fs.writeFileSync(path.join(TMP, 'acct', 'claude', 'w1', '.claude.json'), JSON.stringify({
    oauthAccount: { emailAddress: 'w1@team.com', displayName: 'W One', organizationType: 'claude_max' },
  }));
  r = await request(P15, { path: '/dashboard/status' });
  {
    const st = JSON.parse(r.body);
    const w1 = st.accounts.claude.find((a) => a.name === 'w1');
    const w2 = st.accounts.claude.find((a) => a.name === 'w2');
    assert(w1.identity && w1.identity.email === 'w1@team.com' && w1.identity.plan === 'claude_max', 'status shows the signed-in account per credential dir');
    assert(w2.identity === null, 'an account with no login reports identity null (surfaces as "not signed in")');
  }

  // Admin enable/disable of a pooled account (in-memory, removes from rotation).
  r = await request(P15, { path: '/admin/accounts/claude/nope/disable', method: 'POST', headers: { Authorization: 'Bearer adm15' } });
  assert(r.status === 404, 'disabling an unknown account → 404');
  const adBefore = fs.readFileSync(ENVLOG15, 'utf8').trim().split('\n').length;
  r = await request(P15, { path: '/admin/accounts/claude/w2/disable', method: 'POST', headers: { Authorization: 'Bearer adm15' } });
  assert(r.status === 200 && JSON.parse(r.body).enabled === false, 'admin disables account w2');
  await call15('bridge-claude-haiku-4.5-spark');
  await call15('bridge-claude-haiku-4.5-spark');
  const adAfter = fs.readFileSync(ENVLOG15, 'utf8').trim().split('\n').slice(adBefore).map(JSON.parse).filter((l) => l.argv.includes('-p'));
  assert(adAfter.length === 2 && adAfter.every((l) => /w1$/.test(l.CLAUDE_CONFIG_DIR)), 'disabled account is skipped — both calls route to w1');
  r = await request(P15, { path: '/dashboard/status' });
  assert(JSON.parse(r.body).accounts.claude.find((a) => a.name === 'w2').enabled === false, 'status reflects the disabled account');
  r = await request(P15, { path: '/admin/accounts/claude/w2/enable', method: 'POST', headers: { Authorization: 'Bearer adm15' } });
  assert(r.status === 200 && JSON.parse(r.body).enabled === true, 'admin re-enables account w2');

  // ── Multi-account: quota failover then exhaustion ─────────────────────
  const P16 = 19550;
  const ENVLOG16 = path.join(TMP, 'env16.log');
  const ACCTS16 = path.join(TMP, 'accounts16.json');
  fs.writeFileSync(ACCTS16, JSON.stringify({
    claude: [{ name: 'q1', dir: 'acct/claude/q1' }, { name: 'q2', dir: 'acct/claude/q2' }],
  }));
  const CLAUDE_QACCT = writeStub('claude-qacct.sh', 'claude-sim', {
    FAKE_CLI_ENV_LOG: ENVLOG16, FAKE_CLI_STDERR: 'Claude usage limit reached.',
  });
  await bootProvider(P16, { CLAUDE_PATH: CLAUDE_QACCT, GEMINI_PATH: AGY_ACCT, BRIDGE_ACCOUNTS_FILE: ACCTS16 });
  const call16 = () => request(P16, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-claude-haiku-4.5-spark', messages: [{ role: 'user', content: 'x' }] },
  });
  r = await call16(); // q1 quota → failover to q2 → quota → 429
  {
    const lines = fs.readFileSync(ENVLOG16, 'utf8').trim().split('\n').map(JSON.parse).filter((l) => l.argv.includes('-p'));
    const dirs = new Set(lines.map((l) => l.CLAUDE_CONFIG_DIR));
    assert(r.status === 429 && lines.length === 2 && dirs.size === 2,
      `single request fails over across both accounts before 429 (spawns=${lines.length}, dirs=${dirs.size})`);
  }
  await call16(); // second failure each → both breakers open
  const spawnsBefore16 = fs.readFileSync(ENVLOG16, 'utf8').trim().split('\n').length;
  r = await call16(); // fail-fast: no spawns
  const spawnsAfter16 = fs.readFileSync(ENVLOG16, 'utf8').trim().split('\n').length;
  assert(r.status === 429 && r.headers['retry-after'] && spawnsAfter16 === spawnsBefore16,
    'exhausted pool fails fast with Retry-After and no spawn');

  // ── Multi-account: auth → needs-login; pinned account fails loud ──────
  const P17 = 19560;
  const ENVLOG17 = path.join(TMP, 'env17.log');
  const ACCTS17 = path.join(TMP, 'accounts17.json');
  fs.writeFileSync(ACCTS17, JSON.stringify({
    claude: [{ name: 'a1', dir: 'acct/claude/a1' }, { name: 'a2', dir: 'acct/claude/a2' }],
  }));
  const CLAUDE_AUTHFAIL = writeStub('claude-authfail.sh', 'claude-sim', {
    FAKE_CLI_ENV_LOG: ENVLOG17, FAKE_CLI_AUTH_FAIL: '1',
  });
  await bootProvider(P17, {
    CLAUDE_PATH: CLAUDE_AUTHFAIL, GEMINI_PATH: AGY_ACCT, BRIDGE_ACCOUNTS_FILE: ACCTS17, PROVIDER_API_KEY: 'adm17',
  });
  const call17 = (model) => request(P17, {
    path: '/v1/chat/completions', method: 'POST', headers: { Authorization: 'Bearer adm17' },
    body: { model, messages: [{ role: 'user', content: 'x' }] },
  });
  r = await call17('bridge-claude-haiku-4.5-spark');
  assert(r.status === 503 && errType(r) === 'engine_auth_error', 'logged-out pool answers 503 engine_auth_error');
  r = await request(P17, { path: '/dashboard/status' });
  {
    const st = JSON.parse(r.body);
    assert(st.accounts.claude.every((a) => a.needsLogin === true), 'both accounts marked needs-login after auth failures');
  }
  r = await request(P17, {
    path: '/admin/routes', method: 'POST', headers: { Authorization: 'Bearer adm17' },
    body: { id: 'pin-test', label: 'Pin', engine: 'claude', model: 'x', account: 'a1' },
  });
  assert(r.status === 200, 'admin can add a pinned route');
  const spawnsBefore17 = fs.existsSync(ENVLOG17) ? fs.readFileSync(ENVLOG17, 'utf8').trim().split('\n').length : 0;
  r = await call17('pin-test');
  const spawnsAfter17 = fs.existsSync(ENVLOG17) ? fs.readFileSync(ENVLOG17, 'utf8').trim().split('\n').length : 0;
  assert(r.status === 503 && errType(r) === 'engine_auth_error' && spawnsAfter17 === spawnsBefore17,
    'pinned needs-login account fails loud without spawning or failing over');
  r = await request(P17, {
    path: '/admin/accounts/claude/a1/probe', method: 'POST', headers: { Authorization: 'Bearer adm17' },
  });
  assert(r.status === 502 && JSON.parse(r.body).kind === 'auth', 'probe on a logged-out account reports auth failure');

  // ── Named API keys: roles, mint/revoke, key pin, ledger attribution ──────
  console.log('\n## Named API keys — roles, mint/revoke, key pin, ledger');
  const P18 = 19570;
  const CREDS18 = path.join(TMP, 'creds18.json');
  const ENVLOG18 = path.join(TMP, 'env18.log');
  const ACCTS18 = path.join(TMP, 'accounts18.json');
  const USAGE18 = path.join(TMP, 'usage-19570'); // bootProvider's default for this port
  const ADMIN18 = 'A'.repeat(48);
  const APP18 = 'B'.repeat(48);
  fs.writeFileSync(ACCTS18, JSON.stringify({
    claude: [{ name: 'w1', dir: 'acct/claude/w1' }, { name: 'w2', dir: 'acct/claude/w2' }],
  }));
  fs.writeFileSync(CREDS18, JSON.stringify({
    version: 2,
    keys: [
      { name: 'admin', role: 'admin', key: ADMIN18, createdAt: '2026-01-01T00:00:00Z' },
      { name: 'hermes', role: 'app', key: APP18, accountPin: { claude: 'w1' }, createdAt: '2026-01-02T00:00:00Z' },
    ],
  }));
  const CLAUDE_KEYS = writeStub('claude-keys.sh', 'claude-sim', { FAKE_CLI_ENV_LOG: ENVLOG18 });
  await bootProvider(P18, {
    CLAUDE_PATH: CLAUDE_KEYS, GEMINI_PATH: AGY_ACCT,
    BRIDGE_CREDENTIALS_FILE: CREDS18, BRIDGE_ACCOUNTS_FILE: ACCTS18, USAGE_FLUSH_MS: '50',
  });
  const chat18 = (key, model) => request(P18, {
    path: '/v1/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${key}` },
    body: { model, messages: [{ role: 'user', content: 'hi' }] },
  });
  const envCount18 = () => (fs.existsSync(ENVLOG18) ? fs.readFileSync(ENVLOG18, 'utf8').trim().split('\n').filter(Boolean).length : 0);
  const envDirsSince = (from) => fs.readFileSync(ENVLOG18, 'utf8').trim().split('\n').filter(Boolean).slice(from)
    .map(JSON.parse).filter((l) => l.argv.includes('-p')).map((l) => l.CLAUDE_CONFIG_DIR);

  // Roles: app key reaches /v1 but not /admin; admin key reaches both.
  r = await chat18(APP18, 'bridge-claude-haiku-4.5-spark');
  assert(r.status === 200, 'app-role key can call /v1/chat/completions');
  r = await request(P18, { path: '/admin/keys', headers: { Authorization: `Bearer ${APP18}` } });
  assert(r.status === 403, 'app-role key is rejected (403) on /admin');
  r = await request(P18, { path: '/admin/keys', headers: { Authorization: `Bearer ${ADMIN18}` } });
  {
    const keys = JSON.parse(r.body).keys || [];
    const hermes = keys.find((k) => k.name === 'hermes');
    assert(r.status === 200 && keys.length === 2, 'admin key lists all named keys');
    assert(keys.every((k) => !('key' in k)), '/admin/keys never returns secret values');
    assert(hermes && hermes.role === 'app' && hermes.accountPin.claude === 'w1', 'listed app key carries role + accountPin');
  }
  r = await request(P18, { path: '/admin/keys', method: 'POST', headers: { Authorization: `Bearer ${ADMIN18}` }, body: { name: 'ci', role: 'app' } });
  const minted = JSON.parse(r.body);
  assert(r.status === 200 && /^sk-bridge-[0-9a-f]{48}$/.test(minted.key), 'mint returns an sk-bridge-prefixed secret once');
  r = await chat18(minted.key, 'bridge-claude-haiku-4.5-spark');
  assert(r.status === 200, 'freshly minted (prefixed) key authorizes /v1');
  r = await chat18(minted.key.replace('sk-bridge-', ''), 'bridge-claude-haiku-4.5-spark');
  assert(r.status === 200, 'the bare secret (no prefix) also authorizes — legacy keys keep working');
  r = await request(P18, { path: '/admin/keys/ci', method: 'DELETE', headers: { Authorization: `Bearer ${ADMIN18}` } });
  assert(r.status === 200, 'admin can revoke a key');
  r = await chat18(minted.key, 'bridge-claude-haiku-4.5-spark');
  assert(r.status === 401, 'revoked key no longer authorizes');

  // Key pin overrides rotation: admin (unpinned) rotates w1/w2; hermes pins w1.
  const a0 = envCount18();
  await chat18(ADMIN18, 'bridge-claude-haiku-4.5-spark');
  await chat18(ADMIN18, 'bridge-claude-haiku-4.5-spark');
  const adminDirs = envDirsSince(a0);
  assert(new Set(adminDirs).size === 2, 'unpinned admin key rotates across both accounts');
  const h0 = envCount18();
  await chat18(APP18, 'bridge-claude-haiku-4.5-spark');
  await chat18(APP18, 'bridge-claude-haiku-4.5-spark');
  const hermesDirs = envDirsSince(h0);
  assert(hermesDirs.length === 2 && hermesDirs.every((d) => /\/w1$/.test(d)), 'key accountPin forces every call onto the pinned account');

  // Durable ledger attributes keyName + account (flush is 50ms here).
  await new Promise((res) => setTimeout(res, 150));
  const ledger18 = fs.existsSync(USAGE18)
    ? fs.readdirSync(USAGE18).filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => fs.readFileSync(path.join(USAGE18, f), 'utf8').trim().split('\n')).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean)
    : [];
  assert(ledger18.some((e) => e.keyName === 'hermes' && e.account === 'w1'), 'ledger records keyName + account for pinned app-key traffic');
  assert(ledger18.some((e) => e.keyName === 'admin'), 'ledger records keyName for admin-key traffic');

  // v1 → v3 migration on a real boot: legacy file still authorizes, file
  // upgraded with the secret hashed at rest.
  console.log('\n## Credentials v1 → v3 migration');
  const P19 = 19580;
  const CREDS19 = path.join(TMP, 'creds19.json');
  const LEGACY = 'legacy'.padEnd(48, '0');
  fs.writeFileSync(CREDS19, JSON.stringify({ apiKey: LEGACY, createdAt: '2026-01-01T00:00:00Z' }));
  await bootProvider(P19, { CLAUDE_PATH: CLAUDE_KEYS, GEMINI_PATH: AGY_ACCT, BRIDGE_CREDENTIALS_FILE: CREDS19 });
  r = await request(P19, { path: '/v1/models', headers: { Authorization: `Bearer ${LEGACY}` } });
  assert(r.status === 200, 'migrated legacy key still authorizes /v1');
  r = await request(P19, { path: '/v1/models' });
  assert(r.status === 401, 'auth is enforced after migration (no token → 401)');
  {
    const onDisk = JSON.parse(fs.readFileSync(CREDS19, 'utf8'));
    assert(onDisk.version === 3 && onDisk.keys[0].keyHash && !('key' in onDisk.keys[0]) && onDisk.keys[0].role === 'admin'
      && !fs.readFileSync(CREDS19, 'utf8').includes(LEGACY),
      'v1 file migrated to v3 in place — key value verifies but is hashed at rest');
  }

  // ── Per-key limits + dashboard auth (the SaaS boundary) ─────────────────
  console.log('\n## Per-key limits (rpm / tokens-per-day / $-per-month) + dashboard auth');
  const P25 = 19640;
  const CREDS25 = path.join(TMP, 'creds25.json');
  const ADMIN25 = 'C'.repeat(48);
  const LIM25 = 'D'.repeat(48);
  fs.writeFileSync(CREDS25, JSON.stringify({
    version: 2,
    keys: [
      { name: 'admin', role: 'admin', key: ADMIN25, createdAt: '2026-01-01T00:00:00Z' },
      { name: 'lim', role: 'app', key: LIM25, limits: { rpm: 2 }, createdAt: '2026-01-02T00:00:00Z' },
    ],
  }));
  await bootProvider(P25, {
    CLAUDE_PATH: CLAUDE_KEYS, GEMINI_PATH: AGY_ACCT,
    BRIDGE_CREDENTIALS_FILE: CREDS25, USAGE_FLUSH_MS: '50', DASHBOARD_AUTH: '1',
  });
  const chat25 = (key) => request(P25, {
    path: '/v1/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${key}` },
    body: { model: 'bridge-claude-haiku-4.5-spark', messages: [{ role: 'user', content: 'x' }] },
  });

  // rpm: two pass, the third inside the same minute gets 429 + Retry-After.
  r = await chat25(LIM25);
  assert(r.status === 200, 'request 1/2 under the rpm limit passes');
  r = await chat25(LIM25);
  assert(r.status === 200, 'request 2/2 reaches the rpm cap');
  r = await chat25(LIM25);
  assert(r.status === 429 && errType(r) === 'rate_limit_error', 'request over the rpm cap → 429 rate_limit_error');
  assert(Number(r.headers['retry-after']) >= 1 && Number(r.headers['retry-after']) <= 60, '429 carries a sane Retry-After');
  r = await chat25(ADMIN25);
  assert(r.status === 200, 'a key without limits is unaffected');

  // Daily token budget: PATCH the key down to 1 token/day — the two earlier
  // successes already consumed real (fake-CLI) tokens, so the next call trips.
  r = await request(P25, {
    path: '/admin/keys/lim', method: 'PATCH', headers: { Authorization: `Bearer ${ADMIN25}` },
    body: { limits: { tokensPerDay: 1 } },
  });
  assert(r.status === 200 && JSON.parse(r.body).limits.tokensPerDay === 1, 'PATCH /admin/keys/:name updates limits');
  r = await chat25(LIM25);
  assert(r.status === 429 && /Daily token budget/i.test(JSON.parse(r.body).error.message),
    'exhausted daily token budget → 429 naming the budget');

  // Clearing limits restores unlimited service.
  r = await request(P25, {
    path: '/admin/keys/lim', method: 'PATCH', headers: { Authorization: `Bearer ${ADMIN25}` },
    body: { limits: {} },
  });
  assert(r.status === 200, 'PATCH with empty limits clears them');
  r = await chat25(LIM25);
  assert(r.status === 200, 'cleared limits → key is unlimited again');

  // Mint with limits + list exposes limits and live usage counters.
  r = await request(P25, {
    path: '/admin/keys', method: 'POST', headers: { Authorization: `Bearer ${ADMIN25}` },
    body: { name: 'alice', role: 'app', limits: { rpm: 5, tokensPerDay: 100000, usdPerMonth: 10 } },
  });
  assert(r.status === 200 && JSON.parse(r.body).limits.usdPerMonth === 10, 'mint accepts limits');
  r = await request(P25, {
    path: '/admin/keys', method: 'POST', headers: { Authorization: `Bearer ${ADMIN25}` },
    body: { name: 'bad', role: 'app', limits: { rpm: 0 } },
  });
  assert(r.status === 400, 'invalid limits (rpm 0) are rejected with 400');
  r = await request(P25, { path: '/admin/keys', headers: { Authorization: `Bearer ${ADMIN25}` } });
  {
    const keys = JSON.parse(r.body).keys || [];
    const lim = keys.find((k) => k.name === 'lim');
    const alice = keys.find((k) => k.name === 'alice');
    assert(alice && alice.limits.rpm === 5, 'list returns limits');
    assert(lim && lim.usage && lim.usage.tokensToday > 0, 'list returns live per-key consumption');
  }

  // Dashboard auth: DASHBOARD_AUTH=1 gates data endpoints, not the static UI.
  r = await request(P25, { path: '/dashboard/status' });
  assert(r.status === 401, 'DASHBOARD_AUTH=1: /dashboard/status without a key → 401');
  r = await request(P25, { path: '/dashboard/status', headers: { Authorization: `Bearer ${ADMIN25}` } });
  assert(r.status === 200, 'admin Bearer header unlocks /dashboard/status');
  r = await request(P25, { path: `/dashboard/usage?range=today&key=${ADMIN25}` });
  assert(r.status === 401, '?key= no longer unlocks /dashboard/usage (query keys leak into logs — header only)');
  r = await request(P25, { path: '/dashboard/usage?range=today', headers: { Authorization: `Bearer ${ADMIN25}` } });
  assert(r.status === 200, 'admin Bearer header unlocks /dashboard/usage');
  r = await request(P25, { path: '/dashboard/status', headers: { Authorization: `Bearer ${LIM25}` } });
  assert(r.status === 401, 'app-role key cannot read the dashboard');
  r = await request(P25, { path: '/dashboard/' });
  assert(r.status === 200 && /html/i.test(String(r.headers['content-type'])), 'static dashboard UI stays public');

  // ── Users, sessions, and the profile API (SaaS login) ───────────────────
  console.log('\n## Users, sessions, and the profile API (SaaS login)');
  const P26 = 19650;
  const DIR26 = path.join(TMP, 'p26');
  fs.mkdirSync(DIR26, { recursive: true });
  const CREDS26 = path.join(DIR26, 'creds26.json');
  const ADMIN26 = 'E'.repeat(48);
  fs.writeFileSync(CREDS26, JSON.stringify({
    version: 2,
    keys: [{ name: 'admin', role: 'admin', key: ADMIN26, createdAt: '2026-01-01T00:00:00Z' }],
  }));
  await bootProvider(P26, {
    CLAUDE_PATH: CLAUDE_KEYS, GEMINI_PATH: AGY_ACCT,
    BRIDGE_CREDENTIALS_FILE: CREDS26,
    BRIDGE_USERS_FILE: path.join(DIR26, 'users.json'),
    BRIDGE_SESSIONS_FILE: path.join(DIR26, 'sessions.json'),
    BRIDGE_ACCOUNTS_FILE: path.join(DIR26, 'accounts.json'),
    USAGE_FLUSH_MS: '50', DASHBOARD_AUTH: '1',
  });

  const users26 = JSON.parse(fs.readFileSync(path.join(DIR26, 'users.json'), 'utf8'));
  assert(users26.users.length === 1 && users26.users[0].role === 'admin' && /^scrypt\$/.test(users26.users[0].passwordHash),
    'first boot bootstraps a scrypt-hashed admin user');

  r = await request(P26, {
    path: '/admin/users', method: 'POST', headers: { Authorization: `Bearer ${ADMIN26}` },
    body: { username: 'alice', password: 'wonderland1', role: 'user', defaultLimits: { rpm: 3 } },
  });
  assert(r.status === 200 && JSON.parse(r.body).username === 'alice', 'admin creates a user via /admin/users');

  r = await request(P26, { path: '/auth/login', method: 'POST', body: { username: 'alice', password: 'nope-nope' } });
  assert(r.status === 401, 'wrong password → 401');
  r = await request(P26, { path: '/auth/login', method: 'POST', body: { username: 'alice', password: 'wonderland1' } });
  assert(r.status === 200, 'correct password logs in');
  const cookie = String(r.headers['set-cookie'] || '').split(';')[0];
  assert(/^bridge_session=[0-9a-f]{48}$/.test(cookie), 'login sets a session cookie');
  assert(/HttpOnly/i.test(String(r.headers['set-cookie'])), 'session cookie is HttpOnly');

  r = await request(P26, { path: '/auth/me', headers: { Cookie: cookie } });
  assert(r.status === 200 && JSON.parse(r.body).user.username === 'alice', '/auth/me resolves the session');

  r = await request(P26, { path: '/me/keys', method: 'POST', headers: { Cookie: cookie }, body: { app: 'chatbot' } });
  const aliceKey = JSON.parse(r.body);
  assert(r.status === 200 && aliceKey.name === 'alice.chatbot' && aliceKey.limits.rpm === 3,
    'user mints a namespaced key inheriting their default limits');

  r = await request(P26, {
    path: '/v1/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${aliceKey.key}` },
    body: { model: 'bridge-claude-haiku-4.5-spark', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(r.status === 200, "the user's key authorizes /v1");

  await new Promise((res) => setTimeout(res, 150));
  r = await request(P26, { path: '/me/usage?range=today', headers: { Cookie: cookie } });
  {
    const u = JSON.parse(r.body);
    assert(u.totals.requests === 1 && u.perKey[0].keyName === 'alice.chatbot', '/me/usage sees only own keys');
  }

  // The dashboard Tester: a session alone authorizes /v1 (no key paste),
  // attributed as user:<name> with the user's default limits applied.
  r = await request(P26, {
    path: '/v1/chat/completions', method: 'POST', headers: { Cookie: cookie },
    body: { model: 'bridge-claude-haiku-4.5-spark', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(r.status === 200, 'a signed-in session authorizes /v1 directly (Tester path)');

  r = await request(P26, { path: '/me/keys/admin', method: 'DELETE', headers: { Cookie: cookie } });
  assert(r.status === 403, "a user can't revoke a key they don't own");
  r = await request(P26, { path: '/admin/users', headers: { Cookie: cookie } });
  assert(r.status === 401, "a user session can't reach /admin");

  r = await request(P26, {
    path: '/admin/users/admin', method: 'PATCH', headers: { Authorization: `Bearer ${ADMIN26}` },
    body: { password: 'supersecret9' },
  });
  assert(r.status === 200, 'admin key can reset a login password');
  r = await request(P26, { path: '/auth/login', method: 'POST', body: { username: 'admin', password: 'supersecret9' } });
  assert(r.status === 200, 'admin logs in with the reset password');
  const adminCookie = String(r.headers['set-cookie'] || '').split(';')[0];
  r = await request(P26, { path: '/dashboard/status', headers: { Cookie: adminCookie } });
  assert(r.status === 200, 'admin session unlocks the gated dashboard (no key paste)');
  r = await request(P26, { path: '/admin/users', headers: { Cookie: adminCookie } });
  {
    const d = JSON.parse(r.body);
    const alice = (d.users || []).find((u) => u.username === 'alice');
    assert(alice && alice.keys.includes('alice.chatbot') && alice.usageToday.requests === 1,
      '/admin/users rolls up keys + per-user usage');
  }
  r = await request(P26, { path: '/dashboard/usage?range=today', headers: { Cookie: adminCookie } });
  assert(((JSON.parse(r.body).perUser) || []).some((x) => x.user === 'alice'), 'dashboard usage has a per-user dimension');

  r = await request(P26, {
    path: '/admin/users/alice', method: 'PATCH', headers: { Authorization: `Bearer ${ADMIN26}` }, body: { disabled: true },
  });
  assert(r.status === 200, 'admin disables a user');
  r = await request(P26, { path: '/auth/me', headers: { Cookie: cookie } });
  assert(r.status === 401, "a disabled user's session stops resolving");
  r = await request(P26, { path: '/admin/users/alice', method: 'DELETE', headers: { Authorization: `Bearer ${ADMIN26}` } });
  {
    const d = JSON.parse(r.body);
    assert(r.status === 200 && d.revokedKeys.includes('alice.chatbot'), 'deleting a user revokes their keys');
  }
  r = await request(P26, {
    path: '/v1/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${aliceKey.key}` },
    body: { model: 'bridge-claude-haiku-4.5-spark', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(r.status === 401, "a deleted user's key no longer authorizes");
  r = await request(P26, { path: '/admin/users/admin', method: 'DELETE', headers: { Authorization: `Bearer ${ADMIN26}` } });
  assert(r.status === 400, 'the last admin user cannot be deleted');

  // Web account onboarding (the dashboard "Add account" panel).
  r = await request(P26, {
    path: '/admin/accounts/claude', method: 'POST', headers: { Authorization: `Bearer ${ADMIN26}` },
    body: { name: 'webacct', token: 'sk-ant-oat01-fake-token-for-tests' },
  });
  assert(r.status === 200 && JSON.parse(r.body).ok, 'claude account added via the web endpoint');
  {
    const doc = JSON.parse(fs.readFileSync(path.join(DIR26, 'accounts.json'), 'utf8'));
    assert(doc.claude.some((a) => a.name === 'webacct'), 'accounts.json gains the entry (pool hot-reloads)');
    const creds = JSON.parse(fs.readFileSync(path.join(DIR26, 'accounts', 'claude', 'webacct', '.credentials.json'), 'utf8'));
    assert(creds.claudeAiOauth.accessToken === 'sk-ant-oat01-fake-token-for-tests', 'pasted token stored as the account credentials');
  }
  r = await request(P26, {
    path: '/admin/accounts/gemini', method: 'POST', headers: { Authorization: `Bearer ${ADMIN26}` },
    body: { name: 'webgem', oauthToken: '{"token":"t1","auth_method":"oauth"}', email: 'g@example.com' },
  });
  assert(r.status === 200, 'gemini account added via the web endpoint');
  assert(fs.existsSync(path.join(DIR26, 'accounts', 'gemini', 'webgem', '.gemini', 'antigravity-cli', 'antigravity-oauth-token')),
    'gemini oauth token file written in the agy layout');
  r = await request(P26, {
    path: '/admin/accounts/claude', method: 'POST', headers: { Authorization: `Bearer ${ADMIN26}` },
    body: { name: 'bad', token: 'not-a-token' },
  });
  assert(r.status === 400, 'a non sk-ant token is rejected with 400');

  // ── Primary account + soft pins (per-app assignment with failover) ──────
  console.log('\n## Primary account preference + soft/hard pins');
  const P27 = 19660;
  const DIR27 = path.join(TMP, 'p27');
  fs.mkdirSync(DIR27, { recursive: true });
  const CREDS27 = path.join(DIR27, 'creds27.json');
  const ACCTS27 = path.join(DIR27, 'accounts.json');
  const ENVLOG27 = path.join(TMP, 'env27.log');
  const ADMIN27 = 'F'.repeat(48);
  const SOFT27 = '1'.repeat(48);
  const HARD27 = '2'.repeat(48);
  fs.writeFileSync(ACCTS27, JSON.stringify({
    claude: [
      { name: 'w1', dir: 'accounts/claude/w1' },
      { name: 'w2', dir: 'accounts/claude/w2', primary: true },
    ],
  }));
  fs.writeFileSync(CREDS27, JSON.stringify({
    version: 2,
    keys: [
      { name: 'admin', role: 'admin', key: ADMIN27, createdAt: '2026-01-01T00:00:00Z' },
      { name: 'app-soft', role: 'app', key: SOFT27, accountPin: { claude: 'w1' }, pinMode: 'soft', createdAt: '2026-01-02T00:00:00Z' },
      { name: 'app-hard', role: 'app', key: HARD27, accountPin: { claude: 'w1' }, pinMode: 'hard', createdAt: '2026-01-03T00:00:00Z' },
    ],
  }));
  const CLAUDE_P27 = writeStub('claude-p27.sh', 'claude-sim', { FAKE_CLI_ENV_LOG: ENVLOG27 });
  await bootProvider(P27, {
    CLAUDE_PATH: CLAUDE_P27, GEMINI_PATH: AGY_ACCT,
    BRIDGE_CREDENTIALS_FILE: CREDS27, BRIDGE_ACCOUNTS_FILE: ACCTS27,
    BRIDGE_USERS_FILE: path.join(DIR27, 'users.json'),
    BRIDGE_SESSIONS_FILE: path.join(DIR27, 'sessions.json'),
  });
  const chat27 = (key) => request(P27, {
    path: '/v1/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${key}` },
    body: { model: 'bridge-claude-haiku-4.5-spark', messages: [{ role: 'user', content: 'x' }] },
  });
  const dirs27 = () => fs.readFileSync(ENVLOG27, 'utf8').trim().split('\n').filter(Boolean)
    .map(JSON.parse).filter((l) => l.argv.includes('-p')).map((l) => l.CLAUDE_CONFIG_DIR);

  // Unpinned traffic prefers the primary while it is healthy.
  r = await chat27(ADMIN27);
  assert(r.status === 200, 'unpinned request succeeds');
  r = await chat27(ADMIN27);
  const primDirs = dirs27();
  assert(primDirs.length === 2 && primDirs.every((d) => /\/w2$/.test(d)), 'unpinned traffic sticks to the primary account (w2)');

  // A soft-pinned app uses its assigned account while healthy…
  r = await chat27(SOFT27);
  assert(r.status === 200 && /\/w1$/.test(dirs27().pop()), 'soft-pinned key uses its assigned account (w1)');

  // …but fails over to the pool when the assignment is unusable. Hard pins fail loud.
  r = await request(P27, { path: '/admin/accounts/claude/w1/disable', method: 'POST', headers: { Authorization: `Bearer ${ADMIN27}` } });
  assert(r.status === 200, 'admin disables w1');
  r = await chat27(SOFT27);
  assert(r.status === 200 && /\/w2$/.test(dirs27().pop()), 'soft pin fails over to the healthy account (w2)');
  r = await chat27(HARD27);
  assert(r.status === 503, 'hard pin fails loud (503) when its account is down');
  await request(P27, { path: '/admin/accounts/claude/w1/enable', method: 'POST', headers: { Authorization: `Bearer ${ADMIN27}` } });

  // Moving the primary persists in accounts.json and redirects traffic.
  r = await request(P27, { path: '/admin/accounts/claude/w1/primary', method: 'POST', headers: { Authorization: `Bearer ${ADMIN27}` } });
  assert(r.status === 200, 'set-primary endpoint succeeds');
  {
    const doc = JSON.parse(fs.readFileSync(ACCTS27, 'utf8'));
    const w1 = doc.claude.find((a) => a.name === 'w1');
    const w2 = doc.claude.find((a) => a.name === 'w2');
    assert(w1.primary === true && w2.primary === undefined, 'primary flag moved to w1 in accounts.json');
  }
  r = await chat27(ADMIN27);
  assert(r.status === 200 && /\/w1$/.test(dirs27().pop()), 'unpinned traffic follows the new primary (w1)');

  // Validation: bad pinMode rejected at mint.
  r = await request(P27, {
    path: '/admin/keys', method: 'POST', headers: { Authorization: `Bearer ${ADMIN27}` },
    body: { name: 'bad', role: 'app', accountPin: { claude: 'w1' }, pinMode: 'sideways' },
  });
  assert(r.status === 400, 'invalid pinMode rejected with 400');

  // Guided claude browser login: start hands out a claude.ai PKCE link; finish
  // rejects unknown/expired attempts (the happy path needs a human + browser).
  r = await request(P27, {
    path: '/admin/oauth/claude/start', method: 'POST', headers: { Authorization: `Bearer ${ADMIN27}` },
    body: { name: 'browser1' },
  });
  {
    const d = JSON.parse(r.body);
    assert(r.status === 200 && d.url.startsWith('https://claude.ai/oauth/authorize?')
      && d.url.includes('code_challenge=') && /^[A-Za-z0-9_-]{10,}$/.test(d.state),
      'oauth start returns a claude.ai authorize link + state');
  }
  r = await request(P27, {
    path: '/admin/oauth/claude/start', method: 'POST', headers: { Authorization: `Bearer ${ADMIN27}` },
    body: { name: 'bad name!' },
  });
  assert(r.status === 400, 'oauth start rejects invalid account names');
  r = await request(P27, {
    path: '/admin/oauth/claude/finish', method: 'POST', headers: { Authorization: `Bearer ${ADMIN27}` },
    body: { code: 'whatever#not-a-real-state' },
  });
  assert(r.status === 400, 'oauth finish rejects an unknown state');

  // Account rename: dir moves, accounts.json updates, key pins repoint.
  r = await request(P27, {
    path: '/admin/keys', method: 'POST', headers: { Authorization: `Bearer ${ADMIN27}` },
    body: { name: 'pinme', role: 'app', accountPin: { claude: 'w2' } },
  });
  assert(r.status === 200, 'minted a key pinned to w2');
  r = await request(P27, {
    path: '/admin/accounts/claude/w2/rename', method: 'POST', headers: { Authorization: `Bearer ${ADMIN27}` },
    body: { to: 'team-b' },
  });
  assert(r.status === 200 && JSON.parse(r.body).to === 'team-b', 'rename w2 → team-b succeeds');
  {
    const doc = JSON.parse(fs.readFileSync(ACCTS27, 'utf8'));
    assert(doc.claude.some((a) => a.name === 'team-b') && !doc.claude.some((a) => a.name === 'w2'),
      'accounts.json reflects the rename');
  }
  r = await request(P27, { path: '/admin/keys', headers: { Authorization: `Bearer ${ADMIN27}` } });
  {
    const pinme = (JSON.parse(r.body).keys || []).find((k) => k.name === 'pinme');
    assert(pinme && pinme.accountPin.claude === 'team-b', 'key pin repointed to the new account name');
  }

  // CSRF guard: a cross-origin cookie-authed mutation is refused; header-auth
  // (API key) and non-browser (no Origin) requests pass through.
  r = await request(P27, {
    path: '/admin/keys', method: 'POST',
    headers: { Authorization: `Bearer ${ADMIN27}`, Origin: 'https://evil.example.com' },
    body: { name: 'x-origin', role: 'app' },
  });
  assert(r.status === 200, 'header-auth (API key) is exempt from the Origin check');
  r = await request(P27, {
    path: '/admin/keys/x-origin', method: 'DELETE',
    headers: { Cookie: 'bridge_session=deadbeef', Origin: 'https://evil.example.com', Host: `127.0.0.1:${P27}` },
  });
  assert(r.status === 403, 'cross-origin cookie-authed mutation is refused (CSRF guard)');

  // ── Login hardening: forced bootstrap password change + rate limits ─────
  console.log('\n## Login hardening — forced password change + rate limits');
  const P28 = 19670;
  const DIR28 = path.join(TMP, 'p28');
  fs.mkdirSync(DIR28, { recursive: true });
  const CREDS28 = path.join(DIR28, 'creds.json');
  const ADMIN28 = 'F'.repeat(48);
  fs.writeFileSync(CREDS28, JSON.stringify({
    version: 2,
    keys: [{ name: 'admin', role: 'admin', key: ADMIN28, createdAt: '2026-01-01T00:00:00Z' }],
  }));
  const { hashPassword } = require(path.join(REPO, 'packages', 'provider', 'users.js'));
  fs.writeFileSync(path.join(DIR28, 'users.json'), JSON.stringify({
    version: 1,
    users: [
      { username: 'admin', role: 'admin', passwordHash: hashPassword('bootpass123'), mustChangePassword: true, createdAt: '2026-01-01T00:00:00Z' },
      { username: 'bob', role: 'user', passwordHash: hashPassword('bobpassword1'), createdAt: '2026-01-01T00:00:00Z' },
    ],
  }));
  await bootProvider(P28, {
    CLAUDE_PATH: CLAUDE_KEYS, GEMINI_PATH: AGY_ACCT,
    BRIDGE_CREDENTIALS_FILE: CREDS28,
    BRIDGE_USERS_FILE: path.join(DIR28, 'users.json'),
    BRIDGE_SESSIONS_FILE: path.join(DIR28, 'sessions.json'),
    BRIDGE_ACCOUNTS_FILE: path.join(DIR28, 'accounts.json'),
    DASHBOARD_AUTH: '1',
  });

  r = await request(P28, { path: '/auth/login', method: 'POST', body: { username: 'admin', password: 'bootpass123' } });
  assert(r.status === 200 && JSON.parse(r.body).user.mustChangePassword === true,
    'bootstrap-password login reports mustChangePassword');
  const mcCookie = String(r.headers['set-cookie'] || '').split(';')[0];
  {
    const rawTok = mcCookie.split('=')[1];
    const sessRaw = fs.readFileSync(path.join(DIR28, 'sessions.json'), 'utf8');
    assert(!sessRaw.includes(rawTok), 'sessions.json stores hashed tokens, not the live cookie value');
  }
  r = await request(P28, { path: '/dashboard/status', headers: { Cookie: mcCookie } });
  assert(r.status === 403 && JSON.parse(r.body).mustChangePassword === true,
    'must-change session is refused dashboard data');
  r = await request(P28, { path: '/me/keys', headers: { Cookie: mcCookie } });
  assert(r.status === 403, 'must-change session is refused /me');
  r = await request(P28, { path: '/dashboard/', headers: { Cookie: mcCookie } });
  assert(r.status === 200, 'static dashboard shell still loads (hosts the change dialog)');
  r = await request(P28, { path: '/auth/me', headers: { Cookie: mcCookie } });
  assert(r.status === 200, '/auth/me still resolves for the gated session');
  r = await request(P28, { path: '/dashboard/status', headers: { Cookie: mcCookie, Authorization: `Bearer ${ADMIN28}` } });
  assert(r.status === 200, 'a valid API key still authorizes despite a gated cookie');
  r = await request(P28, {
    path: '/auth/password', method: 'POST', headers: { Cookie: mcCookie },
    body: { currentPassword: 'WRONG-guess-1', newPassword: 'mynewpass99' },
  });
  assert(r.status === 403, 'wrong current password refused');
  r = await request(P28, {
    path: '/auth/password', method: 'POST', headers: { Cookie: mcCookie },
    body: { currentPassword: 'bootpass123', newPassword: 'mynewpass99' },
  });
  assert(r.status === 200, 'password change succeeds with the correct current password');
  r = await request(P28, { path: '/auth/login', method: 'POST', body: { username: 'admin', password: 'mynewpass99' } });
  {
    const u = (JSON.parse(r.body) || {}).user || {};
    assert(r.status === 200 && !u.mustChangePassword, 'mustChangePassword clears once the password is replaced');
    const c2 = String(r.headers['set-cookie'] || '').split(';')[0];
    r = await request(P28, { path: '/dashboard/status', headers: { Cookie: c2 } });
    assert(r.status === 200, 'the refreshed session has full access');
  }

  // Rate limits: per-username (5/min), then per-IP across fresh usernames.
  let last = null;
  for (let i = 0; i < 6; i += 1) {
    last = await request(P28, { path: '/auth/login', method: 'POST', body: { username: 'bob', password: 'wrong-pass' } });
  }
  assert(last.status === 429, `6th bad attempt for one username → 429 (got ${last.status})`);
  let ipLimited = null;
  for (let i = 0; i < 25 && !ipLimited; i += 1) {
    const rr = await request(P28, { path: '/auth/login', method: 'POST', body: { username: `ghost${i}`, password: 'wrong-pass' } });
    if (rr.status === 429) ipLimited = rr;
  }
  assert(Boolean(ipLimited), 'sustained cross-username spraying from one IP is rate limited');

  // ── Internet-exposure hardening: headers, cookies, ?key= scope, body caps ─
  console.log('\n## Exposure hardening — headers, secure cookies, ?key= scope, body caps');
  const P29 = 19680;
  const DIR29 = path.join(TMP, 'p29');
  fs.mkdirSync(DIR29, { recursive: true });
  const CREDS29 = path.join(DIR29, 'creds.json');
  const ADMIN29 = '9'.repeat(48);
  fs.writeFileSync(CREDS29, JSON.stringify({
    version: 3,
    keys: [{ name: 'admin', role: 'admin', keyHash: sha256(ADMIN29), createdAt: '2026-01-01T00:00:00Z' }],
  }));
  const AGY_ARGLOG = path.join(DIR29, 'agy-args.log');
  const AGY_ARG = writeStub('agy-arg.sh', 'agy-sim', { FAKE_CLI_ENV_LOG: AGY_ARGLOG });
  await bootProvider(P29, {
    CLAUDE_PATH: writeStub('claude-29.sh', 'claude-sim'), GEMINI_PATH: AGY_ARG,
    BRIDGE_CREDENTIALS_FILE: CREDS29,
    BRIDGE_USERS_FILE: path.join(DIR29, 'users.json'),
    BRIDGE_SESSIONS_FILE: path.join(DIR29, 'sessions.json'),
    BRIDGE_ACCOUNTS_FILE: path.join(DIR29, 'accounts.json'),
    DASHBOARD_AUTH: '1',
  });

  // Security headers on every response.
  r = await request(P29, { path: '/healthz' });
  assert(r.headers['x-content-type-options'] === 'nosniff', 'X-Content-Type-Options: nosniff set');
  assert(r.headers['x-frame-options'] === 'DENY', 'X-Frame-Options: DENY set');
  assert(/same-origin/.test(String(r.headers['referrer-policy'])), 'Referrer-Policy set');
  assert(!r.headers['strict-transport-security'], 'no HSTS on a plain-HTTP request');
  r = await request(P29, { path: '/healthz', headers: { 'X-Forwarded-Proto': 'https' } });
  assert(/max-age=/.test(String(r.headers['strict-transport-security'])), 'HSTS set when X-Forwarded-Proto: https');

  // Secure cookie flag follows the forwarded protocol (tunnel terminates TLS).
  r = await request(P29, {
    path: '/auth/login', method: 'POST', headers: { 'X-Forwarded-Proto': 'https' },
    body: { username: 'admin', password: 'nope' },
  });
  // (login fails, but a login that succeeds must carry Secure; test with a real user)
  r = await request(P29, {
    path: '/admin/users', method: 'POST', headers: { Authorization: `Bearer ${ADMIN29}` },
    body: { username: 'carol', password: 'carolpass12', role: 'user' },
  });
  assert(r.status === 200, 'admin created a user for the cookie test');
  r = await request(P29, {
    path: '/auth/login', method: 'POST', headers: { 'X-Forwarded-Proto': 'https' },
    body: { username: 'carol', password: 'carolpass12' },
  });
  assert(/Secure/.test(String(r.headers['set-cookie'])), 'session cookie carries Secure behind an https proxy');
  r = await request(P29, { path: '/auth/login', method: 'POST', body: { username: 'carol', password: 'carolpass12' } });
  assert(!/Secure/.test(String(r.headers['set-cookie'])), 'session cookie omits Secure on a plain-HTTP hop');

  // ?key= is honored on the SSE stream but refused on other gated endpoints.
  r = await request(P29, { path: `/dashboard/status?key=${ADMIN29}` });
  assert(r.status === 401, '?key= is refused on /dashboard/status (would leak into logs)');
  r = await request(P29, { path: '/dashboard/status', headers: { Authorization: `Bearer ${ADMIN29}` } });
  assert(r.status === 200, 'the Authorization header still authorizes /dashboard/status');
  // The SSE stream never ends, so check the response head then close the
  // socket — request() would hang waiting for 'end'.
  {
    const sse = await new Promise((resolve) => {
      const req = http.request({ port: P29, path: `/dashboard/events?key=${ADMIN29}`, method: 'GET' }, (res) => {
        resolve({ status: res.statusCode, ctype: String(res.headers['content-type'] || '') });
        res.destroy();
        req.destroy();
      });
      req.on('error', () => resolve({ status: 0, ctype: '' }));
      req.end();
    });
    assert(sse.status === 200 && /text\/event-stream/.test(sse.ctype), '?key= is honored on the SSE stream (EventSource can\'t set headers)');
  }

  // Body caps: an oversized control-plane body is a clean 400, not a crash.
  r = await request(P29, {
    path: '/admin/keys', method: 'POST', headers: { Authorization: `Bearer ${ADMIN29}` },
    body: { name: 'big', role: 'app', junk: 'z'.repeat(400 * 1024) },
  });
  assert(r.status === 400, 'oversized control-plane body → clean 400 (256KB cap off /v1)');

  // agy argv guard: through /v1 the flattened prompt is role-prefixed ([USER]…),
  // so it reaches the CLI intact as the --print value (never split into flags).
  r = await request(P29, {
    path: '/v1/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${ADMIN29}` },
    body: { model: 'bridge-agy-gemini-3.5-flash-medium-pulse', messages: [{ role: 'user', content: '-rf danger' }] },
  });
  assert(r.status === 200, 'a gemini prompt containing a leading-dash line is delivered without an arg-parse error');
  {
    const lines = fs.readFileSync(AGY_ARGLOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const call = lines.find((l) => (l.argv || []).includes('--print'));
    const pv = call.argv[call.argv.indexOf('--print') + 1];
    assert(pv.includes('-rf danger'), 'the dash-containing prompt is delivered intact as one --print value');
  }
  // The guard itself: a RAW prompt beginning with '-' (a direct adapter caller,
  // not the role-prefixed /v1 path) gets a protective leading space so the CLI
  // can't read it as a flag.
  {
    const { createAgyAdapter } = require(path.join(REPO, 'packages', 'adapters', 'agy.js'));
    const guardLog = path.join(DIR29, 'agy-guard.log');
    const adapter = createAgyAdapter({ bin: writeStub('agy-guard.sh', 'agy-sim', { FAKE_CLI_ENV_LOG: guardLog }) });
    await adapter.invoke({ prompt: '--help now', model: 'Gemini 3.5 Flash (Medium)' });
    const call = fs.readFileSync(guardLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((l) => (l.argv || []).includes('--print'));
    const pv = call.argv[call.argv.indexOf('--print') + 1];
    assert(pv === ' --help now', 'a raw prompt starting with "-" gets a protective leading space at the adapter');
  }

  // ── Webhook alerting (notify.js) ─────────────────────────────────────────
  console.log('\n## Webhook alerting — formats, cooldown, transitions, end-to-end');
  {
    const { createNotifier, detectFormat } = require(path.join(REPO, 'packages', 'provider', 'notify.js'));
    assert(detectFormat('https://hooks.slack.com/services/T/B/x') === 'slack', 'slack URL auto-detected');
    assert(detectFormat('https://discord.com/api/webhooks/1/x') === 'discord', 'discord URL auto-detected');
    assert(detectFormat('https://ntfy.sh/my-topic') === 'ntfy', 'ntfy URL auto-detected');
    assert(detectFormat('https://example.com/hook') === 'json', 'unknown URL falls back to json');

    const calls = [];
    const fakeFetch = (url, opts) => { calls.push({ url, opts }); return Promise.resolve({ ok: true }); };
    const n = createNotifier({ url: 'https://hooks.slack.com/services/T/B/x', fetchImpl: fakeFetch, cooldownMs: 60000, logger: { warn: () => {} } });

    n.handle('account.change', { kind: 'breaker', engine: 'claude', account: 'main', breaker: { state: 'open', reason: 'quota', retryInSec: 900 } });
    assert(calls.length === 1 && JSON.parse(calls[0].opts.body).text.includes('claude:main breaker OPEN (quota)'),
      'breaker open → slack {text} alert');
    n.handle('account.change', { kind: 'breaker', engine: 'claude', account: 'main', breaker: { state: 'open', reason: 'quota' } });
    assert(calls.length === 1, 'repeat open within cooldown is suppressed');
    n.handle('account.change', { kind: 'breaker', engine: 'claude', account: 'main', breaker: { state: 'closed' } });
    assert(calls.length === 2 && JSON.parse(calls[1].opts.body).text.includes('healthy again'), 'breaker recovery announced');
    n.handle('account.change', { kind: 'needs-login', engine: 'gemini', account: 'work' });
    assert(calls.length === 3 && JSON.parse(calls[2].opts.body).text.includes('gemini:work needs login'), 'needs-login alert');
    n.handle('engine.health', { engine: 'claude', ok: true });
    n.handle('engine.health', { engine: 'claude', ok: true });
    assert(calls.length === 3, 'healthy baseline produces no alert');
    n.handle('engine.health', { engine: 'claude', ok: false, detail: 'binary gone' });
    assert(calls.length === 4 && JSON.parse(calls[3].opts.body).text.includes('health check failing'), 'ok→fail transition alerts');
    n.handle('engine.health', { engine: 'claude', ok: false, detail: 'binary gone' });
    assert(calls.length === 4, 'staying failed does not re-alert');
    n.handle('engine.health', { engine: 'claude', ok: true });
    assert(calls.length === 5 && JSON.parse(calls[4].opts.body).text.includes('healthy again'), 'fail→ok recovery alerts');
    n.handle('engine.health', { engine: 'claude', disabled: true }); // admin toggle carries no ok field
    assert(calls.length === 5, 'events without a boolean ok are ignored');
    n.handle('budget.warning', { keyName: 'alice.app', reason: 'tokensPerDay', pct: 85, used: '85,000', limit: '100,000' });
    assert(calls.length === 6 && JSON.parse(calls[5].opts.body).text.includes('85% of its tokensPerDay budget'), 'budget warning alert');

    const off = createNotifier({ fetchImpl: fakeFetch });
    off.handle('account.change', { kind: 'needs-login', engine: 'claude', account: 'x' });
    assert(off.enabled === false && calls.length === 6, 'no URL → disabled, nothing posted');

    const ntfy = [];
    const n2 = createNotifier({ url: 'https://ntfy.sh/topic', fetchImpl: (u, o) => { ntfy.push(o); return Promise.resolve({ ok: true }); } });
    n2.handle('account.change', { kind: 'needs-login', engine: 'claude', account: 'y' });
    assert(ntfy.length === 1 && typeof ntfy[0].body === 'string' && !ntfy[0].body.startsWith('{') && ntfy[0].headers.Title,
      'ntfy format posts plain text with a Title header');
  }

  // End-to-end: a real quota breaker-open reaches the webhook server.
  {
    const hits = [];
    const hookSrv = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => { hits.push(b); res.end('ok'); });
    });
    await new Promise((res) => hookSrv.listen(0, '127.0.0.1', res));
    const hookPort = hookSrv.address().port;

    const P30 = 19690;
    const CLAUDE_Q30 = writeStub('claude-q30.sh', 'claude-sim', { FAKE_CLI_STDERR: 'Claude usage limit reached. Your limit will reset at 5pm.' });
    await bootProvider(P30, {
      CLAUDE_PATH: CLAUDE_Q30, GEMINI_PATH: AGY_STUB,
      BRIDGE_WEBHOOK_URL: `http://127.0.0.1:${hookPort}/hook`,
    });
    for (let i = 0; i < 3; i += 1) {
      await request(P30, {
        path: '/v1/chat/completions', method: 'POST',
        body: { model: 'bridge-smart', messages: [{ role: 'user', content: 'x' }] },
      });
    }
    await new Promise((res) => setTimeout(res, 300));
    assert(hits.length >= 1 && hits.some((h) => h.includes('breaker OPEN')),
      `a real breaker-open POSTs to the webhook (got ${hits.length} hits)`);
    {
      const payload = JSON.parse(hits.find((h) => h.includes('breaker OPEN')));
      assert(payload.source && payload.message && payload.at, 'generic json format carries source/message/at');
    }
    hookSrv.close();
  }

  // ── Cross-model failover (quotaFallback): claude exhausted → gemini ─────
  console.log('\n## Cross-model failover — quotaFallback engine reroute');
  const P31 = 19700;
  const CM_ROUTES = path.join(TMP, 'cm-routes.json');
  fs.writeFileSync(CM_ROUTES, JSON.stringify({
    defaultRoute: 'cm-claude',
    routes: [
      { id: 'cm-claude', label: 'CM Claude', engine: 'claude', model: 'claude-x', quotaFallback: 'cm-gem' },
      { id: 'cm-gem', label: 'CM Gemini', engine: 'gemini', model: 'Gemini 3.5 Flash (Medium)' },
      { id: 'cm-claude-nofb', label: 'CM Claude NoFB', engine: 'claude', model: 'claude-x' },
      { id: 'cm-claude-pin', label: 'CM Claude Pinned', engine: 'claude', model: 'claude-x', account: 'default', quotaFallback: 'cm-gem' },
    ],
  }));
  const CLAUDE_Q31 = writeStub('claude-q31.sh', 'claude-sim', { FAKE_CLI_STDERR: 'Claude usage limit reached. Your limit will reset at 5pm.' });
  await bootProvider(P31, { CLAUDE_PATH: CLAUDE_Q31, GEMINI_PATH: AGY_STUB, BRIDGE_ROUTES_FILE: CM_ROUTES });

  // 1. Streaming request, quota fails pre-first-byte → mid-request engine
  //    reroute; the gemini reply streams and the marker rides a chunk.
  r = await request(P31, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'cm-claude', stream: true, messages: [{ role: 'user', content: 'hello stream' }] },
  });
  {
    const chunks = parseSse(r.body);
    const text = chunks.map((c) => (c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.content) || '').join('');
    assert(r.status === 200 && text.includes('[gemini]'), 'streamed request moves engines mid-request and delivers the gemini reply');
    assert(chunks.some((c) => c.bridge_rerouted && c.bridge_rerouted.reason === 'engine_exhausted' && c.bridge_rerouted.to === 'cm-gem'),
      'stream carries the bridge_rerouted engine_exhausted marker');
  }

  // 2. Non-streaming: served by gemini with the reroute marked.
  r = await request(P31, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'cm-claude', messages: [{ role: 'user', content: 'hello again' }] },
  });
  {
    const c = JSON.parse(r.body);
    assert(r.status === 200 && c.choices[0].message.content.includes('[gemini]'),
      'non-streaming request is served by the fallback engine');
    assert(c.bridge_rerouted && c.bridge_rerouted.from === 'cm-claude' && c.bridge_rerouted.reason === 'engine_exhausted',
      'completion carries bridge_rerouted from/reason');
  }

  // 3. By now the claude breaker is open → the reroute happens pre-dispatch
  //    (no doomed claude spawn) and still serves.
  r = await request(P31, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'cm-claude', messages: [{ role: 'user', content: 'third time' }] },
  });
  assert(r.status === 200 && JSON.parse(r.body).bridge_rerouted, 'breaker-open route reroutes pre-dispatch (no claude spawn)');

  // 4. No quotaFallback declared → the honest 429 stands.
  r = await request(P31, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'cm-claude-nofb', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(r.status === 429 && errType(r) === 'rate_limit_error', 'route without quotaFallback still fails 429 (no silent engine switch)');

  // 5. Hard-pinned route never moves engines — it fails loud.
  r = await request(P31, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'cm-claude-pin', messages: [{ role: 'user', content: 'x' }] },
  });
  {
    let body31 = {};
    try { body31 = JSON.parse(r.body); } catch (_) { /* empty */ }
    assert(r.status === 429 && !body31.bridge_rerouted, `hard-pinned route fails loud, never reroutes (got ${r.status})`);
  }

  // ── API key expiry + rotation (end-to-end) ──────────────────────────────
  console.log('\n## API key expiry + rotation');
  const P32 = 19710;
  const DIR32 = path.join(TMP, 'p32');
  fs.mkdirSync(DIR32, { recursive: true });
  const CREDS32 = path.join(DIR32, 'creds.json');
  const ADMIN32 = '7'.repeat(48);
  fs.writeFileSync(CREDS32, JSON.stringify({
    version: 3, keys: [{ name: 'admin', role: 'admin', keyHash: sha256(ADMIN32), createdAt: '2026-01-01T00:00:00Z' }],
  }));
  await bootProvider(P32, {
    CLAUDE_PATH: CLAUDE_KEYS, GEMINI_PATH: AGY_ACCT, BRIDGE_CREDENTIALS_FILE: CREDS32,
    BRIDGE_USERS_FILE: path.join(DIR32, 'users.json'), BRIDGE_SESSIONS_FILE: path.join(DIR32, 'sessions.json'),
    BRIDGE_ACCOUNTS_FILE: path.join(DIR32, 'accounts.json'),
  });
  const chat32 = (key) => request(P32, {
    path: '/v1/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${key}` },
    body: { model: 'bridge-claude-haiku-4.5-spark', messages: [{ role: 'user', content: 'x' }] },
  });

  // Mint an already-expired key → it never authorizes.
  r = await request(P32, {
    path: '/admin/keys', method: 'POST', headers: { Authorization: `Bearer ${ADMIN32}` },
    body: { name: 'expired', role: 'app', expiresAt: '2000-01-01T00:00:00Z' },
  });
  const expiredKey = JSON.parse(r.body).key;
  assert(r.status === 200 && JSON.parse(r.body).expiresAt, 'admin mints a key with an expiry');
  r = await chat32(expiredKey);
  assert(r.status === 401, 'an expired key is refused at /v1');

  // Mint a live key, use it, rotate it → old dies, new works.
  r = await request(P32, {
    path: '/admin/keys', method: 'POST', headers: { Authorization: `Bearer ${ADMIN32}` },
    body: { name: 'rotate-me', role: 'app' },
  });
  const k1 = JSON.parse(r.body).key;
  assert((await chat32(k1)).status === 200, 'a fresh key authorizes /v1');
  r = await request(P32, {
    path: '/admin/keys/rotate-me/rotate', method: 'POST', headers: { Authorization: `Bearer ${ADMIN32}` }, body: {},
  });
  const k2 = JSON.parse(r.body).key;
  assert(r.status === 200 && k2 && k2 !== k1, 'rotate returns a new secret');
  assert((await chat32(k1)).status === 401, 'the pre-rotation secret is dead');
  assert((await chat32(k2)).status === 200, 'the rotated secret works');

  // Grace rotation keeps the old secret alive under a shadow key.
  r = await request(P32, {
    path: '/admin/keys', method: 'POST', headers: { Authorization: `Bearer ${ADMIN32}` }, body: { name: 'grace-me', role: 'app' },
  });
  const g1 = JSON.parse(r.body).key;
  r = await request(P32, {
    path: '/admin/keys/grace-me/rotate', method: 'POST', headers: { Authorization: `Bearer ${ADMIN32}` }, body: { graceDays: 3 },
  });
  const g2 = JSON.parse(r.body).key;
  assert((await chat32(g1)).status === 200 && (await chat32(g2)).status === 200, 'grace rotation: both old and new secrets work during the window');
  r = await request(P32, { path: '/admin/keys', headers: { Authorization: `Bearer ${ADMIN32}` } });
  assert((JSON.parse(r.body).keys || []).some((k) => k.name === 'grace-me.rotated' && k.expiresAt), 'the grace window shows as a shadow key with an expiry');

  // Owner self-service rotation.
  r = await request(P32, {
    path: '/admin/users', method: 'POST', headers: { Authorization: `Bearer ${ADMIN32}` },
    body: { username: 'dave', password: 'davepass123', role: 'user' },
  });
  r = await request(P32, { path: '/auth/login', method: 'POST', body: { username: 'dave', password: 'davepass123' } });
  const daveCookie = String(r.headers['set-cookie'] || '').split(';')[0];
  r = await request(P32, { path: '/me/keys', method: 'POST', headers: { Cookie: daveCookie }, body: { app: 'cli' } });
  const dk1 = JSON.parse(r.body).key;
  r = await request(P32, { path: '/me/keys/dave.cli/rotate', method: 'POST', headers: { Cookie: daveCookie }, body: {} });
  const dk2 = JSON.parse(r.body).key;
  assert(r.status === 200 && dk2 !== dk1, 'owner rotates their own key');
  assert((await chat32(dk1)).status === 401 && (await chat32(dk2)).status === 200, "owner's old secret dies, new one works");
  r = await request(P32, { path: '/me/keys/admin/rotate', method: 'POST', headers: { Cookie: daveCookie }, body: {} });
  assert(r.status === 403, "a user can't rotate a key they don't own");

  // ── Usage CSV export + budget warnings at 80% ───────────────────────────
  console.log('\n## Usage CSV export + 80% budget warnings');
  const hits33 = [];
  const hookSrv33 = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { hits33.push(b); res.end('ok'); }); });
  await new Promise((res) => hookSrv33.listen(0, '127.0.0.1', res));
  const P33 = 19720;
  const DIR33 = path.join(TMP, 'p33');
  fs.mkdirSync(DIR33, { recursive: true });
  const CREDS33 = path.join(DIR33, 'creds.json');
  const ADMIN33 = '5'.repeat(48);
  fs.writeFileSync(CREDS33, JSON.stringify({
    version: 3, keys: [{ name: 'admin', role: 'admin', keyHash: sha256(ADMIN33), createdAt: '2026-01-01T00:00:00Z' }],
  }));
  await bootProvider(P33, {
    CLAUDE_PATH: CLAUDE_KEYS, GEMINI_PATH: AGY_ACCT, BRIDGE_CREDENTIALS_FILE: CREDS33,
    BRIDGE_USERS_FILE: path.join(DIR33, 'users.json'), BRIDGE_SESSIONS_FILE: path.join(DIR33, 'sessions.json'),
    BRIDGE_ACCOUNTS_FILE: path.join(DIR33, 'accounts.json'),
    BRIDGE_WEBHOOK_URL: `http://127.0.0.1:${hookSrv33.address().port}/hook`,
    USAGE_FLUSH_MS: '50', DASHBOARD_AUTH: '1',
  });

  // A key with a tiny daily token budget: the fake CLI reports 16 tokens/call,
  // so call 2 crosses 80% of 18 (warn) and call 3 hits the hard cap (429).
  r = await request(P33, {
    path: '/admin/keys', method: 'POST', headers: { Authorization: `Bearer ${ADMIN33}` },
    body: { name: 'budgeted', role: 'app', limits: { tokensPerDay: 18 } },
  });
  const budKey = JSON.parse(r.body).key;
  const call33 = () => request(P33, {
    path: '/v1/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${budKey}` },
    body: { model: 'bridge-claude-haiku-4.5-spark', messages: [{ role: 'user', content: 'hi' }] },
  });
  r = await call33();
  assert(r.status === 200 && !r.headers['x-bridge-budget-warning'], 'first call: under threshold, no warning header');
  r = await call33();
  assert(r.status === 200 && /tokensPerDay at \d+%/.test(String(r.headers['x-bridge-budget-warning'])),
    `second call: X-Bridge-Budget-Warning header appears (got "${r.headers['x-bridge-budget-warning']}")`);
  r = await call33();
  assert(r.status === 429, 'third call: hard daily cap → 429');
  await new Promise((res) => setTimeout(res, 250));
  assert(hits33.some((h) => h.includes('budget')), `a fresh budget warning fires the webhook once (got ${hits33.length} hits)`);
  hookSrv33.close();

  // CSV export (admin): header row + per-key rows, correct content type.
  r = await request(P33, { path: '/dashboard/usage.csv?range=today', headers: { Authorization: `Bearer ${ADMIN33}` } });
  assert(r.status === 200 && /text\/csv/.test(String(r.headers['content-type'])), 'usage.csv returns text/csv');
  {
    const lines = r.body.trim().split('\n');
    assert(lines[0].startsWith('keyName,'), 'CSV header names the key dimension');
    assert(lines.some((l) => l.startsWith('budgeted,')), 'CSV has a row for the budgeted key');
  }
  r = await request(P33, { path: '/dashboard/usage.csv?range=today&dimension=route', headers: { Authorization: `Bearer ${ADMIN33}` } });
  assert(r.status === 200 && r.body.split('\n')[0].startsWith('routeId,'), 'dimension=route switches the CSV breakdown');
  r = await request(P33, { path: '/dashboard/usage.csv' });
  assert(r.status === 401, 'usage.csv is admin-gated');

  // Owner CSV: a signed-in user gets only their own keys.
  r = await request(P33, {
    path: '/admin/users', method: 'POST', headers: { Authorization: `Bearer ${ADMIN33}` },
    body: { username: 'erin', password: 'erinpass123', role: 'user' },
  });
  r = await request(P33, { path: '/auth/login', method: 'POST', body: { username: 'erin', password: 'erinpass123' } });
  const erinCookie = String(r.headers['set-cookie'] || '').split(';')[0];
  r = await request(P33, { path: '/me/usage.csv', headers: { Cookie: erinCookie } });
  assert(r.status === 200 && /text\/csv/.test(String(r.headers['content-type'])), '/me/usage.csv works for a signed-in user');

  // Rate-limit headers: an rpm-limited key gets OpenAI-style headers so SDKs
  // can back off before the hard 429.
  r = await request(P33, {
    path: '/admin/keys', method: 'POST', headers: { Authorization: `Bearer ${ADMIN33}` },
    body: { name: 'rpm-key', role: 'app', limits: { rpm: 5 } },
  });
  const rpmKey = JSON.parse(r.body).key;
  r = await request(P33, {
    path: '/v1/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${rpmKey}`, 'X-App-Id': 'hdr-test' },
    body: { model: 'bridge-claude-haiku-4.5-spark', messages: [{ role: 'user', content: 'x' }] },
  });
  assert(r.status === 200 && r.headers['x-ratelimit-limit-requests'] === '5' && r.headers['x-ratelimit-remaining-requests'] === '4',
    `rate-limit headers reflect the rpm budget (got limit=${r.headers['x-ratelimit-limit-requests']}, remaining=${r.headers['x-ratelimit-remaining-requests']})`);
  assert(/^\d+s$/.test(String(r.headers['x-ratelimit-reset-requests'])), 'reset header is a seconds value');

  // OpenAI `user` field attributes usage when no X-App-Id header is sent.
  await request(P33, {
    path: '/v1/chat/completions', method: 'POST', headers: { Authorization: `Bearer ${ADMIN33}` },
    body: { model: 'bridge-claude-haiku-4.5-spark', user: 'agent-smith', messages: [{ role: 'user', content: 'x' }] },
  });
  await new Promise((res) => setTimeout(res, 150));
  r = await request(P33, { path: '/dashboard/usage?range=today', headers: { Authorization: `Bearer ${ADMIN33}` } });
  assert(((JSON.parse(r.body).perApp) || []).some((a) => a.appId === 'agent-smith'),
    'the OpenAI user field is used for app attribution when X-App-Id is absent');

  // ── max_tokens + stop sequences, end-to-end (chat completions) ──────────
  console.log('\n## max_tokens + stop honored end-to-end');
  const P34 = 19730;
  const SHAPE_TXT = 'alpha keep STOPHERE beta gamma delta';
  const CLAUDE_SHAPE = writeStub('claude-shape.sh', 'claude-sim', { FAKE_CLI_TEXT: SHAPE_TXT });
  const CLAUDE_LONG = writeStub('claude-long.sh', 'claude-sim', { FAKE_CLI_TEXT: 'w'.repeat(400) });
  await bootProvider(P34, { CLAUDE_PATH: CLAUDE_SHAPE, GEMINI_PATH: AGY_STUB, BRIDGE_ROUTES_FILE: (() => {
    const f = path.join(TMP, 'routes-34.json');
    const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'packages', 'provider', 'routes.json'), 'utf8'));
    for (const rt of doc.routes) { delete rt.overflowFallback; delete rt.quotaFallback; }
    fs.writeFileSync(f, JSON.stringify(doc));
    return f;
  })() });

  // Non-streaming: a stop sequence truncates and is removed; finish 'stop'.
  r = await request(P34, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-claude-haiku-4.5-spark', stop: 'STOPHERE', messages: [{ role: 'user', content: 'x' }] },
  });
  {
    const c = JSON.parse(r.body);
    assert(r.status === 200 && c.choices[0].message.content === 'alpha keep ' && c.choices[0].finish_reason === 'stop',
      `stop truncates the reply and sets finish_reason stop (got ${JSON.stringify(c.choices[0].message.content)})`);
    assert(!(c.bridge_ignored_params || []).includes('stop'), 'stop is no longer reported as ignored');
  }
  // Non-streaming: max_tokens caps length; finish_reason 'length'.
  await request(P34, { path: '/admin/breakers/claude/reset', method: 'POST' }).catch(() => {});
  await bootProvider(P34 + 1, { CLAUDE_PATH: CLAUDE_LONG, GEMINI_PATH: AGY_STUB, BRIDGE_ROUTES_FILE: (() => {
    const f = path.join(TMP, 'routes-34b.json');
    const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'packages', 'provider', 'routes.json'), 'utf8'));
    for (const rt of doc.routes) { delete rt.overflowFallback; delete rt.quotaFallback; }
    fs.writeFileSync(f, JSON.stringify(doc));
    return f;
  })() });
  r = await request(P34 + 1, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-claude-haiku-4.5-spark', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] },
  });
  {
    const c = JSON.parse(r.body);
    assert(r.status === 200 && c.choices[0].message.content.length === 20 && c.choices[0].finish_reason === 'length',
      `max_tokens caps to ~5 tokens (20 chars) with finish_reason length (got len ${c.choices[0].message.content.length})`);
  }
  // Streaming: the stop sequence truncates the streamed content too.
  r = await request(P34, {
    path: '/v1/chat/completions', method: 'POST',
    body: { model: 'bridge-claude-haiku-4.5-spark', stop: 'STOPHERE', stream: true, messages: [{ role: 'user', content: 'x' }] },
  });
  {
    const chunks = parseSse(r.body);
    const text = chunks.map((c) => (c.choices && c.choices[0] && c.choices[0].delta && c.choices[0].delta.content) || '').join('');
    const finish = chunks.map((c) => c.choices && c.choices[0] && c.choices[0].finish_reason).filter(Boolean).pop();
    assert(text === 'alpha keep ' && finish === 'stop', `streaming honors stop (got ${JSON.stringify(text)}, finish ${finish})`);
    assert(!text.includes('STOPHERE'), 'the stop sequence itself never streams to the client');
  }

  // ── /v1/completions (legacy) + /v1/messages (Anthropic) shims ───────────
  console.log('\n## /v1/completions + /v1/messages compatibility endpoints');
  const noFallbackRoutes = (name) => {
    const f = path.join(TMP, name);
    const doc = JSON.parse(fs.readFileSync(path.join(REPO, 'packages', 'provider', 'routes.json'), 'utf8'));
    for (const rt of doc.routes) { delete rt.overflowFallback; delete rt.quotaFallback; }
    fs.writeFileSync(f, JSON.stringify(doc));
    return f;
  };
  const P35 = 19740;
  const CLAUDE_C = writeStub('claude-compat.sh', 'claude-sim', { FAKE_CLI_TEXT: 'Hello there, general.' });
  await bootProvider(P35, { CLAUDE_PATH: CLAUDE_C, GEMINI_PATH: AGY_STUB, BRIDGE_ROUTES_FILE: noFallbackRoutes('routes-35.json') });

  // Legacy text completions.
  r = await request(P35, {
    path: '/v1/completions', method: 'POST',
    body: { model: 'bridge-claude-haiku-4.5-spark', prompt: 'say hi' },
  });
  {
    const c = JSON.parse(r.body);
    assert(r.status === 200 && c.object === 'text_completion' && c.id.startsWith('cmpl-'), '/v1/completions returns a text_completion object');
    assert(c.choices[0].text === 'Hello there, general.' && c.choices[0].finish_reason === 'stop' && c.choices[0].logprobs === null,
      'text_completion choice carries text + finish_reason + logprobs:null');
    assert(c.usage && typeof c.usage.total_tokens === 'number', 'text_completion carries usage');
  }
  r = await request(P35, { path: '/v1/completions', method: 'POST', body: { model: 'bridge-claude-haiku-4.5-spark' } });
  assert(r.status === 400, '/v1/completions requires a prompt');
  r = await request(P35, { path: '/v1/completions', method: 'POST', body: { model: 'bridge-claude-haiku-4.5-spark', prompt: 'x', best_of: 3 } });
  assert(r.status === 400 && errType(r) === 'unsupported_parameter', 'best_of != 1 rejected');
  r = await request(P35, {
    path: '/v1/completions', method: 'POST',
    body: { model: 'bridge-claude-haiku-4.5-spark', prompt: 'x', stop: 'there' },
  });
  assert(JSON.parse(r.body).choices[0].text === 'Hello ', '/v1/completions honors stop (truncates before "there")');
  r = await request(P35, {
    path: '/v1/completions', method: 'POST',
    body: { model: 'bridge-claude-haiku-4.5-spark', prompt: 'x', stream: true },
  });
  {
    const chunks = parseSse(r.body);
    assert(chunks.length > 0 && chunks.every((c) => c.object === 'text_completion'), 'streamed completions are text_completion chunks');
    const text = chunks.map((c) => (c.choices[0] && c.choices[0].text) || '').join('');
    assert(text === 'Hello there, general.' && /\[DONE\]/.test(r.body), 'streamed text reassembles and ends with [DONE]');
  }

  // Anthropic messages.
  r = await request(P35, {
    path: '/v1/messages', method: 'POST',
    body: { model: 'bridge-claude-haiku-4.5-spark', max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] },
  });
  {
    const m = JSON.parse(r.body);
    assert(r.status === 200 && m.type === 'message' && m.role === 'assistant' && m.id.startsWith('msg_'), '/v1/messages returns an Anthropic message');
    assert(Array.isArray(m.content) && m.content[0].type === 'text' && m.content[0].text === 'Hello there, general.', 'message content is a text block');
    assert(m.stop_reason === 'end_turn' && m.usage && typeof m.usage.output_tokens === 'number', 'message carries stop_reason + usage');
  }
  // system + content-block input, and Anthropic max_tokens → stop_reason max_tokens.
  r = await request(P35, {
    path: '/v1/messages', method: 'POST',
    body: { model: 'bridge-claude-haiku-4.5-spark', max_tokens: 2, system: 'be terse', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
  });
  {
    const m = JSON.parse(r.body);
    assert(r.status === 200 && m.stop_reason === 'max_tokens' && m.content[0].text.length === 8, 'Anthropic max_tokens caps output and maps stop_reason to max_tokens');
  }
  // Streaming: the Anthropic event sequence.
  r = await request(P35, {
    path: '/v1/messages', method: 'POST',
    body: { model: 'bridge-claude-haiku-4.5-spark', max_tokens: 1024, stream: true, messages: [{ role: 'user', content: 'hi' }] },
  });
  {
    const events = (r.body || '').split('\n\n').filter((b) => b.startsWith('event: ')).map((b) => b.slice(7).split('\n')[0]);
    assert(events[0] === 'message_start' && events.includes('content_block_delta') && events[events.length - 1] === 'message_stop',
      `Anthropic stream runs message_start → … → message_stop (got ${events.join(',')})`);
    const deltas = (r.body || '').split('\n\n').filter((b) => b.includes('content_block_delta'))
      .map((b) => { try { return JSON.parse(b.split('\ndata: ')[1]); } catch (_) { return null; } }).filter(Boolean);
    assert(deltas.map((d) => d.delta.text).join('') === 'Hello there, general.', 'streamed text_delta blocks reassemble the reply');
  }

  // x-api-key auth (Anthropic clients) works when auth is enabled.
  const P35b = 19745;
  const CREDS35 = path.join(TMP, 'creds35.json');
  const ADMIN35 = '3'.repeat(48);
  fs.writeFileSync(CREDS35, JSON.stringify({ version: 3, keys: [{ name: 'admin', role: 'admin', keyHash: sha256(ADMIN35), createdAt: '2026-01-01T00:00:00Z' }] }));
  await bootProvider(P35b, { CLAUDE_PATH: CLAUDE_C, GEMINI_PATH: AGY_STUB, BRIDGE_CREDENTIALS_FILE: CREDS35, BRIDGE_ROUTES_FILE: noFallbackRoutes('routes-35b.json') });
  r = await request(P35b, {
    path: '/v1/messages', method: 'POST', headers: { 'x-api-key': ADMIN35 },
    body: { model: 'bridge-claude-haiku-4.5-spark', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
  });
  assert(r.status === 200 && JSON.parse(r.body).type === 'message', 'x-api-key authorizes /v1/messages');
  r = await request(P35b, {
    path: '/v1/messages', method: 'POST',
    body: { model: 'bridge-claude-haiku-4.5-spark', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] },
  });
  {
    const m = JSON.parse(r.body);
    assert(r.status === 401 && m.type === 'error', 'unauthenticated /v1/messages → Anthropic-shaped 401 error');
  }

  console.log(`\n# Result: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
