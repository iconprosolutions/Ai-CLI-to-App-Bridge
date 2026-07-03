'use strict';

// In-memory request telemetry + passive engine health history, carried over
// from the legacy provider (Phase 0 abort semantics included). Phase 3 adds
// the durable usage ledger next to this; Phase 4 moves health sampling to a
// server-side interval.

function classForStatus(status) {
  if (status === 200) return 'success';
  if (status === 429) return 'rejected';
  if (status === 499) return 'aborted'; // client walked away; not an engine fault
  if (status >= 400 && status < 500) return 'client_error';
  if (status >= 500) return 'server_error';
  return 'error';
}

function createTelemetry({ engines = ['claude', 'gemini'], maxRecent = 200, healthMax = 240 } = {}) {
  const recentRequests = [];
  const healthHistory = {};
  for (const e of engines) healthHistory[e] = [];
  let toolRetries = 0; // corrective retries fired for malformed/absent tool calls

  function recordHealthSample(engine, ok, source) {
    const arr = healthHistory[engine];
    if (!arr) return;
    arr.push({ at: new Date().toISOString(), ok: Boolean(ok), source: source || 'health' });
    if (arr.length > healthMax) arr.splice(0, arr.length - healthMax);
  }

  function computePerEngineHealth() {
    return Object.keys(healthHistory).map((engine) => {
      const arr = healthHistory[engine];
      const total = arr.length;
      const okCount = arr.reduce((n, s) => n + (s.ok ? 1 : 0), 0);
      let lastErrorAt = null;
      for (let i = arr.length - 1; i >= 0; i -= 1) {
        if (!arr[i].ok) { lastErrorAt = arr[i].at; break; }
      }
      return {
        engine,
        uptimePct: total ? Math.round((okCount / total) * 1000) / 10 : null,
        sampleCount: total,
        lastErrorAt,
      };
    });
  }

  // entry: {id, appId, aliasUsed, routeId, label, engine, status, durationMs,
  //         estPromptTokens, estCompletionTokens, usageSource?}
  function record(entry) {
    const cls = classForStatus(entry.status);
    recentRequests.unshift({
      at: new Date().toISOString(),
      statusClass: cls,
      estTotalTokens: (entry.estPromptTokens || 0) + (entry.estCompletionTokens || 0),
      ...entry,
    });
    recentRequests.splice(maxRecent);
    // Only engine-attributable outcomes feed health: success and 5xx/504.
    // Busy rejections, client errors, and aborts say nothing about the
    // engine (quota-degradation tracking is the Phase 4 breaker's job,
    // which sees the error kind, not just the status).
    if (entry.engine) {
      if (cls === 'success') recordHealthSample(entry.engine, true, 'traffic');
      else if (cls === 'server_error') recordHealthSample(entry.engine, false, 'traffic');
    }
  }

  function computeTelemetry(maxConcurrent) {
    let success = 0;
    let error = 0;
    let latencySum = 0;
    let latencyN = 0;
    let estPrompt = 0;
    let estCompletion = 0;
    const perEngine = {};
    const perRoute = {};
    const perApp = {};
    const tokensByEngine = {};
    const latestErrors = [];

    for (const r of recentRequests) {
      if (r.statusClass === 'success') success += 1;
      else error += 1;
      if (typeof r.durationMs === 'number') {
        latencySum += r.durationMs;
        latencyN += 1;
      }
      estPrompt += r.estPromptTokens || 0;
      estCompletion += r.estCompletionTokens || 0;

      if (r.engine) {
        perEngine[r.engine] = (perEngine[r.engine] || 0) + 1;
        const t = tokensByEngine[r.engine] || (tokensByEngine[r.engine] = { prompt: 0, completion: 0, total: 0 });
        t.prompt += r.estPromptTokens || 0;
        t.completion += r.estCompletionTokens || 0;
        t.total += r.estTotalTokens || 0;
      }

      if (r.routeId) {
        const e = perRoute[r.routeId] || (perRoute[r.routeId] = {
          routeId: r.routeId, label: r.label, engine: r.engine, count: 0, success: 0, error: 0, estTokens: 0,
        });
        e.count += 1;
        if (r.statusClass === 'success') e.success += 1; else e.error += 1;
        e.estTokens += r.estTotalTokens || 0;
      }

      const appKey = r.appId || 'default';
      const a = perApp[appKey] || (perApp[appKey] = {
        appId: appKey, count: 0, success: 0, error: 0, estPromptTokens: 0, estCompletionTokens: 0, estTokens: 0, latencySum: 0, latencyN: 0,
      });
      a.count += 1;
      if (r.statusClass === 'success') a.success += 1; else a.error += 1;
      a.estPromptTokens += r.estPromptTokens || 0;
      a.estCompletionTokens += r.estCompletionTokens || 0;
      a.estTokens += r.estTotalTokens || 0;
      a.latencySum += r.durationMs || 0;
      a.latencyN += 1;

      if (r.statusClass !== 'success') latestErrors.push(r);
    }

    const perAppList = Object.values(perApp)
      .map((a) => ({
        appId: a.appId, count: a.count, success: a.success, error: a.error,
        estPromptTokens: a.estPromptTokens, estCompletionTokens: a.estCompletionTokens,
        estTokens: a.estTokens, avgLatencyMs: a.latencyN ? Math.round(a.latencySum / a.latencyN) : 0,
      }))
      .sort((x, y) => y.count - x.count);

    return {
      label: 'Local request telemetry',
      note: 'Token counts are real where the engine reports them (claude stream-json); otherwise a ~4 chars/token estimate.',
      recentCount: recentRequests.length,
      successCount: success,
      errorCount: error,
      successRate: recentRequests.length ? Math.round((success / recentRequests.length) * 1000) / 1000 : null,
      avgLatencyMs: latencyN ? Math.round(latencySum / latencyN) : 0,
      maxConcurrent,
      toolRetries,
      perEngine,
      tokensByEngine,
      perRoute: Object.values(perRoute)
        .map((e) => ({ routeId: e.routeId, label: e.label, engine: e.engine, count: e.count, success: e.success, error: e.error, estTokens: e.estTokens }))
        .sort((x, y) => y.count - x.count),
      perApp: perAppList,
      estPromptTokens: estPrompt,
      estCompletionTokens: estCompletion,
      estTotalTokens: estPrompt + estCompletion,
      latestErrors: latestErrors.slice(0, 10),
      perEngineHealth: computePerEngineHealth(),
    };
  }

  return {
    recentRequests,
    healthHistory,
    recordHealthSample,
    computePerEngineHealth,
    computeTelemetry,
    record,
    recordToolRetry: () => { toolRetries += 1; },
    classForStatus,
  };
}

module.exports = { createTelemetry, classForStatus };
