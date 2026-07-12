'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Dashboard users + sessions — the login layer of SaaS mode. Users own API
// keys (keys.js records carry `owner`); admins additionally manage users,
// routes, accounts and everyone's keys.
//
// users.json shape:
//   { "version": 1, "users": [
//       { "username": "admin", "role": "admin", "passwordHash": "scrypt$<salt>$<hash>",
//         "displayName": "…", "defaultLimits": { rpm, tokensPerDay, usdPerMonth },
//         "disabled": false, "createdAt": "…" } ] }
//
// Sessions are opaque tokens persisted to sessions.json (best-effort) so a
// container restart doesn't log everyone out. Passwords are scrypt-hashed;
// verification is timing-safe. Login attempts are rate-limited in memory.

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,30}$/;
const ROLES = new Set(['admin', 'user']);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5; // per username
const LOGIN_MAX_PER_IP = 20; // per source IP — bounds username spraying
const LOGIN_MAX_GLOBAL = 60; // across everyone — bounds scrypt event-loop load
                             // even when the client IP is spoofed/forwarded

function nowIso() { return new Date().toISOString(); }

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(String(password), parts[1], 32);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Burned on login attempts against unknown/disabled usernames so a fast 401
// can't confirm whether an account exists (scrypt dominates the timing).
const DUMMY_HASH = hashPassword('timing-equalizer');

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* best effort */ }
}

function validateUsername(u) {
  if (typeof u !== 'string' || !USERNAME_RE.test(u)) {
    throw new Error(`Username must match ${USERNAME_RE} (lowercase letters, digits, . _ -)`);
  }
  return u;
}

