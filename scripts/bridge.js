#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, '.bridge-runtime');
const NODE_PATH = [
  path.join(ROOT, 'claude-bridge', 'node_modules'),
  process.env.NODE_PATH || '',
].filter(Boolean).join(path.delimiter);

function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
}

// ─────────────────────────────────────────────────────────────
// API key resolution
// Priority: explicit env (PROVIDER_API_KEY / BRIDGE_API_KEY) >
// --insecure / BRIDGE_DEV_KEY escape hatch (restores the old
// 'test-key' for dev/tests) > a persisted auto-generated key under
// .bridge-runtime/credentials.json (gitignored). No shipped default
// secret on a reachable port.
// ─────────────────────────────────────────────────────────────
const CRED_FILE = path.join(RUNTIME_DIR, 'credentials.json');
const INSECURE = process.argv.includes('--insecure') || process.env.BRIDGE_DEV_KEY === '1';

function resolveKey() {
  const explicit = process.env.PROVIDER_API_KEY || process.env.BRIDGE_API_KEY;
  if (explicit) return { key: explicit, source: 'env' };
  if (INSECURE) return { key: 'test-key', source: 'insecure (dev)' };
  ensureRuntimeDir();
  try {
    const saved = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    if (saved && saved.apiKey) {
      // Tighten pre-existing files that were created world-readable.
      try { fs.chmodSync(CRED_FILE, 0o600); } catch (_) { /* best effort */ }
      return { key: saved.apiKey, source: 'persisted' };
    }
  } catch (_) { /* not generated yet */ }
  const key = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(CRED_FILE, `${JSON.stringify({ apiKey: key, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  return { key, source: 'generated' };
}

const cred = resolveKey();
const sharedKey = cred.key;
const providerKey = cred.key;

// PATH-resolvable CLI defaults — no hard-coded per-user absolute paths.
// Override with GEMINI_PATH/AGY_PATH or CLAUDE_PATH (absolute or bare command).
const geminiPath = process.env.GEMINI_PATH || process.env.AGY_PATH || 'agy';
const claudePath = process.env.CLAUDE_PATH || 'claude';

// Flags (position-independent).
const OPEN = process.argv.includes('--open') || process.env.BRIDGE_OPEN === '1';
const FOLLOW = process.argv.includes('--follow');

const ports = {
  claude: Number(process.env.CLAUDE_PORT || process.env.PORT_CLAUDE) || 9002,
  gemini: Number(process.env.GEMINI_PORT || process.env.PORT_GEMINI) || 9003,
  provider: Number(process.env.PROVIDER_PORT) || 9011,
};

const services = {
  gemini: {
    label: 'Gemini/Antigravity bridge',
    cwd: path.join(ROOT, 'gemini-bridge'),
    script: 'server.js',
    port: ports.gemini,
    cli: geminiPath,
    cliEnvHint: 'GEMINI_PATH (or AGY_PATH)',
    env: {
      NODE_PATH,
      PORT: String(ports.gemini),
      BRIDGE_API_KEY: sharedKey,
      GEMINI_PATH: geminiPath,
      GEMINI_MODEL: process.env.GEMINI_MODEL || 'Gemini 3.5 Flash (Low)',
    },
  },
  claude: {
    label: 'Claude bridge',
    cwd: path.join(ROOT, 'claude-bridge'),
    script: 'server.js',
    port: ports.claude,
    cli: claudePath,
    cliEnvHint: 'CLAUDE_PATH',
    env: {
      PORT: String(ports.claude),
      BRIDGE_API_KEY: sharedKey,
      CLAUDE_PATH: claudePath,
      CLAUDE_MODEL: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    },
  },
  provider: {
    label: 'Provider bridge',
    cwd: path.join(ROOT, 'provider-bridge'),
    script: 'server.js',
    port: ports.provider,
    env: {
      NODE_PATH,
      PROVIDER_PORT: String(ports.provider),
      PROVIDER_API_KEY: providerKey,
      BRIDGE_API_KEY: sharedKey,
      GEMINI_BRIDGE_URL: process.env.GEMINI_BRIDGE_URL || `http://127.0.0.1:${ports.gemini}`,
      CLAUDE_BRIDGE_URL: process.env.CLAUDE_BRIDGE_URL || `http://127.0.0.1:${ports.claude}`,
    },
  },
};

const DASHBOARD_URL = `http://127.0.0.1:${ports.provider}/dashboard`;

// The optional positional service-name arg (e.g. `bridge:logs gemini`).
function parseOnly() {
  const arg = process.argv[3];
  return arg && services[arg] ? arg : null;
}

function serviceNames(only) {
  return only ? [only] : Object.keys(services);
}

function pidFile(name) {
  return path.join(RUNTIME_DIR, `${name}.pid`);
}

function logFile(name) {
  return path.join(RUNTIME_DIR, `${name}.log`);
}

