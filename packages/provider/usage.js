'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// Durable usage ledger: append-only JSONL, one line per routed request,
// bodies never written. Survives restarts — this is what the dashboard's
// Usage tab reads. Files rotate monthly (YYYY-MM.jsonl).
function monthKey(d = new Date()) {
  return d.toISOString().slice(0, 7);
}

function createUsageLedger({
  dir,
  pricingFile,
  flushMs = Number(process.env.USAGE_FLUSH_MS) || 2000,
  maxBuffer = 50,
} = {}) {
  fs.mkdirSync(dir, { recursive: true });
  let pricing = { models: {}, default: { input: 1, output: 5 } };
  try {
    pricing = JSON.parse(fs.readFileSync(pricingFile, 'utf8'));
  } catch (_) { /* pricing is optional; $-equivalents fall back to default */ }

  let buffer = [];
  let timer = null;
  const fileFor = (mk) => path.join(dir, `${mk}.jsonl`);

  function flushSync() {
    if (!buffer.length) return;
    const lines = `${buffer.map((e) => JSON.stringify(e)).join('\n')}\n`;
    buffer = [];
    try { fs.appendFileSync(fileFor(monthKey()), lines); } catch (_) { /* best effort at exit */ }
  }

  async function flush() {
    if (!buffer.length) return;
    const lines = `${buffer.map((e) => JSON.stringify(e)).join('\n')}\n`;
    buffer = [];
    try {
      await fsp.appendFile(fileFor(monthKey()), lines);
    } catch (err) {
      console.error(`[usage] ledger write failed: ${err.message}`);
    }
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, flushMs);
    timer.unref();
  }

  process.on('exit', flushSync);

  function append(entry) {
    buffer.push({ ts: new Date().toISOString(), ...entry });
    if (buffer.length >= maxBuffer) flush();
    else schedule();
  }

  const priceFor = (model) => (pricing.models && pricing.models[model]) || pricing.default || { input: 0, output: 0 };

  // API-equivalent dollar value of one request — the same math aggregate()
  // uses, exposed so per-key spend limits count identically.
  function costOf(model, promptTokens, completionTokens) {
    const price = priceFor(model);
    return ((promptTokens || 0) / 1e6) * (price.input || 0) + ((completionTokens || 0) / 1e6) * (price.output || 0);
  }

  function cutoffFor(range) {
    const now = Date.now();
    if (range === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
    if (range === 'month') { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(1); return d.getTime(); } // calendar month
    if (range === '7d') return now - 7 * 864e5;
    if (range === '30d') return now - 30 * 864e5;
    return 0; // 'all'
  }

  async function readEntries(range) {
    const cutoff = cutoffFor(range);
    let names = [];
    try {
      names = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
    } catch (_) { names = []; }
    const cutoffMonth = cutoff ? new Date(cutoff).toISOString().slice(0, 7) : '';
    const out = [];
    for (const f of names) {
      if (cutoffMonth && f.replace('.jsonl', '') < cutoffMonth) continue;
      let text;
      try { text = await fsp.readFile(path.join(dir, f), 'utf8'); } catch (_) { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let e;
        try { e = JSON.parse(line); } catch (_) { continue; }
        if (cutoff && Date.parse(e.ts) < cutoff) continue;
        out.push(e);
      }
    }
    for (const e of buffer) {
      if (!cutoff || Date.parse(e.ts) >= cutoff) out.push(e);
    }
    return out;
  }

  // opts.ownerOf: keyName → username resolver (keys.js) for the per-user
  // rollup; opts.keyFilter: restrict to a set of key names (a user's own view).
  async function aggregate(range = '7d', opts = {}) {
    let entries = await readEntries(range);
    if (opts.keyFilter) entries = entries.filter((e) => opts.keyFilter.has(e.keyName));
    const round = (n) => Math.round(n * 100) / 100;
    const totals = { requests: 0, promptTokens: 0, completionTokens: 0, apiEquivalentUsd: 0, errors: 0 };
    const perApp = new Map();
    const perRoute = new Map();
    const perDay = new Map();
    const perAccount = new Map();
    const perKey = new Map();
    const perUser = new Map();

    // Shared accumulator for the account/key dimensions (same shape as perApp
    // minus the per-app-only accuracy detail).
    const bump = (map, id, field, pt, ct, usd, success) => {
      const row = map.get(id) || { [field]: id, requests: 0, promptTokens: 0, completionTokens: 0, usd: 0, errors: 0 };
      row.requests += 1;
      row.promptTokens += pt;
      row.completionTokens += ct;
      row.usd += usd;
      if (!success) row.errors += 1;
      map.set(id, row);
    };

    for (const e of entries) {
      const pt = e.promptTokens || 0;
      const ct = e.completionTokens || 0;
      const usd = costOf(e.model, pt, ct);
      const success = e.status === 200;

      totals.requests += 1;
      totals.promptTokens += pt;
      totals.completionTokens += ct;
      totals.apiEquivalentUsd += usd;
      if (!success) totals.errors += 1;

      const appKey = e.appId || 'default';
      const a = perApp.get(appKey) || {
        appId: appKey, requests: 0, promptTokens: 0, completionTokens: 0, usd: 0, errors: 0, realCount: 0, latencySum: 0,
      };
      a.requests += 1;
      a.promptTokens += pt;
      a.completionTokens += ct;
      a.usd += usd;
      if (!success) a.errors += 1;
      if (e.usageSource === 'real') a.realCount += 1;
      a.latencySum += e.durationMs || 0;
      perApp.set(appKey, a);

      bump(perAccount, e.account || 'default', 'account', pt, ct, usd, success);
      bump(perKey, e.keyName || 'legacy', 'keyName', pt, ct, usd, success);
      if (opts.ownerOf) {
        bump(perUser, (e.keyName && opts.ownerOf(e.keyName)) || 'unowned', 'user', pt, ct, usd, success);
      }

      if (e.routeId) {
        const r = perRoute.get(e.routeId) || { routeId: e.routeId, engine: e.engine, requests: 0, tokens: 0, usd: 0 };
        r.requests += 1;
        r.tokens += pt + ct;
        r.usd += usd;
        perRoute.set(e.routeId, r);
      }

      const day = String(e.ts).slice(0, 10);
      const d = perDay.get(day) || { date: day, byEngine: {} };
      if (e.engine) d.byEngine[e.engine] = (d.byEngine[e.engine] || 0) + pt + ct;
      perDay.set(day, d);
    }

    totals.apiEquivalentUsd = round(totals.apiEquivalentUsd);
    return {
      range,
      note: "API-equivalent value uses editable pricing.json list prices — your subscriptions are flat-rate; this shows what the same usage would have cost on the API.",
      totals,
      perApp: [...perApp.values()].map((a) => ({
        appId: a.appId,
        requests: a.requests,
        promptTokens: a.promptTokens,
        completionTokens: a.completionTokens,
        apiEquivalentUsd: round(a.usd),
        errors: a.errors,
        avgLatencyMs: a.requests ? Math.round(a.latencySum / a.requests) : 0,
        usageAccuracy: a.realCount === a.requests ? 'real' : (a.realCount > 0 ? 'mixed' : 'estimated'),
      })).sort((x, y) => y.requests - x.requests),
      perRoute: [...perRoute.values()].map((r) => ({
        routeId: r.routeId, engine: r.engine, requests: r.requests, tokens: r.tokens, apiEquivalentUsd: round(r.usd),
      })).sort((x, y) => y.requests - x.requests),
      perAccount: [...perAccount.values()].map((a) => ({
        account: a.account, requests: a.requests, promptTokens: a.promptTokens, completionTokens: a.completionTokens, apiEquivalentUsd: round(a.usd), errors: a.errors,
      })).sort((x, y) => y.requests - x.requests),
      perKey: [...perKey.values()].map((k) => ({
        keyName: k.keyName, requests: k.requests, promptTokens: k.promptTokens, completionTokens: k.completionTokens, apiEquivalentUsd: round(k.usd), errors: k.errors,
      })).sort((x, y) => y.requests - x.requests),
      perUser: opts.ownerOf ? [...perUser.values()].map((u) => ({
        user: u.user, requests: u.requests, promptTokens: u.promptTokens, completionTokens: u.completionTokens, apiEquivalentUsd: round(u.usd), errors: u.errors,
      })).sort((x, y) => y.requests - x.requests) : undefined,
      perDay: [...perDay.values()].sort((x, y) => (x.date < y.date ? -1 : 1)),
    };
  }

  return { append, flush, flushSync, aggregate, costOf, dir };
}

module.exports = { createUsageLedger };
