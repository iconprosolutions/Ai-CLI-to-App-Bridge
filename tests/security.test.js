// Standalone verification of the security/reliability hardening on both bridges.
// No external test deps — uses only Node core http. Run: node tests/security.test.js
//
// This loads the REAL server.js of each bridge in-process, pointing them at an
// isolated temp contexts dir and (by default) a CLI path of `false` so no real
// claude/gemini binary is ever spawned. For the timeout and output-cap checks we
// point the bridge at a tiny shell stub instead, so those behaviors are exercised
// deterministically without touching the network or a real model.
//
// Only claude-bridge has node_modules installed; gemini-bridge shares the same
// two deps (express, cors). We add claude-bridge/node_modules to the module
// search path so the gemini bridge loads in-process too — no separate install.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

// Make both bridges' deps resolvable from anywhere before we require them.
process.env.NODE_PATH = [
  path.join(REPO, 'claude-bridge', 'node_modules'),
  process.env.NODE_PATH || '',
].filter(Boolean).join(path.delimiter);
require('module').Module._initPaths();

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-sec-'));

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

// Make an HTTP request against a running server; returns {status, body, headers}.
function request(port, opts) {
  return new Promise((resolve) => {
    const headers = opts.headers || {};
    const body = opts.body ? JSON.stringify(opts.body) : null;
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

// Write a tiny executable CLI stub. It answers `--version` instantly (so the
// startup version probe doesn't block) and runs `bodyLine` for any real call.
function writeFakeCli(name, bodyLine) {
  const p = path.join(TMP, name);
  fs.writeFileSync(
    p,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fake-cli 0.0.0"; exit 0; fi\n${bodyLine}\n`,
    { mode: 0o755 },
  );
  fs.chmodSync(p, 0o755);
  return p;
}

const SLEEP_CLI = writeFakeCli('sleep-cli.sh', 'exec sleep 30');
const BIG_CLI = writeFakeCli('big-cli.sh', 'yes 0123456789ABCDEF | head -c 500000');
const STDOUT_ERROR_CLI = writeFakeCli('stdout-error-cli.sh', 'echo "session limit resets soon"; exit 1');
// Echoes stdin back — proves the prompt arrives via stdin, not argv.
const STDIN_ECHO_CLI = writeFakeCli('stdin-echo-cli.sh', 'cat -');

// Load a bridge module into a unique PORT/contexts dir. We re-require a fresh
// copy by clearing the cache and monkeypatching env. The module captures its
// config (PORT, CLI paths, timeouts, CORS, API key) at require time, so the env
// restore afterwards does not affect the already-started server.
async function bootBridge(serverPath, port, env) {
  const modPath = require.resolve(serverPath);
  delete require.cache[modPath];
  const oldEnv = { ...process.env };
  process.env.PORT = String(port);
  process.env.CONTEXTS_DIR = TMP;
  process.env.CLAUDE_PATH = 'false'; // never spawn a real CLI unless overridden
  process.env.GEMINI_PATH = 'false';
  Object.assign(process.env, env);
  require(serverPath); // starts listening on port via app.listen
  process.env = oldEnv; // restore for the rest of the process
  await new Promise((r) => setTimeout(r, 100)); // let app.listen bind
}

const BRIDGES = [
  { name: 'claude', server: path.join(REPO, 'claude-bridge', 'server.js'), pathEnv: 'CLAUDE_PATH', base: 19100 },
  { name: 'gemini', server: path.join(REPO, 'gemini-bridge', 'server.js'), pathEnv: 'GEMINI_PATH', base: 19200 },
];

async function testBridge(b) {
  const base = b.base;
  console.log(`\n=== ${b.name}-bridge ===`);

  // ── Open dev mode (no key) ─────────────────────────────────────────────
  await bootBridge(b.server, base, { BRIDGE_API_KEY: '' });

  let r = await request(base, { path: '/health' });
  let health = JSON.parse(r.body || '{}');
  assert(r.status === 200, `[${b.name}] /health reachable (open mode)`);
  assert(typeof health.contextsDir === 'string', `[${b.name}] /health exposes contextsDir in open dev mode`);

  r = await request(base, { path: '/models' });
  assert(r.status === 200, `[${b.name}] /models reachable when no key set`);

  // Context type validation (PUT / append / list — not only GET)
  r = await request(base, { path: '/api/contexts/bogus/acme', method: 'PUT', body: { content: 'x' } });
  assert(r.status === 400 && (r.body || '').includes('Invalid type'), `[${b.name}] PUT rejects invalid context type`);
  r = await request(base, { path: '/api/contexts/bogus/acme/append', method: 'POST', body: { section: 'x' } });
  assert(r.status === 400 && (r.body || '').includes('Invalid type'), `[${b.name}] append rejects invalid context type`);
  r = await request(base, { path: '/api/contexts/bogus' });
  assert(r.status === 400 && (r.body || '').includes('Invalid type'), `[${b.name}] list rejects invalid context type`);
  r = await request(base, { path: '/api/contexts/clients' });
  assert(r.status === 200, `[${b.name}] list accepts a valid context type`);

  // Empty string allowed, missing field rejected
  r = await request(base, { path: '/api/contexts/clients/acme', method: 'PUT', body: { content: '' } });
  assert(r.status === 200, `[${b.name}] PUT accepts empty-string content`);
  r = await request(base, { path: '/api/contexts/clients/acme', method: 'PUT', body: {} });
  assert(r.status === 400, `[${b.name}] PUT rejects missing content`);
  r = await request(base, { path: '/api/contexts/clients/acme/append', method: 'POST', body: { section: '' } });
  assert(r.status === 200, `[${b.name}] append accepts empty-string section`);
  r = await request(base, { path: '/api/contexts/clients/acme/append', method: 'POST', body: {} });
  assert(r.status === 400, `[${b.name}] append rejects missing section`);

  // Path traversal still blocked, with a clean 400
  r = await request(base, {
    path: '/api/contexts/clients/..%2F..%2Fevil',
    method: 'PUT',
    body: { content: 'pwned' },
  });
  assert(r.status === 400 && (r.body || '').includes('Invalid slug'), `[${b.name}] traversal slug returns clean 400`);

  // ── Keyed mode: auth gate + no path leak in /health ────────────────────
  await bootBridge(b.server, base + 1, { BRIDGE_API_KEY: 'secret123' });

  r = await request(base + 1, { path: '/health' });
  health = JSON.parse(r.body || '{}');
  assert(r.status === 200, `[${b.name}] /health reachable with key set (Docker HEALTHCHECK)`);
  assert(health.contextsDir === undefined, `[${b.name}] /health hides contextsDir when auth enabled`);

  r = await request(base + 1, { path: '/models' });
  assert(r.status === 401, `[${b.name}] /models rejected without Authorization header`);
  r = await request(base + 1, { path: '/models', headers: { Authorization: 'Bearer wrong' } });
  assert(r.status === 401, `[${b.name}] /models rejected with wrong token`);
  r = await request(base + 1, { path: '/models', headers: { Authorization: 'Bearer secret123' } });
  assert(r.status === 200, `[${b.name}] /models accepted with correct Bearer token`);

  // ── CORS allowlist via env ─────────────────────────────────────────────
  await bootBridge(b.server, base + 2, { BRIDGE_API_KEY: '', CORS_ORIGINS: 'https://allowed.example' });

  r = await request(base + 2, { path: '/health', headers: { Origin: 'https://allowed.example' } });
  assert(r.headers['access-control-allow-origin'] === 'https://allowed.example', `[${b.name}] CORS reflects an allowlisted origin`);
  r = await request(base + 2, { path: '/health', headers: { Origin: 'https://evil.example' } });
  assert(!r.headers['access-control-allow-origin'], `[${b.name}] CORS withholds header for a disallowed origin`);

  // ── Explicit process timeout ───────────────────────────────────────────
  await bootBridge(b.server, base + 3, { BRIDGE_API_KEY: '', [b.pathEnv]: SLEEP_CLI, CLI_TIMEOUT_MS: '400' });

  const t0 = Date.now();
  r = await request(base + 3, { path: '/api/chat', method: 'POST', body: { prompt: 'hello' } });
  const elapsed = Date.now() - t0;
  assert(r.status === 500 && (r.body || '').toLowerCase().includes('timed out'), `[${b.name}] CLI timeout returns a clear error`);
  assert(elapsed < 5000, `[${b.name}] CLI timeout fires promptly (${elapsed}ms, limit 400ms)`);

  // ── Output size cap ────────────────────────────────────────────────────
  // The stub emits 500000 bytes; with a 2000-byte cap the returned buffer must
  // stay tight to the cap (not merely "under 500000"), proving chunks are sliced
  // rather than appended whole. trim() may shave a trailing whitespace char.
  const CAP = 2000;
  await bootBridge(b.server, base + 4, { BRIDGE_API_KEY: '', [b.pathEnv]: BIG_CLI, MAX_CLI_OUTPUT_BYTES: String(CAP) });

  r = await request(base + 4, { path: '/api/chat', method: 'POST', body: { prompt: 'hello' } });
  let parsed = {};
  try { parsed = JSON.parse(r.body || '{}'); } catch (_) { /* leave empty */ }
  assert(r.status === 200 && parsed.success === true, `[${b.name}] capped CLI output still returns success`);
  const len = typeof parsed.text === 'string' ? parsed.text.length : -1;
  assert(len > 0 && len <= CAP, `[${b.name}] CLI output never exceeds the cap (kept ${len}, cap ${CAP}, of 500000)`);
  assert(len >= CAP - 5, `[${b.name}] CLI output is filled to the cap, not cut short (kept ${len}, cap ${CAP})`);

  // Some CLIs print account/limit errors to stdout while still exiting nonzero.
  // Preserve that message so callers see the real cause instead of a generic
  // "request failed" wrapper.
  await bootBridge(b.server, base + 5, { BRIDGE_API_KEY: '', [b.pathEnv]: STDOUT_ERROR_CLI });
  r = await request(base + 5, { path: '/api/chat', method: 'POST', body: { prompt: 'hello' } });
  assert(r.status === 500 && (r.body || '').includes('session limit resets soon'),
    `[${b.name}] nonzero CLI stdout is preserved in error response`);
}

async function main() {
  console.log('# Bridge security & reliability hardening — verification');
  console.log(`  temp contexts dir: ${TMP}`);

  // Path-traversal slug regex unit check (mirrors the SLUG_RE in both bridges)
  const SLUG_RE = /^[A-Za-z0-9_-]+$/;
  console.log('\n## Path traversal — slug validation (shared regex)');
  assert(SLUG_RE.test('acme'), 'clean slug accepted');
  assert(!SLUG_RE.test('../../server'), '../../server rejected');
  assert(!SLUG_RE.test('..'), '.. rejected');
  assert(!SLUG_RE.test('a/b'), 'a/b rejected');
  assert(!SLUG_RE.test('a.b'), 'a.b rejected (no dots)');
  assert(SLUG_RE.test('acme-corp_uk'), 'hyphen+underscore slug accepted');

  for (const b of BRIDGES) {
    await testBridge(b);
  }

  console.log('\n## claude-bridge — prompt delivered via stdin');
  const claudeBridge = BRIDGES[0];
  await bootBridge(claudeBridge.server, 19150, { BRIDGE_API_KEY: '', CLAUDE_PATH: STDIN_ECHO_CLI });
  let sr = await request(19150, { path: '/api/chat', method: 'POST', body: { prompt: 'stdin-marker-123' } });
  let sp = {};
  try { sp = JSON.parse(sr.body || '{}'); } catch (_) {}
  assert(sr.status === 200 && typeof sp.text === 'string' && sp.text.includes('stdin-marker-123'),
    '[claude] prompt reaches the CLI via stdin');
  // A 2MB prompt exceeds ARG_MAX as argv but must work via stdin.
  const bigPrompt = 'x'.repeat(2 * 1024 * 1024);
  sr = await request(19150, { path: '/api/chat', method: 'POST', body: { prompt: bigPrompt } });
  try { sp = JSON.parse(sr.body || '{}'); } catch (_) { sp = {}; }
  assert(sr.status === 200 && sp.success === true && (sp.text || '').length >= 2 * 1024 * 1024,
    `[claude] 2MB prompt survives (argv would E2BIG) — got status ${sr.status}, len ${(sp.text || '').length}`);

  console.log('\n## gemini-bridge — oversized prompt rejected clearly (argv limit)');
  const geminiBridge = BRIDGES[1];
  await bootBridge(geminiBridge.server, 19151, { BRIDGE_API_KEY: '', GEMINI_PATH: STDIN_ECHO_CLI });
  sr = await request(19151, { path: '/api/chat', method: 'POST', body: { prompt: 'y'.repeat(300 * 1024) } });
  assert(sr.status === 413 && (sr.body || '').includes('too large'),
    `[gemini] 300KB prompt rejected 413 with clear message (got ${sr.status})`);
  sr = await request(19151, { path: '/api/chat', method: 'POST', body: { prompt: 'small is fine' } });
  assert(sr.status === 200, '[gemini] small prompt still works');

  console.log(`\n# Result: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