function createUserStore({ file, sessionsFile, validateLimits } = {}) {
  // Absent file → empty store (bootstrap() then creates the admin login).
  // A present-but-malformed file fails loud at boot, like credentials.json.
  let data = { version: 1, users: [] };
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { /* first boot */ }
  if (raw !== null) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch (err) { throw new Error(`users.json: invalid JSON (${err.message})`); }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.users)) {
      throw new Error('users.json: expected { version: 1, users: [...] }');
    }
    for (const u of parsed.users) {
      validateUsername(u.username);
      if (!ROLES.has(u.role)) throw new Error(`users.json: user "${u.username}" has an invalid role`);
      if (typeof u.passwordHash !== 'string') throw new Error(`users.json: user "${u.username}" is missing passwordHash`);
    }
    data = parsed;
  }

  // sessions: sha256(token) → { username, createdAt, expiresAt }. Tokens are
  // hashed at rest so sessions.json never contains a live browser credential;
  // the cookie carries the raw 48-hex token. Legacy raw entries (48 hex) are
  // hashed on load, so existing sessions survive the upgrade.
  const hashToken = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
  const sessions = new Map();
  try {
    const persisted = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    for (const [tok, s] of Object.entries(persisted || {})) {
      if (s && s.expiresAt > Date.now()) sessions.set(tok.length === 48 ? hashToken(tok) : tok, s);
    }
  } catch (_) { /* no sessions yet */ }

  function persistSessions() {
    try { writeAtomic(sessionsFile, Object.fromEntries(sessions)); } catch (_) { /* best effort */ }
  }

  function save() { writeAtomic(file, data); }

  const findUser = (username) => data.users.find((u) => u.username === username);

  // One-time bootstrap: no users → create the admin login and hand back the
  // generated password to print exactly once (never stored in the clear).
  // The printed password lives in the container log, so the account is born
  // with mustChangePassword — sessions are gated until it is replaced.
  function bootstrap() {
    if (data.users.length) return null;
    const password = crypto.randomBytes(9).toString('base64url'); // 12 chars
    data.users.push({
      username: 'admin', role: 'admin', passwordHash: hashPassword(password), mustChangePassword: true, createdAt: nowIso(),
    });
    save();
    return { username: 'admin', password };
  }

  // ── Login rate limiting (in-memory sliding windows) ────────────────────
  // Three layers: per-username (targeted guessing), per-IP (username
  // spraying), global (event-loop protection — scrypt is deliberately slow,
  // and the IP can be spoofed via forwarded headers, so a spray from "many"
  // IPs still hits this ceiling).
  const attempts = new Map(); // username → [ts...]
  const attemptsByIp = new Map(); // ip → [ts...]
  let globalWindow = []; // [ts...]

  const pruneWindow = (arr, now) => arr.filter((t) => now - t < LOGIN_WINDOW_MS);

  function throttled(username, ip) {
    const now = Date.now();
    globalWindow = pruneWindow(globalWindow, now);
    if (globalWindow.length >= LOGIN_MAX_GLOBAL) return true;
    const byName = pruneWindow(attempts.get(username) || [], now);
    if (byName.length) attempts.set(username, byName); else attempts.delete(username);
    if (byName.length >= LOGIN_MAX_ATTEMPTS) return true;
    if (ip) {
      const byIp = pruneWindow(attemptsByIp.get(ip) || [], now);
      if (byIp.length) attemptsByIp.set(ip, byIp); else attemptsByIp.delete(ip);
      if (byIp.length >= LOGIN_MAX_PER_IP) return true;
    }
    return false;
  }

  function recordFailure(username, ip) {
    const now = Date.now();
    attempts.set(username, pruneWindow(attempts.get(username) || [], now).concat(now));
    globalWindow.push(now);
    if (!ip) return;
    attemptsByIp.set(ip, pruneWindow(attemptsByIp.get(ip) || [], now).concat(now));
    // A spray of fabricated forwarded IPs must not grow this map without bound.
    if (attemptsByIp.size > 1000) {
      for (const [k, v] of attemptsByIp) {
        if (!pruneWindow(v, now).length) attemptsByIp.delete(k);
      }
    }
  }

  function login(username, password, ip) {
    const name = String(username || '').toLowerCase();
    if (throttled(name, ip)) return { ok: false, status: 429, error: 'Too many login attempts — wait a minute.' };
    const user = findUser(name);
    // Unknown/disabled usernames still burn one scrypt so response timing
    // doesn't reveal which accounts exist.
    const good = user && !user.disabled
      ? verifyPassword(password, user.passwordHash)
      : (verifyPassword(password, DUMMY_HASH) && false);
    if (!good) {
      recordFailure(name, ip);
      return { ok: false, status: 401, error: 'Invalid username or password.' };
    }
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(hashToken(token), { username: user.username, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
    persistSessions();
    return { ok: true, token, user: publicUser(user) };
  }

  function logout(token) {
    if (sessions.delete(hashToken(token))) persistSessions();
  }

  // Password check without creating a session (change-password flow). Rides
  // the same throttle windows as login — this path verifies passwords too.
  function checkPassword(username, password, ip) {
    const name = String(username || '');
    if (throttled(name, ip)) return { ok: false, status: 429, error: 'Too many attempts — wait a minute.' };
    const user = findUser(name);
    const good = Boolean(user && !user.disabled && verifyPassword(password, user.passwordHash));
    if (!good) recordFailure(name, ip);
    return good ? { ok: true } : { ok: false, status: 403, error: 'Current password is incorrect.' };
  }

  // Resolve a session token to its (live, enabled) user.
  function resolve(token) {
    if (!token) return null;
    const key = hashToken(token);
    const s = sessions.get(key);
    if (!s) return null;
    if (s.expiresAt < Date.now()) { sessions.delete(key); persistSessions(); return null; }
    const user = findUser(s.username);
    if (!user || user.disabled) return null;
    return publicUser(user);
  }

  function killSessions(username) {
    let changed = false;
    for (const [tok, s] of sessions) {
      if (s.username === username) { sessions.delete(tok); changed = true; }
    }
    if (changed) persistSessions();
  }

  function publicUser(u) {
    return {
      username: u.username,
      role: u.role,
      displayName: u.displayName || u.username,
      defaultLimits: u.defaultLimits ? { ...u.defaultLimits } : undefined,
      disabled: Boolean(u.disabled),
      mustChangePassword: u.mustChangePassword ? true : undefined,
      createdAt: u.createdAt,
    };
  }

  function list() { return data.users.map(publicUser); }

  function create({ username, password, role = 'user', displayName, defaultLimits } = {}) {
    const name = validateUsername(String(username || '').toLowerCase());
    if (!ROLES.has(role)) throw new Error('Role must be admin or user');
    if (typeof password !== 'string' || password.length < 8) throw new Error('Password must be at least 8 characters');
    if (findUser(name)) throw new Error(`User "${name}" already exists`);
    const lim = validateLimits ? validateLimits(defaultLimits) : defaultLimits;
    const rec = { username: name, role, passwordHash: hashPassword(password), createdAt: nowIso() };
    if (displayName) rec.displayName = String(displayName).slice(0, 60);
    if (lim) rec.defaultLimits = lim;
    data.users.push(rec);
    save();
    return publicUser(rec);
  }

  function update(username, { role, password, displayName, defaultLimits, disabled } = {}) {
    const user = findUser(username);
    if (!user) throw new Error(`Unknown user "${username}"`);
    const admins = data.users.filter((u) => u.role === 'admin' && !u.disabled);
    const demoting = (role && role !== 'admin') || disabled === true;
    if (user.role === 'admin' && admins.length === 1 && demoting) {
      throw new Error('Cannot demote or disable the last admin user');
    }
    if (role !== undefined) {
      if (!ROLES.has(role)) throw new Error('Role must be admin or user');
      user.role = role;
    }
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 8) throw new Error('Password must be at least 8 characters');
      user.passwordHash = hashPassword(password);
      delete user.mustChangePassword; // the logged bootstrap password is gone
      killSessions(username); // force re-login everywhere
    }
    if (displayName !== undefined) user.displayName = String(displayName).slice(0, 60) || undefined;
    if (defaultLimits !== undefined) {
      const lim = validateLimits ? validateLimits(defaultLimits) : defaultLimits;
      if (lim) user.defaultLimits = lim;
      else delete user.defaultLimits;
    }
    if (disabled !== undefined) {
      user.disabled = Boolean(disabled);
      if (user.disabled) killSessions(username);
    }
    save();
    return publicUser(user);
  }

  function remove(username) {
    const i = data.users.findIndex((u) => u.username === username);
    if (i === -1) throw new Error(`Unknown user "${username}"`);
    const admins = data.users.filter((u) => u.role === 'admin' && !u.disabled);
    if (data.users[i].role === 'admin' && admins.length === 1) {
      throw new Error('Cannot delete the last admin user');
    }
    data.users.splice(i, 1);
    killSessions(username);
    save();
    return true;
  }

  return {
    bootstrap, login, logout, resolve, checkPassword, killSessions, list, create, update, remove,
    get count() { return data.users.length; },
    file,
  };
}

module.exports = { createUserStore, hashPassword, verifyPassword, USERNAME_RE };
