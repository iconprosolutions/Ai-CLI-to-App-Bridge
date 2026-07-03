'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Named API keys, v2 credentials.json. One store owns the file: load,
// migrate v1 in place, verify (constant-time), mint, revoke, list. Same
// philosophy as routes.json / accounts.json — validate precisely, keep 0600.
//
// v2 shape:
//   { "version": 2, "keys": [
//       { "key": "<48 hex>", "name": "admin", "role": "admin", "createdAt": "…" },
//       { "key": "<48 hex>", "name": "hermes", "role": "app",
//         "accountPin": { "gemini": "main" }, "createdAt": "…" } ] }
//
// v1 shape (auto-migrated, key value preserved so existing callers keep working):
//   { "apiKey": "<hex>", "createdAt": "…" }

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const ROLES = new Set(['admin', 'app']);

function nowIso() {
  return new Date().toISOString();
}

function newSecret() {
  return crypto.randomBytes(24).toString('hex'); // 48 hex chars
}

function validateAccountPin(pin) {
  if (pin === undefined || pin === null) return undefined;
  if (typeof pin !== 'object' || Array.isArray(pin)) {
    throw new Error('accountPin must be an object of engine → account name');
  }
  for (const [engine, name] of Object.entries(pin)) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new Error(`accountPin.${engine} must be a simple account name`);
    }
  }
  return { ...pin };
}

function validateKeyRecord(k) {
  if (!k || typeof k.name !== 'string' || !NAME_RE.test(k.name)) {
    throw new Error(`credentials.json: every key needs a name matching ${NAME_RE}`);
  }
  if (!ROLES.has(k.role)) {
    throw new Error(`credentials.json: key "${k.name}" has an invalid role (expected admin|app)`);
  }
  if (typeof k.key !== 'string' || !k.key) {
    throw new Error(`credentials.json: key "${k.name}" is missing its secret`);
  }
  validateAccountPin(k.accountPin);
  return k;
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort on odd filesystems */ }
}

// Read the file, migrating a v1 payload to v2 (and persisting the migration).
// Absent file → an empty v2 doc that is NOT written (callers decide whether to
// bootstrap). Throws on a malformed v2 doc so a bad edit fails loud at boot.
function loadAndMigrate(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return { version: 2, keys: [] }; }

  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) { throw new Error(`credentials.json: invalid JSON (${err.message})`); }

  // v1 → v2 migration, preserving the existing key value.
  if (parsed && typeof parsed.apiKey === 'string' && parsed.version === undefined) {
    const migrated = {
      version: 2,
      keys: [{
        name: 'admin',
        role: 'admin',
        key: parsed.apiKey,
        createdAt: parsed.createdAt || nowIso(),
      }],
    };
    writeAtomic(file, migrated);
    return migrated;
  }

  if (!parsed || parsed.version !== 2 || !Array.isArray(parsed.keys)) {
    throw new Error('credentials.json: expected { version: 2, keys: [...] }');
  }
  const seen = new Set();
  for (const k of parsed.keys) {
    validateKeyRecord(k);
    if (seen.has(k.name)) throw new Error(`credentials.json: duplicate key name "${k.name}"`);
    seen.add(k.name);
  }
  return { version: 2, keys: parsed.keys };
}

function createKeyStore({ file, envKey = '' } = {}) {
  const data = loadAndMigrate(file);
  // The env-provided key (launcher / tests) is an ephemeral admin key: valid
  // for verification, never persisted, never listed.
  const envRecord = envKey ? { name: 'env', role: 'admin', key: String(envKey) } : null;

  const allRecords = () => (envRecord ? [envRecord, ...data.keys] : data.keys);

  function verify(token) {
    if (typeof token !== 'string' || !token) return null;
    const a = Buffer.from(token);
    let match = null;
    // Compare against every record (constant work per key) so a hit vs. miss
    // isn't distinguishable by timing.
    for (const rec of allRecords()) {
      const b = Buffer.from(rec.key);
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) match = rec;
    }
    if (!match) return null;
    return { name: match.name, role: match.role, accountPin: match.accountPin ? { ...match.accountPin } : undefined };
  }

  function list() {
    return data.keys
      .map((k) => ({ name: k.name, role: k.role, accountPin: k.accountPin ? { ...k.accountPin } : undefined, createdAt: k.createdAt }))
      .sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)));
  }

  function mint({ name, role = 'app', accountPin } = {}) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new Error(`Key name must match ${NAME_RE}`);
    }
    if (!ROLES.has(role)) throw new Error('Key role must be admin or app');
    if (name === 'env') throw new Error('Key name "env" is reserved');
    if (data.keys.some((k) => k.name === name)) throw new Error(`A key named "${name}" already exists`);
    const pin = validateAccountPin(accountPin);
    const rec = { name, role, key: newSecret(), createdAt: nowIso() };
    if (pin) rec.accountPin = pin;
    data.keys.push(rec);
    writeAtomic(file, { version: 2, keys: data.keys });
    return { ...rec };
  }

  function revoke(name) {
    const i = data.keys.findIndex((k) => k.name === name);
    if (i === -1) throw new Error(`Unknown key "${name}"`);
    const admins = data.keys.filter((k) => k.role === 'admin');
    if (data.keys[i].role === 'admin' && admins.length === 1) {
      throw new Error('Cannot revoke the last admin key — mint another admin first');
    }
    data.keys.splice(i, 1);
    writeAtomic(file, { version: 2, keys: data.keys });
    return true;
  }

  return {
    verify,
    list,
    mint,
    revoke,
    get authEnabled() { return data.keys.length > 0 || Boolean(envRecord); },
    file,
  };
}

// Launcher helper: ensure the file exists as v2 with at least one admin key.
// Returns the admin key value to display and whether it was created/migrated.
function bootstrapCredentialsFile(file) {
  const existedRaw = (() => { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; } })();
  const wasV1 = Boolean(existedRaw && (() => { try { const p = JSON.parse(existedRaw); return typeof p.apiKey === 'string' && p.version === undefined; } catch (_) { return false; } })());

  const data = loadAndMigrate(file); // migrates v1 in place if needed
  const existingAdmin = data.keys.find((k) => k.role === 'admin');
  if (existingAdmin) {
    return { adminKey: existingAdmin.key, created: false, migrated: wasV1 };
  }
  const rec = { name: 'admin', role: 'admin', key: newSecret(), createdAt: nowIso() };
  data.keys.push(rec);
  writeAtomic(file, { version: 2, keys: data.keys });
  return { adminKey: rec.key, created: existedRaw === null, migrated: wasV1 };
}

module.exports = { createKeyStore, loadAndMigrate, bootstrapCredentialsFile, validateAccountPin };
