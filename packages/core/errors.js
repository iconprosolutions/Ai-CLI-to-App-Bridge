'use strict';

// Typed failure taxonomy for everything that can go wrong between an HTTP
// request and a CLI subprocess. Adapters classify raw CLI failures into one
// of these kinds; the provider edge maps kinds to HTTP statuses exactly once.
const KINDS = [
  'quota', // subscription/rate capacity exhausted — retryable later
  'model_not_found', // model absent from this account/CLI install
  'timeout', // CLI exceeded its wall-clock budget
  'spawn_failed', // binary missing, E2BIG, permissions
  'truncated', // output hit the byte cap (usually surfaced as success+flag)
  'bad_output', // CLI succeeded/failed with unusable output
  'invalid_request', // caller error caught before spawning (e.g. oversized prompt)
  'auth', // the CLI account is logged out / credentials expired — needs operator action
  'aborted', // the caller walked away — never an engine fault
];

class BridgeError extends Error {
  constructor(kind, message, opts = {}) {
    if (!KINDS.includes(kind)) {
      throw new TypeError(`Unknown BridgeError kind: ${kind}`);
    }
    super(message);
    this.name = 'BridgeError';
    this.kind = kind;
    // Raw opts, kept verbatim so callers can read ad-hoc fields (e.g. the
    // quota cooldown deadline an adapter parsed off a reset header) without
    // this constructor having to know every field name up front.
    this.data = opts;
    if (opts.detail !== undefined) this.detail = opts.detail;
    if (opts.retryAfterSec !== undefined) this.retryAfterSec = opts.retryAfterSec;
    // Optional fine-grained tag within a kind (e.g. 'prompt_overflow' inside
    // invalid_request) so the edge can special-case without string matching.
    if (opts.code !== undefined) this.code = opts.code;
  }
}

// HTTP mapping used at the provider edge. `type`/`param` follow the OpenAI
// error envelope; `retryAfterSec` becomes a Retry-After header when set.
function httpFor(err) {
  const kind = err instanceof BridgeError ? err.kind : null;
  switch (kind) {
    case 'quota':
      return { status: 429, type: 'rate_limit_error', param: null, retryAfterSec: err.retryAfterSec || 60 };
    case 'timeout':
      return { status: 504, type: 'upstream_timeout', param: null, retryAfterSec: null };
    case 'model_not_found':
      return { status: 400, type: 'invalid_model', param: 'model', retryAfterSec: null };
    case 'invalid_request':
      return { status: 400, type: 'invalid_request_error', param: null, retryAfterSec: null };
    case 'auth':
      return { status: 503, type: 'engine_auth_error', param: null, retryAfterSec: null };
    case 'aborted':
      return { status: 499, type: null, param: null, retryAfterSec: null };
    case 'spawn_failed':
    case 'truncated':
    case 'bad_output':
    default:
      return { status: 502, type: 'upstream_error', param: null, retryAfterSec: null };
  }
}

module.exports = { BridgeError, KINDS, httpFor };
