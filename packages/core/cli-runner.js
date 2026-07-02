'use strict';

const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { BridgeError } = require('./errors');

// Every live CLI child in this process, so shutdown can reap them all —
// a bridge dying mid-request must never orphan a quota-burning CLI run.
const registry = new Set();

function liveChildren() {
  return registry.size;
}

function killAllChildren(signal = 'SIGTERM') {
  const n = registry.size;
  for (const child of registry) {
    try { child.kill(signal); } catch (_) { /* already gone */ }
  }
  return n;
}

let shutdownInstalled = false;

// SIGTERM/SIGINT: stop accepting HTTP, SIGTERM all CLI children, SIGKILL
// stragglers after the grace period, then exit. Idempotent.
function installGracefulShutdown({ server = null, logger = console, killGraceMs = 2000 } = {}) {
  if (shutdownInstalled) return;
  shutdownInstalled = true;
  let shuttingDown = false;
  const onSignal = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`[shutdown] ${sig}: closing server, terminating ${registry.size} CLI child(ren)`);
    if (server) {
      try { server.close(() => {}); } catch (_) { /* already closed */ }
    }
    killAllChildren('SIGTERM');
    const hard = setTimeout(() => {
      killAllChildren('SIGKILL');
      process.exit(0);
    }, killGraceMs);
    hard.unref();
    setTimeout(() => process.exit(0), killGraceMs + 500).unref();
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
}

// The one hardened way to run a CLI. See spec §4.1.
//   - stdin: string|null — piped and closed (never argv: ARG_MAX + `ps` leak)
//   - signal: AbortSignal|null — abort kills the child and rejects 'aborted'
//   - timeoutMs: wall clock — SIGTERM → killGraceMs → SIGKILL, rejects 'timeout'
//   - maxBytes: byte-accurate output cap; over-cap kills child, resolves truncated
//   - onDelta(str): StringDecoder'd stdout increments (no split multibyte chars)
//   - classifyError(stderr, stdout): BridgeError|null — refines nonzero exits
// Resolves { text, stderr, exitCode, truncated }.
function runCli(bin, args, opts = {}) {
  const {
    stdin = null,
    signal = null,
    timeoutMs = 5 * 60 * 1000,
    maxBytes = 10 * 1024 * 1024,
    onDelta = null,
    classifyError = null,
    cwd = undefined,
    env = undefined,
    killGraceMs = 2000,
  } = opts;

  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      return reject(new BridgeError('aborted', 'Request aborted before spawn'));
    }

    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        env: env || process.env,
        stdio: [stdin === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      return reject(new BridgeError('spawn_failed', `Failed to spawn ${bin}: ${err.message}`));
    }
    registry.add(child);

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const outDec = new StringDecoder('utf8');
    const errDec = new StringDecoder('utf8');
    let settled = false;
    let truncated = false;
    let timer = null;

    const onAbort = () => {
      escalate();
      settle(true, new BridgeError('aborted', 'Request aborted'));
    };

    const settle = (isErr, payload) => {
      if (settled) return;
      settled = true;
      registry.delete(child);
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (isErr) reject(payload);
      else resolve(payload);
    };

    const escalate = () => {
      try { child.kill('SIGTERM'); } catch (_) { /* already gone */ }
      const hard = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
      }, killGraceMs);
      hard.unref();
    };

    timer = setTimeout(() => {
      escalate();
      settle(true, new BridgeError('timeout', `${bin} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    if (timer.unref) timer.unref();

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    if (stdin !== null) {
      child.stdin.on('error', () => {}); // CLI may exit before reading; EPIPE is fine
      child.stdin.end(stdin);
    }

    child.stdout.on('data', (data) => {
      const room = maxBytes - stdoutBytes;
      if (room <= 0) return;
      const slice = data.length > room ? data.subarray(0, room) : data;
      stdoutBytes += slice.length;
      const str = outDec.write(slice);
      if (str) {
        stdout += str;
        if (typeof onDelta === 'function') onDelta(str);
      }
      if (stdoutBytes >= maxBytes && !truncated) {
        truncated = true;
        escalate();
      }
    });

    child.stderr.on('data', (data) => {
      const room = maxBytes - stderrBytes;
      if (room <= 0) return;
      const slice = data.length > room ? data.subarray(0, room) : data;
      stderrBytes += slice.length;
      stderr += errDec.write(slice);
    });

    child.on('close', (code) => {
      stdout += outDec.end();
      stderr += errDec.end();
      if (settled) return; // timeout/abort already rejected; child is now reaped
      if (truncated || code === 0) {
        return settle(false, { text: stdout, stderr, exitCode: code, truncated });
      }
      let err = typeof classifyError === 'function' ? classifyError(stderr, stdout) : null;
      if (!err) {
        err = new BridgeError('bad_output', (stderr.trim() || stdout.trim() || `${bin} exited with code ${code}`));
      }
      err.stderr = stderr;
      err.stdout = stdout;
      err.exitCode = code;
      settle(true, err);
    });

    child.on('error', (err) => {
      settle(true, new BridgeError('spawn_failed', `Failed to spawn ${bin}: ${err.message}`));
    });
  });
}

module.exports = { runCli, liveChildren, killAllChildren, installGracefulShutdown };
