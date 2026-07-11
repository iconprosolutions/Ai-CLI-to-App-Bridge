'use strict';

const { execFileSync } = require('child_process');

// Daily-driver accounts the operator actively uses on the Mac — importing
// their OAuth blob would make the bridge's token refresh clobber the Mac login
// (Anthropic rotates refresh tokens). These are onboarded separately via
// `claude setup-token` (no rotation). Override with --skip on the CLI.
const DEFAULT_SKIP = ['waqar@iconprosolutions.com', 'waqar@unitedtf.org'];

const localpart = (email) => String(email || '').split('@')[0].replace(/[^A-Za-z0-9._-]/g, '') || 'account';

// Pure planner: decide which Orbit accounts become bridge accounts, their
// names/dirs, and what to skip and why. No I/O — fully unit-testable.
function planOrbitImport({ orbitAccounts, existing = {}, skipEmails = DEFAULT_SKIP, hasVaultBlob = () => true }) {
  const skip = new Set(skipEmails.map((e) => e.toLowerCase()));
  const existingClaude = (existing.claude || []).slice();
  const used = new Set(existingClaude.map((a) => a.name));
  const imported = [];
  const skipped = [];

  for (const acc of orbitAccounts) {
    if (acc.provider !== 'claude') { skipped.push({ id: acc.id, email: acc.email, reason: `provider ${acc.provider}, not claude` }); continue; }
    if (acc.source !== 'oauth') { skipped.push({ id: acc.id, email: acc.email, reason: `source ${acc.source}, no vaulted login` }); continue; }
    if (skip.has(String(acc.email).toLowerCase())) { skipped.push({ id: acc.id, email: acc.email, reason: 'daily driver — skip (use setup-token)' }); continue; }
    if (!hasVaultBlob(acc.id)) { skipped.push({ id: acc.id, email: acc.email, reason: 'no vault blob (log in once while Orbit runs, then re-import)' }); continue; }

    let name = localpart(acc.email);
    let n = 1;
    while (used.has(name)) { n += 1; name = `${localpart(acc.email)}-${n}`; }
    used.add(name);
    imported.push({ name, dir: `accounts/claude/${name}`, usageSource: 'oauth', email: acc.email, blobFromVaultId: acc.id });
  }

  const accountsJson = { ...existing, claude: existingClaude.concat(imported.map((a) => ({ name: a.name, dir: a.dir, usageSource: a.usageSource }))) };
  return { imported, skipped, accountsJson };
}

// ── Thin I/O layer (macOS operator machine) ───────────────────────────────
// Enumerate Orbit's tracked Claude accounts from its SQLite DB.
function readOrbitAccounts(dbPath) {
  const sql = `SELECT id, email, provider, source FROM accounts WHERE provider='claude';`;
  const out = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return out.trim() ? JSON.parse(out) : [];
}

// True when Orbit's login vault holds a credential blob for this account uuid.
function vaultHasBlob(accountId) {
  try {
    execFileSync('security', ['find-generic-password', '-s', 'Claude OS Login Vault', '-a', accountId, '-w'], { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch (_) { return false; }
}

// Read the vaulted credential blob (the claude .credentials.json contents).
function readVaultBlob(accountId) {
  return execFileSync('security', ['find-generic-password', '-s', 'Claude OS Login Vault', '-a', accountId, '-w'], { encoding: 'utf8' }).trim();
}

module.exports = { planOrbitImport, readOrbitAccounts, vaultHasBlob, readVaultBlob, DEFAULT_SKIP, localpart };
