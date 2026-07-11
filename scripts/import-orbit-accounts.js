#!/usr/bin/env node
'use strict';

// Import Orbit OS-vaulted Claude accounts into the bridge account pool.
// RUN ON THE MAC (needs the keychain + Orbit's SQLite DB). Writes each
// account's OAuth blob to <runtime>/accounts/claude/<name>/.credentials.json
// and registers it in accounts.json (usageSource oauth). Daily-driver accounts
// are skipped — onboard those with `claude setup-token`.
//
//   node scripts/import-orbit-accounts.js [--dry-run] [--runtime <dir>] [--skip a@x,b@y]
//
// Default runtime dir: ./.bridge-runtime (matches BRIDGE_ACCOUNTS_FILE default).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { planOrbitImport, readOrbitAccounts, vaultHasBlob, readVaultBlob, DEFAULT_SKIP } = require('../packages/provider/orbit-import');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const dryRun = process.argv.includes('--dry-run');
const runtime = path.resolve(arg('--runtime', path.join(__dirname, '..', '.bridge-runtime')));
const skipEmails = (arg('--skip', DEFAULT_SKIP.join(','))).split(',').map((s) => s.trim()).filter(Boolean);
const orbitDb = arg('--orbit-db', path.join(os.homedir(), '.claudeos', 'claudeos.db'));
const accountsFile = path.join(runtime, 'accounts.json');

if (!fs.existsSync(orbitDb)) { console.error(`Orbit DB not found: ${orbitDb}`); process.exit(1); }

const orbitAccounts = readOrbitAccounts(orbitDb);
const existing = fs.existsSync(accountsFile) ? JSON.parse(fs.readFileSync(accountsFile, 'utf8')) : {};
const plan = planOrbitImport({ orbitAccounts, existing, skipEmails, hasVaultBlob: vaultHasBlob });

console.log(`\nOrbit import plan (${dryRun ? 'DRY RUN' : 'APPLYING'}):`);
for (const a of plan.imported) console.log(`  + ${a.email}  →  claude:${a.name}  (${a.dir})`);
for (const s of plan.skipped) console.log(`  - ${s.email || s.id}  skipped: ${s.reason}`);
if (!plan.imported.length) { console.log('\nNothing to import.'); process.exit(0); }

if (dryRun) { console.log('\nDry run — no files written.'); process.exit(0); }

for (const a of plan.imported) {
  const dir = path.join(runtime, a.dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.credentials.json'), readVaultBlob(a.blobFromVaultId), { mode: 0o600 });
}
fs.mkdirSync(runtime, { recursive: true });
fs.writeFileSync(accountsFile, `${JSON.stringify(plan.accountsJson, null, 2)}\n`);
console.log(`\nWrote ${plan.imported.length} account(s) + ${accountsFile}. Probe them from the dashboard Accounts tab.`);
