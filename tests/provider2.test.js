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
  // Never let test traffic pollute the real usage ledger or routes.json, and
  // never read/migrate the real credentials.json — each boot gets its own file
  // (absent unless the test writes one, so auth is open by default as before).
  process.env.BRIDGE_USAGE_DIR = path.join(TMP, `usage-${port}`);
  const routesCopy = path.join(TMP, `routes-${port}.json`);
  fs.copyFileSync(path.join(REPO, 'packages', 'provider', 'routes.json'), routesCopy);
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
  assert(r.status === 200 && /^[0-9a-f]{48}$/.test(minted.key), 'mint returns a 48-hex secret once');
  r = await chat18(minted.key, 'bridge-claude-haiku-4.5-spark');
  assert(r.status === 200, 'freshly minted key authorizes /v1');
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

  // v1 → v2 migration on a real boot: legacy file still authorizes, file upgraded.
  console.log('\n## Credentials v1 → v2 migration');
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
    assert(onDisk.version === 2 && onDisk.keys[0].key === LEGACY && onDisk.keys[0].role === 'admin',
      'v1 file migrated to v2 in place, key value preserved as admin');
  }

  console.log(`\n# Result: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
