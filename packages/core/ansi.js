'use strict';

// Complete ANSI escape sequences: CSI (ESC [ params cmd), OSC (ESC ] ...
// terminated by BEL or ST), and single-shift/two-char escapes. CLIs emit
// these even in "headless" modes (colors, spinner frames, terminal titles).
// eslint-disable-next-line no-control-regex
const ANSI_COMPLETE = /\x1B(?:\[[0-9;:?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;

// A trailing fragment that could still grow into a full sequence — must be
// held back when streaming, not emitted half-stripped.
// eslint-disable-next-line no-control-regex
const ANSI_PARTIAL_TAIL = /^\x1B(?:\[[0-9;:?]*[ -/]*$|\][^\x07\x1B]*$|$)/;

function stripAnsi(str) {
  return String(str).replace(ANSI_COMPLETE, '');
}

// Streaming stripper: write() returns text that is safe to emit now; a
// sequence split across chunk boundaries is carried and removed once
// complete. end() flushes whatever remains.
function createAnsiStripper() {
  let carry = '';
  return {
    write(chunk) {
      let s = carry + String(chunk);
      carry = '';
      const lastEsc = s.lastIndexOf('\x1B');
      if (lastEsc !== -1) {
        const tail = s.slice(lastEsc);
        ANSI_COMPLETE.lastIndex = 0;
        const m = ANSI_COMPLETE.exec(tail);
        const complete = m && m.index === 0 && m[0].length === tail.length;
        if (!complete && ANSI_PARTIAL_TAIL.test(tail)) {
          carry = tail;
          s = s.slice(0, lastEsc);
        }
      }
      return stripAnsi(s);
    },
    end() {
      const rest = carry;
      carry = '';
      const cleaned = stripAnsi(rest);
      // A still-unterminated escape at stream end is CLI noise — drop it.
      return ANSI_PARTIAL_TAIL.test(cleaned) ? '' : cleaned;
    },
  };
}

// Spinner frames arrive as "frame1\rframe2\rfinal". In a terminal \r
// overwrites; in captured text it duplicates. Keep only the last segment of
// each line. Apply to FINAL text only — never to live deltas, where the last
// frame isn't known yet.
function collapseCarriageReturns(text) {
  return String(text)
    .split('\n')
    .map((line) => {
      const i = line.lastIndexOf('\r');
      return i === -1 ? line : line.slice(i + 1);
    })
    .join('\n');
}

module.exports = { stripAnsi, createAnsiStripper, collapseCarriageReturns };
