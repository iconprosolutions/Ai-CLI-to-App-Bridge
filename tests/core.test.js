// Contract tests for @bridge/core. Run: node tests/core.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('../packages/core');

const FAKE_CLI = path.join(__dirname, 'fixtures', 'fake-cli.js');
const NODE = process.execPath;

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log(`  PASS  ${msg}`); }
  else { failed += 1; console.error(`  FAIL  ${msg}`); }
}

function fakeEnv(mode, extra = {}) {
  return { ...process.env, FAKE_CLI_MODE: mode, ...extra };
}

async function testErrors() {
  console.log('\n## errors — taxonomy + HTTP mapping');
  const { BridgeError, httpFor } = core;
  const q = new BridgeError('quota', 'capacity exhausted', { retryAfterSec: 120 });
  assert(q.kind === 'quota' && q.message === 'capacity exhausted', 'BridgeError carries kind + message');
  let threw = false;
  try { new BridgeError('nonsense', 'x'); } catch (e) { threw = e instanceof TypeError; }
  assert(threw, 'unknown kind throws TypeError');
  const qm = httpFor(q);
  assert(qm.status === 429 && qm.type === 'rate_limit_error' && qm.retryAfterSec === 120,
    'quota maps to 429 rate_limit_error with Retry-After');
  assert(httpFor(new BridgeError('timeout', 'x')).status === 504, 'timeout maps to 504');
  assert(httpFor(new BridgeError('model_not_found', 'x')).param === 'model', 'model_not_found sets param');
  assert(httpFor(new BridgeError('aborted', 'x')).status === 499, 'aborted maps to 499');
  assert(httpFor(new Error('plain')).status === 502, 'plain Error maps to 502 upstream_error');
}

async function testAnsi() {
  console.log('\n## ansi — stripping, streaming carry, CR collapse');
  const { stripAnsi, createAnsiStripper, collapseCarriageReturns } = core;
  assert(stripAnsi('\x1b[32mgreen\x1b[0m plain') === 'green plain', 'strips CSI color codes');
  assert(stripAnsi('\x1b]0;title\x07text') === 'text', 'strips BEL-terminated OSC');
  assert(stripAnsi('\x1b]0;title\x1b\\text') === 'text', 'strips ST-terminated OSC');

  const s = createAnsiStripper();
  const out = s.write('\x1b[32mgreen\x1b[') + s.write('0m done') + s.end();
  assert(out === 'green done', `split CSI across chunks removed (got ${JSON.stringify(out)})`);

  const s2 = createAnsiStripper();
  const out2 = s2.write('plain tail\x1b[3') + s2.end();
  assert(!out2.includes('\x1b'), 'dangling partial escape never emitted raw');

  assert(collapseCarriageReturns('spin1\rspin2\rdone\nnext') === 'done\nnext',
    'CR collapse keeps the final frame per line');
}

async function testJsonExtract() {
  console.log('\n## json-extract');
  const { extractJson, BridgeError } = core;
  assert(extractJson('```json\n{"a":1}\n```').a === 1, 'parses fenced JSON');
  assert(extractJson('Sure! Here you go: {"b":2} — enjoy').b === 2, 'parses JSON with preamble/postamble');
  assert(extractJson('\x1b[32m[1,2,3]\x1b[0m')[2] === 3, 'parses ANSI-wrapped arrays');
  let kind = null;
  try { extractJson('no json here at all'); } catch (e) { kind = e.kind; }
  assert(kind === 'bad_output', 'unparseable input throws BridgeError(bad_output)');
}

