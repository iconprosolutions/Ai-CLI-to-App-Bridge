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
const LOGIN_MAX_ATTEMPTS = 5;

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

  // sessions: token → { username, createdAt, expiresAt }
  const sessions = new Map();
  try {
    const persisted = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
    for (const [tok, s] of Object.entries(persisted || {})) {
      if (s && s.expiresAt > Date.now()) sessions.set(tok, s);
    }
  } catch (_) { /* no sessions yet */ }

  function persistSessions() {
    try { writeAtomic(sessionsFile, Object.fromEntries(sessions)); } catch (_) { /* best effort */ }
  }

  function save() { writeAtomic(file, data); }

  const findUser = (username) => data.users.find((u) => u.username === username);

  // One-time bootstrap: no users → create the admin login and hand back the
  // generated password to print exactly once (never stored in the clear).
  function bootstrap() {
    if (data.users.length) return null;
    const password = crypto.randomBytes(9).toString('base64url'); // 12 chars
    data.users.push({
      username: 'admin', role: 'admin', passwordHash: hashPassword(password), createdAt: nowIso(),
    });
    save();
    return { username: 'admin', password };
  }

  // ── Login rate limiting (per username, in-memory) ─────────────────────
  const attempts = new Map(); // username → [ts...]
  function throttled(username) {
    const now = Date.now();
    const arr = (attempts.get(username) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
    attempts.set(username, arr);
    return arr.length >= LOGIN_MAX_ATTEMPTS;
  }

  function login(username, password) {
    const name = String(username || '').toLowerCase();
    if (throttled(name)) return { ok: false, status: 429, error: 'Too many login attempts — wait a minute.' };
    const user = findUser(name);
    const good = user && !user.disabled && verifyPassword(password, user.passwordHash);
    if (!good) {
      attempts.get(name).push(Date.now());
      return { ok: false, status: 401, error: 'Invalid username or password.' };
    }
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, { username: user.username, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
    persistSessions();
    return { ok: true, token, user: publicUser(user) };
  }

  function logout(token) {
    if (sessions.delete(token)) persistSessions();
  }

  // Password check without creating a session (change-password flow).
  function checkPassword(username, password) {
    const user = findUser(username);
    return Boolean(user && !user.disabled && verifyPassword(password, user.passwordHash));
  }

  // Resolve a session token to its (live, enabled) user.
  function resolve(token) {
    if (!token) return null;
    const s = sessions.get(token);
    if (!s) return null;
    if (s.expiresAt < Date.now()) { sessions.delete(token); persistSessions(); return null; }
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
