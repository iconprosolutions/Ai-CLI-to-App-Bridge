'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Named API keys, v3 credentials.json. One store owns the file: load,
// migrate v1/v2 in place, verify (constant-time), mint, revoke, list. Same
// philosophy as routes.json / accounts.json — validate precisely, keep 0600.
//
// v3 shape — secrets are hashed at rest (sha256 of the bare token), so a
// leaked credentials.json / backup exposes no usable keys. A secret is only
// known at mint time; it can never be re-displayed, only rotated.
//   { "version": 3, "keys": [
//       { "keyHash": "<64 hex>", "name": "admin", "role": "admin", "createdAt": "…" },
//       { "keyHash": "<64 hex>", "name": "hermes", "role": "app",
//         "accountPin": { "gemini": "main" }, "createdAt": "…" } ] }
//
// Auto-migrated legacy shapes (key VALUES keep verifying — only their storage
// changes):
//   v2: { "version": 2, "keys": [{ "key": "<48 hex>", ... }] }
//   v1: { "apiKey": "<hex>", "createdAt": "…" }

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const ROLES = new Set(['admin', 'app']);
const HASH_RE = /^[0-9a-f]{64}$/;

function nowIso() {
  return new Date().toISOString();
}

function newSecret() {
  return crypto.randomBytes(24).toString('hex'); // 48 hex chars
}

function hashSecret(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex');
}