async function testJsonSchema() {
  console.log('\n## json-schema — minimal validator');
  const { validateJsonSchema, assertJsonSchema } = core;
  const schema = {
    type: 'object',
    required: ['name', 'count'],
    additionalProperties: false,
    properties: {
      name: { type: 'string' },
      count: { type: 'integer' },
      mood: { type: 'string', enum: ['happy', 'sad'] },
      tags: { type: 'array', items: { type: 'string' } },
    },
  };
  assert(validateJsonSchema({ name: 'a', count: 2, mood: 'happy', tags: ['x'] }, schema).length === 0, 'valid object passes');
  assert(validateJsonSchema({ name: 'a' }, schema).some((e) => e.includes('count')), 'missing required reported');
  assert(validateJsonSchema({ name: 'a', count: 'two' }, schema).some((e) => e.includes('expected integer')), 'wrong type reported');
  assert(validateJsonSchema({ name: 'a', count: 1, mood: 'angry' }, schema).some((e) => e.includes('enum')), 'enum violation reported');
  assert(validateJsonSchema({ name: 'a', count: 1, extra: true }, schema).some((e) => e.includes('unexpected property')), 'additionalProperties=false enforced');
  assert(validateJsonSchema({ name: 'a', count: 1, tags: ['x', 5] }, schema).some((e) => e.includes('[1]')), 'bad array item reported with index');
  let kind = null;
  try { assertJsonSchema({ name: 'a' }, schema); } catch (e) { kind = e.kind; }
  assert(kind === 'bad_output', 'assertJsonSchema throws BridgeError(bad_output)');
}

async function testCliRunner() {
  console.log('\n## cli-runner — the process sandbox');
  const { runCli, liveChildren, BridgeError } = core;

  // stdin round-trip with a 2MB payload (argv would E2BIG).
  const big = 'z'.repeat(2 * 1024 * 1024);
  const echo = await runCli(NODE, [FAKE_CLI], { stdin: big, env: fakeEnv('echo-stdin'), timeoutMs: 30000 });
  assert(echo.text.length === big.length && echo.exitCode === 0, `2MB stdin round-trips (${echo.text.length} bytes)`);

  // UTF-8 split across writes decodes cleanly in deltas.
  let deltas = '';
  await runCli(NODE, [FAKE_CLI], { env: fakeEnv('utf8-split'), onDelta: (d) => { deltas += d; }, timeoutMs: 15000 });
  assert(deltas.includes('😀') && !deltas.includes('�'), 'split multibyte char decodes cleanly in deltas');

  // Byte cap → truncated resolve, child killed.
  const flood = await runCli(NODE, [FAKE_CLI], {
    env: fakeEnv('flood', { FAKE_CLI_BYTES: '500000' }), maxBytes: 10000, timeoutMs: 30000,
  });
  assert(flood.truncated === true && flood.text.length <= 10000 && flood.text.length >= 9000,
    `flood truncated at cap (kept ${flood.text.length})`);

  // Timeout rejects with kind=timeout, promptly.
  let t0 = Date.now();
  let kind = null;
  try {
    await runCli(NODE, [FAKE_CLI], { env: fakeEnv('hang'), timeoutMs: 400 });
  } catch (e) { kind = e.kind; }
  assert(kind === 'timeout' && Date.now() - t0 < 5000, 'hang rejects timeout promptly');

  // AbortSignal kills the child and rejects kind=aborted.
  const ac = new AbortController();
  const run = runCli(NODE, [FAKE_CLI], { env: fakeEnv('hang'), signal: ac.signal, timeoutMs: 60000 });
  setTimeout(() => ac.abort(), 150);
  kind = null;
  try { await run; } catch (e) { kind = e.kind; }
  assert(kind === 'aborted', 'abort rejects with kind=aborted');

  // classifyError refines nonzero exits.
  kind = null;
  let msg = '';
  try {
    await runCli(NODE, [FAKE_CLI], {
      env: fakeEnv('stderr-fail', { FAKE_CLI_STDERR: 'You have exhausted your capacity' }),
      timeoutMs: 15000,
      classifyError: (stderr) => (stderr.includes('exhausted')
        ? new BridgeError('quota', 'engine quota exhausted') : null),
    });
  } catch (e) { kind = e.kind; msg = e.message; }
  assert(kind === 'quota' && msg === 'engine quota exhausted', 'classifyError refines to quota');

  // Unclassified nonzero exit → bad_output carrying stderr.
  kind = null;
  let stderrText = '';
  try {
    await runCli(NODE, [FAKE_CLI], { env: fakeEnv('stderr-fail', { FAKE_CLI_STDERR: 'boom' }), timeoutMs: 15000 });
  } catch (e) { kind = e.kind; stderrText = e.stderr; }
  assert(kind === 'bad_output' && stderrText.includes('boom'), 'unclassified failure keeps stderr detail');

  // Missing binary → spawn_failed.
  kind = null;
  try { await runCli('/nonexistent/bin-xyz', [], { timeoutMs: 5000 }); } catch (e) { kind = e.kind; }
  assert(kind === 'spawn_failed', 'missing binary rejects spawn_failed');

  // Registry drains back to zero.
  await new Promise((r) => setTimeout(r, 300));
  assert(liveChildren() === 0, `child registry drains to 0 (got ${liveChildren()})`);
}