function readPid(name) {
  try {
    return Number(fs.readFileSync(pidFile(name), 'utf8').trim()) || null;
  } catch (_) {
    return null;
  }
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

// Resolve a CLI binary the way a shell would: absolute/relative path → exists
// check; bare command → search PATH for an executable. Returns the resolved
// path or null. Used for an actionable preflight before spawning a bridge.
function resolveBin(bin) {
  if (!bin) return null;
  if (bin.includes('/')) return fs.existsSync(bin) ? bin : null;
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch (_) { /* keep searching */ }
  }
  return null;
}

function tailLog(name, n = 15) {
  try {
    const lines = fs.readFileSync(logFile(name), 'utf8').split('\n').filter(Boolean);
    const tail = lines.slice(-n);
    if (tail.length) console.log(tail.map((l) => `    ${name} | ${l}`).join('\n'));
  } catch (_) { /* no log yet */ }
}

function openUrl(url) {
  const opener = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
    console.log(`Opening ${url}`);
  } catch (_) { /* best effort */ }
}

function requestHealth(port) {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/health', method: 'GET', timeout: 1200 },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: data });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
    req.end();
  });
}

// Authenticated JSON GET against a local bridge/provider port.
function httpGetJson(port, pathName) {
  return new Promise((resolve) => {
    const headers = {};
    if (providerKey) headers.Authorization = `Bearer ${providerKey}`;
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathName, method: 'GET', headers, timeout: 4000 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let body = null;
          try { body = JSON.parse(data); } catch (_) {}
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }));
    req.end();
  });
}

