#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, '.bridge-runtime');
const NODE_PATH = [
  path.join(ROOT, 'claude-bridge', 'node_modules'),
  process.env.NODE_PATH || '',
].filter(Boolean).join(path.delimiter);

const sharedKey = process.env.BRIDGE_API_KEY || 'test-key';
const providerKey = process.env.PROVIDER_API_KEY || sharedKey;
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
    env: {
      NODE_PATH,
      PORT: String(ports.gemini),
      BRIDGE_API_KEY: sharedKey,
      GEMINI_PATH: process.env.GEMINI_PATH || process.env.AGY_PATH || '/Users/waqar/.local/bin/agy',
      GEMINI_MODEL: process.env.GEMINI_MODEL || 'Gemini 3.5 Flash (Low)',
    },
  },
  claude: {
    label: 'Claude bridge',
    cwd: path.join(ROOT, 'claude-bridge'),
    script: 'server.js',
    port: ports.claude,
    env: {
      PORT: String(ports.claude),
      BRIDGE_API_KEY: sharedKey,
      CLAUDE_PATH: process.env.CLAUDE_PATH || '/Users/waqar/.local/bin/claude',
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

function ensureRuntimeDir() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
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

async function waitForHealth(name, port) {
  for (let i = 0; i < 30; i += 1) {
    const health = await requestHealth(port);
    if (health.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  console.log(`${name}: started, but /health did not answer yet. Check ${path.relative(ROOT, logFile(name))}`);
  return false;
}

async function statusOne(name, svc) {
  const pid = readPid(name);
  const owned = isPidAlive(pid);
  const health = await requestHealth(svc.port);
  return { name, svc, pid, owned, health };
}

async function status() {
  for (const [name, svc] of Object.entries(services)) {
    const s = await statusOne(name, svc);
    const state = s.health.ok ? 'online' : (s.owned ? 'starting/down' : 'offline');
    const owner = s.owned ? `pid ${s.pid}` : 'no launcher pid';
    console.log(`${name.padEnd(8)} ${state.padEnd(14)} ${owner.padEnd(18)} http://127.0.0.1:${svc.port}`);
  }
  console.log(`\nDashboard: http://127.0.0.1:${ports.provider}/dashboard`);
  console.log(`API key:   ${providerKey}`);
}

async function up() {
  ensureRuntimeDir();
  for (const [name, svc] of Object.entries(services)) {
    const existing = await statusOne(name, svc);
    if (existing.health.ok) {
      console.log(`${name}: already online at http://127.0.0.1:${svc.port}`);
      continue;
    }
    if (existing.owned) {
      console.log(`${name}: launcher pid ${existing.pid} exists but health is not ready; check ${path.relative(ROOT, logFile(name))}`);
      continue;
    }

    const out = fs.openSync(logFile(name), 'a');
    const child = spawn(process.execPath, [svc.script], {
      cwd: svc.cwd,
      env: { ...process.env, ...svc.env },
      detached: true,
      stdio: ['ignore', out, out],
    });
    child.unref();
    fs.writeFileSync(pidFile(name), `${child.pid}\n`);
    console.log(`${name}: started pid ${child.pid}`);
    await waitForHealth(name, svc.port);
  }
  console.log(`\nOpen the dashboard: http://127.0.0.1:${ports.provider}/dashboard`);
  console.log(`Use API key in the dashboard tester: ${providerKey}`);
}

async function down() {
  ensureRuntimeDir();
  for (const [name] of Object.entries(services).reverse()) {
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

async function main() {
  const command = process.argv[2] || 'status';
  if (command === 'up') return up();
  if (command === 'down') return down();
  if (command === 'status') return status();
  console.error('Usage: npm run bridge:up | bridge:down | bridge:status');
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