async function testAuthSessionsConfig() {
  console.log('\n## auth / sessions / config');
  const { bearerAuth, SessionRegistry, intEnv } = core;

  // auth middleware — drive it directly with stub req/res.
  const mw = bearerAuth('sekrit');
  const call = (headers, pathName = '/x') => new Promise((resolve) => {
    const req = { headers, path: pathName };
    const res = { status(c) { this.code = c; return this; }, json() { resolve({ code: this.code }); } };
    mw(req, res, () => resolve({ code: 200 }));
  });
  assert((await call({})).code === 401, 'auth rejects missing token');
  assert((await call({ authorization: 'Bearer wrong' })).code === 401, 'auth rejects wrong token');
  assert((await call({ authorization: 'Bearer sekrit' })).code === 200, 'auth passes correct token');
  assert((await call({}, '/health')).code === 200, 'auth exempts public paths');
  const open = bearerAuth('');
  assert((await new Promise((resolve) => open({ headers: {}, path: '/x' }, {}, () => resolve({ code: 200 })))).code === 200,
    'empty key = open mode');

  // sessions — eviction + TTL sweep.
  const reg = new SessionRegistry({ ttlMs: 50, maxEntries: 3 });
  for (let i = 0; i < 5; i += 1) reg.getOrCreate(`app-${i}`);
  assert(reg.size === 3, `registry evicts beyond maxEntries (size ${reg.size})`);
  await new Promise((r) => setTimeout(r, 80));
  reg.sweep();
  assert(reg.size === 0, 'TTL sweep clears idle sessions');

  // config.
  process.env.__CORE_TEST_INT = '42';
  assert(intEnv('__CORE_TEST_INT', 7) === 42 && intEnv('__CORE_TEST_MISSING', 7) === 7, 'intEnv parses and falls back');
  delete process.env.__CORE_TEST_INT;
}

async function testContextStore() {
  console.log('\n## context-store — async CRUD + write locks');
  const { ContextStore } = core;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-ctx-'));
  const store = new ContextStore(dir);

  await store.write('clients', 'acme', 'hello');
  assert((await store.read('clients', 'acme')) === 'hello', 'write/read round-trip');
  assert((await store.read('clients', 'nope')) === null, 'missing file reads null');

  let threw = false;
  try { store.resolvePath('clients', '../evil'); } catch (_) { threw = true; }
  assert(threw, 'traversal slug throws');
  threw = false;
  try { store.resolvePath('bogus', 'acme'); } catch (_) { threw = true; }
  assert(threw, 'invalid type throws');

  // The race the legacy bridges lose: 10 parallel appends must all land.
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.append('clients', 'acme', `section-${i}`)));
  const content = await store.read('clients', 'acme');
  const landed = Array.from({ length: 10 }, (_, i) => content.includes(`section-${i}`)).filter(Boolean).length;
  assert(landed === 10, `all 10 concurrent appends landed (got ${landed})`);

  const files = await store.list('clients');
  assert(files.length === 1 && files[0].slug === 'acme' && files[0].size > 0, 'list returns slug + size');
  assert((await store.remove('clients', 'acme')) === true, 'remove deletes');
}

async function main() {
  console.log('# @bridge/core — contract verification');
  await testErrors();
  await testAnsi();
  await testJsonExtract();
  await testJsonSchema();
  await testCliRunner();
  await testAuthSessionsConfig();
  await testContextStore();
  console.log(`\n# Result: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