// Keys are presented OpenRouter/OpenAI-style as "sk-bridge-<secret>" so they
// read as API keys in any tool. Stored and verified as the bare secret — the
// prefix is optional on the wire, so pre-prefix keys keep working.
const KEY_PREFIX = 'sk-bridge-';
function presentKey(secret) { return KEY_PREFIX + secret; }
function bareToken(token) {
  return String(token || '').startsWith(KEY_PREFIX) ? String(token).slice(KEY_PREFIX.length) : token;
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

// Per-key usage limits: rpm (requests/minute), tokensPerDay, usdPerMonth
// (API-equivalent spend per pricing.json). All optional; absent = unlimited.
function validateLimits(l) {
  if (l === undefined || l === null) return undefined;
  if (typeof l !== 'object' || Array.isArray(l)) {
    throw new Error('limits must be an object like { rpm, tokensPerDay, usdPerMonth }');
  }
  const out = {};
  for (const [k, v] of Object.entries(l)) {
    if (v === undefined || v === null || v === '') continue;
    if (!['rpm', 'tokensPerDay', 'usdPerMonth'].includes(k)) {
      throw new Error(`limits.${k} is not a recognized limit (expected rpm, tokensPerDay, usdPerMonth)`);
    }
    const n = Number(v);
    if (k === 'usdPerMonth') {
      if (!Number.isFinite(n) || n <= 0) throw new Error('limits.usdPerMonth must be a number > 0');
      out[k] = Math.round(n * 100) / 100;
    } else {
      if (!Number.isInteger(n) || n < 1) throw new Error(`limits.${k} must be an integer ≥ 1`);
      out[k] = n;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function validateKeyRecord(k) {
  if (!k || typeof k.name !== 'string' || !NAME_RE.test(k.name)) {
    throw new Error(`credentials.json: every key needs a name matching ${NAME_RE}`);
  }
  if (!ROLES.has(k.role)) {
    throw new Error(`credentials.json: key "${k.name}" has an invalid role (expected admin|app)`);
  }
  if (typeof k.keyHash !== 'string' || !HASH_RE.test(k.keyHash)) {
    throw new Error(`credentials.json: key "${k.name}" is missing its keyHash (64 hex)`);
  }
  validateAccountPin(k.accountPin);
  validateLimits(k.limits);
  validatePinMode(k.pinMode);
  if (k.owner !== undefined && (typeof k.owner !== 'string' || !k.owner)) {
    throw new Error(`credentials.json: key "${k.name}" has an invalid owner`);
  }
  return k;
}

// How a key's accountPin behaves: 'hard' (default) fails loud when the pinned
// account is unusable; 'soft' treats the pin as the app's assigned account and
// fails over to the rest of the pool when it is exhausted/broken.
function validatePinMode(m) {
  if (m === undefined || m === null || m === '') return undefined;
  if (m !== 'hard' && m !== 'soft') throw new Error('pinMode must be "hard" or "soft"');
  return m;
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort on odd filesystems */ }
}

// Read the file, migrating a v1/v2 payload to v3 (and persisting the
// migration — plaintext secrets are hashed in place; their values keep
// verifying). Absent file → an empty v3 doc that is NOT written (callers
// decide whether to bootstrap). Throws on a malformed doc so a bad edit
// fails loud at boot.
function loadAndMigrate(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return { version: 3, keys: [] }; }

  let parsed;
  try { parsed = JSON.parse(raw); } catch (err) { throw new Error(`credentials.json: invalid JSON (${err.message})`); }

  // v1 → v3 migration, hashing the existing key value.
  if (parsed && typeof parsed.apiKey === 'string' && parsed.version === undefined) {
    const migrated = {
      version: 3,
      keys: [{
        name: 'admin',
        role: 'admin',
        keyHash: hashSecret(parsed.apiKey),
        createdAt: parsed.createdAt || nowIso(),
      }],
    };
    writeAtomic(file, migrated);
    return migrated;
  }

  // v2 → v3 migration: hash each plaintext secret in place.
  if (parsed && parsed.version === 2 && Array.isArray(parsed.keys)) {
    const migrated = {
      version: 3,
      keys: parsed.keys.map((k) => {
        if (typeof k.key !== 'string' || !k.key) {
          throw new Error(`credentials.json: key "${k.name}" is missing its secret`);
        }
        const { key, ...rest } = k;
        return { ...rest, keyHash: hashSecret(key) };
      }),
    };
    for (const k of migrated.keys) validateKeyRecord(k);
    writeAtomic(file, migrated);
    return migrated;
  }

  if (!parsed || parsed.version !== 3 || !Array.isArray(parsed.keys)) {
    throw new Error('credentials.json: expected { version: 3, keys: [...] }');
  }
  const seen = new Set();
  for (const k of parsed.keys) {
    validateKeyRecord(k);
    if (seen.has(k.name)) throw new Error(`credentials.json: duplicate key name "${k.name}"`);
    seen.add(k.name);
  }
  return { version: 3, keys: parsed.keys };
}

function createKeyStore({ file, envKey = '' } = {}) {
  const data = loadAndMigrate(file);
  // The env-provided key (launcher / tests) is an ephemeral admin key: valid
  // for verification, never persisted, never listed.
  const envRecord = envKey ? { name: 'env', role: 'admin', keyHash: hashSecret(bareToken(String(envKey))) } : null;

  const allRecords = () => (envRecord ? [envRecord, ...data.keys] : data.keys);

  function verify(token) {
    if (typeof token !== 'string' || !token) return null;
    const a = Buffer.from(hashSecret(bareToken(token)), 'hex');
    let match = null;
    // Compare against every record (constant work per key) so a hit vs. miss
    // isn't distinguishable by timing.
    for (const rec of allRecords()) {
      const b = Buffer.from(rec.keyHash, 'hex');
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) match = rec;
    }
    if (!match) return null;
    return {
      name: match.name,
      role: match.role,
      owner: match.owner || undefined,
      accountPin: match.accountPin ? { ...match.accountPin } : undefined,
      pinMode: match.pinMode || undefined,
      limits: match.limits ? { ...match.limits } : undefined,
    };
  }

  const publicKey = (k) => ({
    name: k.name,
    role: k.role,
    owner: k.owner || undefined,
    accountPin: k.accountPin ? { ...k.accountPin } : undefined,
    pinMode: k.pinMode || undefined,
    limits: k.limits ? { ...k.limits } : undefined,
    createdAt: k.createdAt,
  });

  function list() {
    return data.keys.map(publicKey)
      .sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)));
  }

  function listByOwner(owner) {
    return list().filter((k) => k.owner === owner);
  }

  function ownerOf(name) {
    const rec = data.keys.find((k) => k.name === name);
    return rec ? (rec.owner || null) : null;
  }

  function mint({ name, role = 'app', accountPin, limits, owner, pinMode } = {}) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new Error(`Key name must match ${NAME_RE}`);
    }
    if (!ROLES.has(role)) throw new Error('Key role must be admin or app');
    if (name === 'env') throw new Error('Key name "env" is reserved');
    if (data.keys.some((k) => k.name === name)) throw new Error(`A key named "${name}" already exists`);
    const pin = validateAccountPin(accountPin);
    const lim = validateLimits(limits);
    const mode = validatePinMode(pinMode);
    const secret = newSecret();
    const rec = { name, role, keyHash: hashSecret(secret), createdAt: nowIso() };
    if (owner) rec.owner = String(owner);
    if (pin) rec.accountPin = pin;
    if (pin && mode) rec.pinMode = mode;
    if (lim) rec.limits = lim;
    data.keys.push(rec);
    writeAtomic(file, { version: 3, keys: data.keys });
    // The one and only time the secret exists in the clear.
    return { ...publicKey(rec), key: presentKey(secret) };
  }

  // Update a key's limits in place (pass null/{} to clear). The secret and
  // role never change here — revoke + re-mint for that.
  function setLimits(name, limits) {
    const rec = data.keys.find((k) => k.name === name);
    if (!rec) throw new Error(`Unknown key "${name}"`);
    const lim = validateLimits(limits);
    if (lim) rec.limits = lim;
    else delete rec.limits;
    writeAtomic(file, { version: 3, keys: data.keys });
    return { name: rec.name, role: rec.role, accountPin: rec.accountPin ? { ...rec.accountPin } : undefined, limits: rec.limits ? { ...rec.limits } : undefined };
  }

  // Repoint a key's account pin (used when an account is renamed).
  function setAccountPin(name, pin) {
    const rec = data.keys.find((k) => k.name === name);
    if (!rec) throw new Error(`Unknown key "${name}"`);
    const p = validateAccountPin(pin);
    if (p) rec.accountPin = p; else delete rec.accountPin;
    writeAtomic(file, { version: 3, keys: data.keys });
    return publicKey(rec);
  }

  function revoke(name) {
    const i = data.keys.findIndex((k) => k.name === name);
    if (i === -1) throw new Error(`Unknown key "${name}"`);
    const admins = data.keys.filter((k) => k.role === 'admin');
    if (data.keys[i].role === 'admin' && admins.length === 1) {
      throw new Error('Cannot revoke the last admin key — mint another admin first');
    }
    data.keys.splice(i, 1);
    writeAtomic(file, { version: 3, keys: data.keys });
    return true;
  }

  return {
    verify,
    list,
    listByOwner,
    ownerOf,
    mint,
    revoke,
    setLimits,
    setAccountPin,
    get authEnabled() { return data.keys.length > 0 || Boolean(envRecord); },
    file,
  };
}

// Boot helper: ensure the file exists as v3 with at least one admin key.
// Secrets are hashed at rest, so the admin key value is only known — and
// returned — at creation time. An existing store returns adminKey: null;
// the operator already has the key (or rotates via the dashboard).
function bootstrapCredentialsFile(file) {
  const existedRaw = (() => { try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; } })();
  const wasLegacy = Boolean(existedRaw && (() => {
    try { const p = JSON.parse(existedRaw); return (typeof p.apiKey === 'string' && p.version === undefined) || p.version === 2; } catch (_) { return false; }
  })());

  const data = loadAndMigrate(file); // migrates v1/v2 → v3 in place if needed
  const existingAdmin = data.keys.find((k) => k.role === 'admin');
  if (existingAdmin) {
    return { adminKey: null, created: false, migrated: wasLegacy };
  }
  const secret = newSecret();
  data.keys.push({ name: 'admin', role: 'admin', keyHash: hashSecret(secret), createdAt: nowIso() });
  writeAtomic(file, { version: 3, keys: data.keys });
  return { adminKey: presentKey(secret), created: existedRaw === null, migrated: wasLegacy };
}

module.exports = { createKeyStore, loadAndMigrate, bootstrapCredentialsFile, validateAccountPin, validateLimits, presentKey };
