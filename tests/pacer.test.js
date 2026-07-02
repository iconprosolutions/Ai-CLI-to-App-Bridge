// Unit tests for the smooth streaming pacer. Run: node tests/pacer.test.js
const { createSmoothPacer } = require('../provider-bridge/pacer');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; console.log(`  PASS  ${msg}`); }
  else { failed += 1; console.error(`  FAIL  ${msg}`); }
}

async function main() {
  console.log('# Pacer — verification');

  // 1. Lossless tokenization: emitted tokens re-join to the exact input,
  //    including pipes, hyphens, and unicode (the v1 regex ate `|`).
  {
    let out = '';
    const p = createSmoothPacer((t) => { out += t; }, { delayMs: 0 });
    const input = 'col A | col B | col-C\nrow1  | x | 😀 — done';
    p.push(input);
    await p.drain();
    assert(out === input, `lossless tokens (got ${JSON.stringify(out.slice(0, 40))}…)`);
  }

  // 2. stop() halts emission immediately and drain() unblocks.
  {
    let count = 0;
    const p = createSmoothPacer(() => { count += 1; }, { delayMs: 5 });
    p.push('one two three four five six seven eight nine ten');
    await new Promise((r) => setTimeout(r, 12));
    p.stop();
    const atStop = count;
    await p.drain();
    await new Promise((r) => setTimeout(r, 30));
    assert(count === atStop && count < 10, `stop() halts emission (emitted ${count})`);
  }

  // 3. Adaptive delay: a huge flush must finish within the total budget,
  //    not at 10ms/token (v1 would take ~100s for 10k tokens).
  {
    let out = '';
    const p = createSmoothPacer((t) => { out += t; }, { delayMs: 10, maxTotalDelayMs: 500 });
    const big = 'word '.repeat(10000);
    const t0 = Date.now();
    p.push(big);
    await p.drain();
    const took = Date.now() - t0;
    assert(out === big, 'big flush is lossless');
    assert(took < 2000, `big flush drains within budget (${took}ms, budget 500ms + overhead)`);
  }

  // 4. push() after stop() is a no-op.
  {
    let out = '';
    const p = createSmoothPacer((t) => { out += t; }, { delayMs: 0 });
    p.stop();
    p.push('nope');
    await p.drain();
    assert(out === '', 'push after stop is dropped');
  }

  console.log(`\n# Result: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
