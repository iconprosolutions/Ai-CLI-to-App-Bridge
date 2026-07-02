'use strict';

const { stripAnsi } = require('./ansi');
const { BridgeError } = require('./errors');

// Extract a JSON value from model/CLI output that may include ANSI noise,
// markdown fences, preamble, or trailing prose. Throws BridgeError
// ('bad_output') when nothing parseable is found.
function extractJson(raw) {
  let text = stripAnsi(String(raw)).trim();
  text = text.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    return JSON.parse(text);
  } catch (_) {
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');
    let start = -1;
    if (firstBrace !== -1 && firstBracket !== -1) {
      start = Math.min(firstBrace, firstBracket);
    } else {
      start = firstBrace !== -1 ? firstBrace : firstBracket;
    }
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (start !== -1 && end !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch (__) {
        // fall through
      }
    }
    throw new BridgeError('bad_output', 'Could not extract valid JSON from model output', {
      detail: text.slice(0, 200),
    });
  }
}

module.exports = { extractJson };
