#!/usr/bin/env node
// Scriptable fake CLI for contract tests. Mode via FAKE_CLI_MODE env or argv[2].
//   echo-stdin  — read all of stdin, echo it to stdout
//   utf8-split  — emit 😀 (F0 9F 98 80) split across two writes
//   ansi-split  — emit ANSI-colored text with the CSI sequence split across writes
//   flood       — write FAKE_CLI_BYTES (default 500000) bytes of 'x'
//   hang        — never exit (until killed)
//   stderr-fail — write FAKE_CLI_STDERR (default 'quota exhausted') to stderr, exit 2
//   ok          — print 'ok' and exit 0

const mode = process.env.FAKE_CLI_MODE || process.argv[2] || 'ok';

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (mode === 'echo-stdin') {
    let data = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) data += chunk;
    process.stdout.write(data);
    return;
  }
  if (mode === 'utf8-split') {
    process.stdout.write(Buffer.from([0xf0, 0x9f, 0x98]));
    await delay(120);
    process.stdout.write(Buffer.from([0x80, 0x0a]));
    return;
  }
  if (mode === 'ansi-split') {
    // "\x1b[32mgreen\x1b[0m done" with the reset sequence split mid-escape.
    process.stdout.write('\x1b[32mgreen\x1b[');
    await delay(120);
    process.stdout.write('0m done\n');
    return;
  }
  if (mode === 'flood') {
    const total = Number(process.env.FAKE_CLI_BYTES) || 500000;
    const chunk = 'x'.repeat(8192);
    let written = 0;
    while (written < total) {
      const n = Math.min(chunk.length, total - written);
      process.stdout.write(chunk.slice(0, n));
      written += n;
      // eslint-disable-next-line no-await-in-loop
      if (written % (8192 * 8) === 0) await delay(1);
    }
    return;
  }
  if (mode === 'hang') {
    setInterval(() => {}, 1 << 30);
    return;
  }
  if (mode === 'stderr-fail') {
    process.stderr.write(process.env.FAKE_CLI_STDERR || 'quota exhausted');
    process.exit(2);
  }
  process.stdout.write('ok\n');
}

main();