async function waitForHealth(name, port, hasExited) {
  for (let i = 0; i < 30; i += 1) {
    if (hasExited && hasExited()) return false; // child died — stop waiting
    const health = await requestHealth(port);
    if (health.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  console.log(`${name}: started, but /health did not answer in time. Last log lines:`);
  tailLog(name);
  return false;
}

async function statusOne(name, svc) {
  const pid = readPid(name);
  const owned = isPidAlive(pid);
  const health = await requestHealth(svc.port);
  return { name, svc, pid, owned, health };
}

async function status(only) {
  for (const name of serviceNames(only)) {
    const s = await statusOne(name, services[name]);
    const state = s.health.ok ? 'online' : (s.owned ? 'starting/down' : 'offline');
    const owner = s.owned ? `pid ${s.pid}` : 'no launcher pid';
    console.log(`${name.padEnd(8)} ${state.padEnd(14)} ${owner.padEnd(18)} http://127.0.0.1:${services[name].port}`);
  }
  console.log(`\nDashboard: ${DASHBOARD_URL}`);
  console.log(`API key (${cred.source}): ${providerKey}`);
}

async function up(only) {
  ensureRuntimeDir();
  console.log(`Provider API key (${cred.source}): ${providerKey}`);
  for (const name of serviceNames(only)) {
    const svc = services[name];
    const existing = await statusOne(name, svc);
    if (existing.health.ok) {
      console.log(`${name}: already online at http://127.0.0.1:${svc.port}`);
      continue;
    }
    if (existing.owned) {
      console.log(`${name}: launcher pid ${existing.pid} exists but health is not ready; check ${path.relative(ROOT, logFile(name))}`);
      continue;
    }

    // Preflight: fail fast with an actionable message if the CLI is missing.
    if (svc.cli && !resolveBin(svc.cli)) {
      console.error(`${name}: CLI "${svc.cli}" not found on PATH. Set ${svc.cliEnvHint} to its absolute path, or add it to PATH. Skipping ${name}.`);
      continue;
    }

    const out = fs.openSync(logFile(name), 'a');
    let exitedEarly = false;
    const child = spawn(process.execPath, [svc.script], {
      cwd: svc.cwd,
      env: { ...process.env, ...svc.env },
      detached: true,
      stdio: ['ignore', out, out],
    });
    // Wire failure handlers BEFORE unref so an early crash is visible, not silent.
    child.on('error', (err) => {
      console.error(`${name}: failed to spawn (${err.message})`);
    });
    child.on('exit', (code) => {
      if (code && code !== 0) {
        exitedEarly = true;
        console.error(`${name}: exited early with code ${code}. Last log lines:`);
        tailLog(name);
        try { fs.unlinkSync(pidFile(name)); } catch (_) {}
      }
    });
    child.unref();
    fs.writeFileSync(pidFile(name), `${child.pid}\n`);
    console.log(`${name}: started pid ${child.pid}`);
    await waitForHealth(name, svc.port, () => exitedEarly);
  }
  console.log(`\nOpen the dashboard: ${DASHBOARD_URL}`);
  console.log(`Use this API key in the dashboard tester: ${providerKey}`);
  if (OPEN) {
    const health = await requestHealth(ports.provider);
    if (health.ok) openUrl(DASHBOARD_URL);
    else console.log('(--open skipped: provider not healthy yet)');
  }
}

async function down(only) {
  ensureRuntimeDir();
  for (const name of serviceNames(only).reverse()) {
    const pid = readPid(name);
    if (!pid || !isPidAlive(pid)) {
      console.log(`${name}: no launcher-owned process running`);
      try { fs.unlinkSync(pidFile(name)); } catch (_) {}
      continue;
    }
    process.kill(pid, 'SIGTERM');
    console.log(`${name}: stopped pid ${pid}`);
    try { fs.unlinkSync(pidFile(name)); } catch (_) {}
  }
}

async function restart(only) {
  await down(only);
  await new Promise((r) => setTimeout(r, 500));
  await up(only);
}

// Print available model routes + each engine's reported model catalogue.
// Read-only and quota-free: the gemini bridge lists models via `agy models`
// and the claude bridge serves a static catalogue — no completion is run.
async function probe() {
  const dash = await httpGetJson(ports.provider, '/dashboard/status');
  if (!dash.ok || !dash.body) {
    console.error(`probe: provider not reachable on ${ports.provider} (${dash.status || dash.error}). Run "npm run bridge:up" first.`);
    process.exitCode = 1;
    return;
  }
  const routes = dash.body.routes || [];
  console.log('Provider routes (use the id as the `model`):\n');
  for (const r of routes) {
    console.log(`  ${String(r.id).padEnd(44)} ${String(r.engine).padEnd(8)} → ${r.upstreamModel}`);
  }
  const [cl, ge] = await Promise.all([
    httpGetJson(ports.claude, '/models'),
    httpGetJson(ports.gemini, '/models'),
  ]);
  const list = (r) => (r.ok && Array.isArray(r.body)
    ? (r.body.map((m) => m.name || m.id).join(', ') || '(none reported)')
    : `unreachable (${r.status || r.error})`);
  console.log('\nEngine model catalogues (engine-reported, availability is per-account for Gemini):');
  console.log(`  claude: ${list(cl)}`);
  console.log(`  gemini: ${list(ge)}`);
}

// Write a paste-ready connection bundle (base URL, key, routes, snippets)
// to .bridge-runtime/connection.json, single-sourced from the live provider.
async function connect() {
  ensureRuntimeDir();
  const baseUrl = `http://127.0.0.1:${ports.provider}/v1`;
  const dash = await httpGetJson(ports.provider, '/dashboard/status');
  const routes = (dash.ok && dash.body && dash.body.routes) || [];
  const defaultRoute = (dash.ok && dash.body && dash.body.defaultRoute) || 'bridge-agy-gemini-3.5-flash-medium-pulse';
  if (!dash.ok) console.log(`(provider not reachable — writing config with defaults; run "npm run bridge:up" to refresh routes)`);

  const modelLines = routes.length
    ? routes.map((r) => `      - ${r.id}`).join('\n')
    : `      - ${defaultRoute}`;
  const conn = {
    baseUrl,
    apiKey: providerKey,
    defaultRoute,
    routes: routes.map((r) => ({ id: r.id, engine: r.engine, upstreamModel: r.upstreamModel })),
    generatedAt: new Date().toISOString(),
    snippets: {
      curl: `curl ${baseUrl}/chat/completions -H "Authorization: Bearer ${providerKey}" -H "Content-Type: application/json" -d '{"model":"${defaultRoute}","messages":[{"role":"user","content":"Hello"}]}'`,
      openaiPython: `from openai import OpenAI\nclient = OpenAI(base_url="${baseUrl}", api_key="${providerKey}")`,
      hermesEnv: `AI_CLI_BRIDGE_API_KEY=${providerKey}`,
      hermesConfig: `providers:\n  ai-cli-bridge:\n    type: openai\n    base_url: ${baseUrl}\n    api_key: \${AI_CLI_BRIDGE_API_KEY}\n    models:\n${modelLines}`,
    },
  };
  const file = path.join(RUNTIME_DIR, 'connection.json');
  fs.writeFileSync(file, `${JSON.stringify(conn, null, 2)}\n`, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* tighten pre-existing */ }
  console.log(`Wrote ${path.relative(ROOT, file)}`);
  console.log(`Base URL: ${baseUrl}`);
  console.log(`API key:  ${providerKey}`);
  console.log(`Default:  ${defaultRoute}`);
  console.log(`\nHermes (~/.hermes/config.yaml):\n${conn.snippets.hermesConfig}`);
}

function logs(only, follow) {
  const names = serviceNames(only);
  if (follow) {
    const files = names.map(logFile).filter((f) => fs.existsSync(f));
    if (!files.length) {
      console.log('No logs yet. Start the bridges with "npm run bridge:up".');
      return undefined;
    }
    spawn('tail', ['-n', '40', '-f', ...files], { stdio: 'inherit' });
    return new Promise(() => {}); // run until Ctrl-C
  }
  for (const name of names) {
    console.log(`=== ${name} (${path.relative(ROOT, logFile(name))}) ===`);
    tailLog(name, 40);
  }
  return undefined;
}

async function main() {
  const command = process.argv[2] || 'status';
  const only = parseOnly();
  if (command === 'up') return up(only);
  if (command === 'down') return down(only);
  if (command === 'status') return status(only);
  if (command === 'restart') return restart(only);
  if (command === 'probe') return probe();
  if (command === 'connect') return connect();
  if (command === 'logs') return logs(only, FOLLOW);
  console.error('Usage: bridge.js <up|down|status|restart|probe|connect|logs> [service] [--open|--follow|--insecure]');
  process.exitCode = 2;
  return undefined;
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
