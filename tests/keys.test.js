// Unit tests for the named-API-key store (packages/provider/keys.js).
// v1/v2→v3 migration (hashed at rest), multi-key verify, mint/revoke/list,
// roles, account pins. Run: node tests/keys.test.js — no network, no quota.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createKeyStore, loadAndMigrate, bootstrapCredentialsFile } = require('../packages/provider/keys');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log(`  PASS  ${msg}`); }
  else { failed += 1; console.error(`  FAIL  ${msg}`); }
}
function throws(fn, re, msg) {
  try { fn(); failed += 1; console.error(`  FAIL  ${msg} (no throw)`); }
  catch (e) {
    if (!re || re.test(e.message)) { passed += 1; console.log(`  PASS  ${msg}`); }
    else { failed += 1; console.error(`  FAIL  ${msg} (wrong error: ${e.message})`); }
  }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keys-'));
const HEX48 = /^[0-9a-f]{48}$/;

function run() {
  // (1) v1 → v3 migration in place: key VALUE keeps verifying, storage is
  // hashed, 0600.
  {
    const dir = tmp();
    const file = path.join(dir, 'credentials.json');
    fs.writeFileSync(file, JSON.stringify({ apiKey: 'deadbeef', createdAt: '2026-01-01T00:00:00Z' }));
    const store = createKeyStore({ file });
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(onDisk.version === 3 && Array.isArray(onDisk.keys), 'v1 file rewritten to version:3');
    assert(onDisk.keys.length === 1 && onDisk.keys[0].keyHash === sha256('deadbeef'), 'migration stores sha256(key), not the key');
    assert(!('key' in onDisk.keys[0]) && !fs.readFileSync(file, 'utf8').includes('deadbeef'), 'no plaintext secret remains on disk');
    assert(onDisk.keys[0].name === 'admin' && onDisk.keys[0].role === 'admin', 'migrated key is the admin key');
    const who = store.verify('deadbeef');
    assert(who && who.name === 'admin' && who.role === 'admin', 'migrated key still verifies as admin');
    if (process.platform !== 'win32') {
      assert((fs.statSync(file).mode & 0o777) === 0o600, 'migrated file is 0600');
    }
  }

  // (2) v2 verify: known → identity, unknown/short → null (no throw).
  {
    const dir = tmp();
    const file = path.join(dir, 'credentials.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 2,
      keys: [
        { name: 'admin', role: 'admin', key: 'a'.repeat(48), createdAt: '2026-01-01T00:00:00Z' },
        { name: 'hermes', role: 'app', key: 'b'.repeat(48), accountPin: { gemini: 'main' }, createdAt: '2026-01-02T00:00:00Z' },
      ],
    }));
    const store = createKeyStore({ file });
    const admin = store.verify('a'.repeat(48));
    assert(admin && admin.name === 'admin' && admin.role === 'admin', 'v2 admin key verifies');
    const app = store.verify('b'.repeat(48));
    assert(app && app.role === 'app' && app.accountPin.gemini === 'main', 'v2 app key carries its accountPin');
    assert(store.verify('c'.repeat(48)) === null, 'unknown token → null');
    assert(store.verify('short') === null, 'wrong-length token → null (no throw)');
    assert(store.authEnabled === true, 'authEnabled true when keys exist');
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert(onDisk.version === 3 && onDisk.keys.every((k) => k.keyHash && !('key' in k)),
      'v2 file migrated to v3 — plaintext secrets hashed in place');
  }

  // (3) env key with no file → implicit admin.
  {
    const dir = tmp();
    const file = path.join(dir, 'credentials.json');
    const store = createKeyStore({ file, envKey: 'k' });
    const who = store.verify('k');
    assert(who && who.name === 'env' && who.role === 'admin', 'env key verifies as implicit admin');
    assert(store.authEnabled === true, 'authEnabled true with env key and no file');
    assert(!fs.existsSync(file), 'env key alone writes no credentials file');
    assert(store.list().length === 0, 'env key is never listed');
  }

  // (4) open mode: no file, no env.
  {
    const dir = tmp();
    const store = createKeyStore({ file: path.join(dir, 'credentials.json') });
    assert(store.authEnabled === false, 'authEnabled false with no file and no env key');
    assert(store.verify('anything') === null, 'verify returns null in open mode');
  }

  // (5) mint: secret shape, persistence, validation.
  {
    const dir = tmp();
    const file = path.join(dir, 'credentials.json');
    fs.writeFileSync(file, JSON.stringify({ apiKey: 'admin-key-value' }));
    const store = createKeyStore({ file });
    const rec = store.mint({ name: 'hermes', role: 'app', accountPin: { gemini: 'main' } });
    assert(/^sk-bridge-[0-9a-f]{48}$/.test(rec.key), 'mint returns an sk-bridge-prefixed 48-hex secret');
    assert(rec.name === 'hermes' && rec.role === 'app', 'mint echoes name/role');
    assert(!fs.readFileSync(file, 'utf8').includes(rec.key.slice('sk-bridge-'.length)),
      'the minted secret never lands on disk (hash only)');
    const reloaded = createKeyStore({ file });
    assert(reloaded.verify(rec.key) && reloaded.verify(rec.key).role === 'app', 'minted key persists and verifies after reload');
    const listed = store.list();
    assert(listed.every((k) => !('key' in k)), 'list() never exposes secret values');
    assert(listed.find((k) => k.name === 'hermes').accountPin.gemini === 'main', 'list() carries accountPin');
    throws(() => store.mint({ name: 'hermes', role: 'app' }), /exists/, 'duplicate name rejected');
    throws(() => store.mint({ name: 'x', role: 'superuser' }), /role/, 'bad role rejected');
    throws(() => store.mint({ name: 'a b!', role: 'app' }), /name/, 'bad name characters rejected');
    throws(() => store.mint({ name: 'y', role: 'app', accountPin: { gemini: 'bad name!' } }), /accountPin/, 'bad accountPin rejected');
  }

  // (6) revoke: removal, guards.
  {
    const dir = tmp();
    const file = path.join(dir, 'credentials.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 2,
      keys: [
        { name: 'admin', role: 'admin', key: 'a'.repeat(48), createdAt: '2026-01-01T00:00:00Z' },
        { name: 'app1', role: 'app', key: 'b'.repeat(48), createdAt: '2026-01-02T00:00:00Z' },
      ],
    }));
    const store = createKeyStore({ file });
    store.revoke('app1');
    assert(store.verify('b'.repeat(48)) === null, 'revoked key no longer verifies');
    throws(() => store.revoke('nope'), /unknown/i, 'revoking unknown key rejected');
    throws(() => store.revoke('admin'), /last admin/i, 'revoking the last admin key rejected');
  }

  // (7) list shape sorted by createdAt, no secrets.
  {
    const dir = tmp();
    const file = path.join(dir, 'credentials.json');
    fs.writeFileSync(file, JSON.stringify({
      version: 2,
      keys: [
        { name: 'admin', role: 'admin', key: 'a'.repeat(48), createdAt: '2026-01-02T00:00:00Z' },
        { name: 'early', role: 'app', key: 'b'.repeat(48), createdAt: '2026-01-01T00:00:00Z' },
      ],
    }));
    const list = createKeyStore({ file }).list();
    assert(list[0].name === 'early', 'list sorted by createdAt ascending');
    assert(list.every((k) => k.name && k.role && k.createdAt && !('key' in k)), 'list rows carry name/role/createdAt only');
  }

  // (8) loadAndMigrate + bootstrapCredentialsFile helpers.
  {
    const dir = tmp();
    const file = path.join(dir, 'credentials.json');
    const boot = bootstrapCredentialsFile(file);
    assert(/^sk-bridge-[0-9a-f]{48}$/.test(boot.adminKey) && boot.created === true,
      'bootstrap creates a fresh admin key when absent (shown once, prefixed)');
    const data = loadAndMigrate(file);
    assert(data.version === 3 && data.keys.some((k) => k.role === 'admin'), 'bootstrapped file loads as v3 with an admin key');
    assert(createKeyStore({ file }).verify(boot.adminKey), 'the created admin key verifies');
    // Hashed at rest: a second bootstrap cannot (and does not) reveal the key.
    const boot2 = bootstrapCredentialsFile(file);
    assert(boot2.created === false && boot2.adminKey === null, 'bootstrap is idempotent and never re-reveals the key');
  }

  console.log(`\n# Result: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

run();
