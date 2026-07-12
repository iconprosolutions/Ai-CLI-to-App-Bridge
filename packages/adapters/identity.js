'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Which account is currently logged in for each CLI. Both CLIs persist the
// signed-in identity in their config dir (non-secret: email + org/plan), so we
// read it straight from disk — no CLI spawn, no quota. This is what lets the
// dashboard show "signed in as …" and flag an expired/blank login, which matters
// when an operator swaps terminal logins.
//
// Files are cached by (path, mtime): ~/.claude.json is ~70KB, and status is
// polled every ~30s, so re-parsing only happens when the file actually changes.

const cache = new Map(); // absolute file path → { mtimeMs, value }

function readJsonCached(file) {
  let stat;
  try { stat = fs.statSync(file); } catch (_) { return null; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.value;
  let value = null;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { value = null; }
  cache.set(file, { mtimeMs: stat.mtimeMs, value });
  return value;
}

// claude: <configDir>/.claude.json → oauthAccount. configDir is CLAUDE_CONFIG_DIR
// for a pooled account, or the home dir for the implicit default account.
function claudeIdentity(configDir) {
  const dir = configDir || os.homedir();
  const j = readJsonCached(path.join(dir, '.claude.json'));
  const oa = j && j.oauthAccount;
  if (!oa || !oa.emailAddress) {
    // Token-based logins (claude setup-token) never write oauthAccount, but
    // they DO have working credentials — show that instead of "not signed in".
    const creds = readJsonCached(path.join(dir, '.credentials.json'));
    const tok = creds && creds.claudeAiOauth;
    if (tok && tok.accessToken) {
      // 'external' was this bridge's placeholder when the token flow doesn't
      // report a plan — these are always subscription tokens, never API credit.
      const plan = (tok.subscriptionType && tok.subscriptionType !== 'external') ? tok.subscriptionType : 'subscription';
      if (tok.refreshToken) {
        return { email: 'oauth login', label: 'browser login · self-refreshing', org: null, plan };
      }
      const exp = tok.expiresAt ? new Date(tok.expiresAt).toISOString().slice(0, 10) : null;
      return { email: 'token login', label: exp ? `long-lived token · expires ${exp}` : 'long-lived token', org: null, plan };
    }
    return null;
  }
  return {
    email: String(oa.emailAddress),
    label: oa.displayName ? String(oa.displayName) : null,
    org: oa.organizationName ? String(oa.organizationName) : null,
    plan: oa.organizationType ? String(oa.organizationType) : null,
  };
}

// agy/gemini: <home>/.gemini/google_accounts.json → active. home is the account's
// HOME override for a pooled account, or the process home for the default.
function geminiIdentity(home) {
  const j = readJsonCached(path.join(home || os.homedir(), '.gemini', 'google_accounts.json'));
  if (!j || !j.active) return null;
  return { email: String(j.active), label: null, org: null, plan: null };
}

module.exports = { claudeIdentity, geminiIdentity, readJsonCached };
