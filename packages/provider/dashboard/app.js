/* AI CLI Bridge — Control Center. No build step, no dependencies.
   Data: /dashboard/status (state), /dashboard/events (SSE push),
   /dashboard/usage (ledger rollups), /admin/* (key-gated actions),
   /v1/chat/completions (tester). */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var state = {
    status: null,
    usage: null,
    usageRange: '7d',
    usageDim: 'app',
    view: 'overview',
    live: true,
    compare: false,
    transport: 'stream',
    rf: 'text',
    snip: 'hermes',
    capSelected: null,
    history: [],
  };

  var key = function () { return localStorage.getItem('providerApiKey') || ''; };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(n) { return (Number(n) || 0).toLocaleString('en-US'); }
  function ftok(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
  }
  function tval(d) { return new Date(d).toLocaleTimeString(); }
  function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }
  function prettyPlan(p) {
    if (!p) return '';
    return String(p).replace(/^claude[_-]?/i, '').replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  }
  // Renders "who is signed in" for an account; flags a blank/expired login.
  function identityHtml(id) {
    if (!id || !id.email) return '<span class="idwarn">not signed in</span>';
    var sub = [];
    if (id.org) sub.push(esc(id.org));
    if (id.plan) sub.push(esc(prettyPlan(id.plan)));
    return '<span class="idmail">' + esc(id.email) + '</span>' + (sub.length ? '<div class="sub2">' + sub.join(' · ') + '</div>' : '');
  }

  // ── Transport ─────────────────────────────────────────────────────────
  // When DASHBOARD_AUTH=1 on the server (tunnel/public exposure), the data
  // endpoints require an admin key — sent as a Bearer header here and as
  // ?key= on the EventSource (which can't set headers).
  function authHeaders() { return key() ? { 'Authorization': 'Bearer ' + key() } : {}; }
  function showLocked() {
    setLive(false);
    $('livelabel').textContent = 'Locked';
    $('login-overlay').style.display = 'flex';
  }
  function fetchStatus() {
    return fetch('/dashboard/status', { headers: authHeaders() }).then(function (r) {
      if (r.status === 401) { showLocked(); return null; }
      return r.json();
    }).then(function (d) {
      if (!d) return;
      state.status = d;
      renderAll();
    }).catch(function () { setLive(false); });
  }
  function fetchUsage() {
    return fetch('/dashboard/usage?range=' + state.usageRange, { headers: authHeaders() }).then(function (r) {
      return r.status === 401 ? null : r.json();
    }).then(function (d) {
      if (!d) return;
      state.usage = d;
      renderUsage();
      if (state.view === 'overview') renderTiles();
    }).catch(function () {});
  }

  var refreshTimer = null;
  function throttledRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(function () {
      refreshTimer = null;
      fetchStatus();
      if (state.view === 'usage' || state.view === 'overview') fetchUsage();
    }, 500);
  }

  var es = null;
  var pollTimer = null;
  function setLive(ok) {
    state.live = ok;
    $('livedot').className = 'pl' + (ok ? '' : ' dead');
    $('livelabel').textContent = ok ? 'Live' : 'Polling';
  }
  function connectEvents() {
    try {
      es = new EventSource('/dashboard/events' + (key() ? '?key=' + encodeURIComponent(key()) : ''));
      ['request.start', 'request.end', 'breaker.change', 'engine.health', 'capture.change', 'account.change', 'keys.change', 'users.change'].forEach(function (t) {
        es.addEventListener(t, throttledRefresh);
      });
      es.onopen = function () { setLive(true); if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
      es.onerror = function () {
        setLive(false);
        if (!pollTimer) pollTimer = setInterval(fetchStatus, 10000);
      };
    } catch (_) {
      setLive(false);
      pollTimer = setInterval(fetchStatus, 10000);
    }
  }

  function admin(method, path, body) {
    return fetch(path, {
      method: method,
      headers: { 'Authorization': 'Bearer ' + key(), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (r) {
      if (r.status === 401 || r.status === 503) {
        alert('Admin action rejected (' + r.status + '). Set your API key in the Connect tab.');
        throw new Error('unauthorized');
      }
      return r.json().then(function (j) {
        if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
        return j;
      });
    });
  }

  // ── Header ────────────────────────────────────────────────────────────
  function engineVerdict(e, s) {
    if (!s) return { cls: 'off', label: 'UNKNOWN' };
    if (s.breakers && s.breakers[e] && s.breakers[e].state === 'open') return { cls: 'down', label: 'BLOCKED' };
    if (s.engines[e] && s.engines[e].disabled) return { cls: 'off', label: 'OFF' };
    if (!s.engines[e] || !s.engines[e].ok) return { cls: 'down', label: 'DOWN' };
    if ((s.inflight[e] || 0) > 0) return { cls: 'warn', label: 'BUSY' };
    return { cls: 'ok', label: 'READY' };
  }

  function renderHeader() {
    var s = state.status;
    if (!s) return;
    $('verdicts').innerHTML = Object.keys(s.engines).map(function (e) {
      var v = engineVerdict(e, s);
      return '<span class="verdict"><span class="dot ' + v.cls + '"></span><span class="vk">' + esc(e) + '</span><span class="vv ' + v.cls + '">' + v.label + '</span></span>';
    }).join('');
    var inf = Object.keys(s.inflight).map(function (e) { return s.inflight[e]; }).join(' / ');
    $('v-inflight').textContent = inf;
    $('cnt-routes').textContent = (s.routes || []).length;
    $('cnt-accounts').textContent = Object.keys(s.accounts || {}).reduce(function (n, e) { return n + s.accounts[e].length; }, 0) || '';
    $('cnt-capture').textContent = s.capture && s.capture.enabled ? (s.capture.count + ' held') : '';
    $('foot-note').textContent = (s.authEnabled ? 'auth enabled' : 'open') + ' · local';
  }

  // ── Overview ──────────────────────────────────────────────────────────
  function renderBanner() {
    var s = state.status;
    var open = Object.keys(s.breakers || {}).filter(function (e) { return s.breakers[e].state !== 'closed'; });
    $('ov-banner').innerHTML = open.length ? open.map(function (e) {
      var b = s.breakers[e];
      return '<div class="banner"><span class="bi"></span><span class="bt"><strong>' + esc(e) + ' circuit ' + esc(b.state) + '</strong> — '
        + esc(b.reason || 'capacity') + ' exhaustion. Requests fail fast with 429. Retry in ~' + b.retryInSec + 's.</span>'
        + '<span class="bactions"><button class="abtn primary" data-act="breaker-reset" data-engine="' + esc(e) + '">Reset breaker</button></span></div>';
    }).join('') : '';
  }

  function uptimeStrip(history) {
    var arr = (history || []).slice(-30);
    var out = '';
    for (var i = 0; i < 30 - arr.length; i++) out += '<i class="ub i"></i>';
    arr.forEach(function (h) { out += '<i class="ub' + (h.ok ? '' : ' b') + '"></i>'; });
    return out;
  }

  function engineIdentityCell(e) {
    var accts = (state.status.accounts && state.status.accounts[e]) || [];
    if (!accts.length) return '<span class="sub2">no account</span>';
    if (accts.length === 1) return identityHtml(accts[0].identity);
    var signedIn = accts.filter(function (a) { return a.identity && a.identity.email; }).length;
    return '<span class="idmail">' + accts.length + ' accounts</span> <span class="sub2">' + signedIn + ' signed in · see Accounts tab</span>';
  }
  function renderEngines() {
    var s = state.status;
    var lastErrByEngine = {};
    (s.telemetry.latestErrors || []).forEach(function (r) {
      if (r.engine && !lastErrByEngine[r.engine]) lastErrByEngine[r.engine] = r;
    });
    $('ov-engines').innerHTML = Object.keys(s.engines).map(function (e) {
      var eng = s.engines[e];
      var v = engineVerdict(e, s);
      var b = s.breakers[e];
      var active = (s.activeRequests || []).filter(function (a) { return a.engine === e; });
      var lastErr = lastErrByEngine[e];
      var pips = '';
      var max = s.telemetry.maxConcurrent || 1;
      for (var i = 0; i < max; i++) pips += '<span class="pip' + (i < (s.inflight[e] || 0) ? ' on' : '') + '"></span>';
      var badgeCls = v.cls === 'ok' ? 'ok' : v.cls === 'warn' ? 'warn' : 'down';
      var badgeTxt = b.state === 'open' ? 'Circuit open' : v.label === 'OFF' ? 'Disabled' : v.label === 'DOWN' ? 'Down' : v.label === 'BUSY' ? 'Busy' : 'Operational';
      return '<div class="ecard">'
        + '<div class="erow"><span class="ename">' + esc(e) + '</span><span class="emodel">' + esc(eng.detail || '') + '</span><span class="spacer"></span>'
        + '<span class="sbadge ' + badgeCls + '"><i></i>' + esc(badgeTxt) + '</span></div>'
        + '<div class="ekv">'
        + '<span class="k">Signed in</span><span>' + engineIdentityCell(e) + '</span>'
        + '<span class="k">Breaker</span><span>' + esc(b.state) + (b.reason ? ' · ' + esc(b.reason) : '') + (b.state === 'open' ? ' · retry ~' + b.retryInSec + 's' : '') + '</span>'
        + '<span class="k">Slots</span><span class="pips">' + pips + '<span class="sub2" style="margin-left:6px">' + (s.inflight[e] || 0) + '/' + max + (s.queue[e] ? ' · ' + s.queue[e] + ' queued' : '') + '</span></span>'
        + '<span class="k">Last error</span><span class="sub2">' + (lastErr ? esc(lastErr.status + ' · ' + (lastErr.label || '') + ' · ' + tval(lastErr.at)) : 'none in window') + '</span>'
        + '</div>'
        + '<div class="ustrip">' + uptimeStrip(eng.history) + '</div>'
        + '<div class="eactions">'
        + '<button class="abtn primary" data-act="breaker-reset" data-engine="' + esc(e) + '"' + (b.state === 'closed' ? ' disabled' : '') + '>Reset breaker</button>'
        + '<button class="abtn" data-act="probe" data-engine="' + esc(e) + '">Probe</button>'
        + (active.length ? '<button class="abtn danger" data-act="kill" data-id="' + esc(active[0].id) + '">Kill run · ' + esc(active[0].id.slice(0, 6)) + '</button>' : '<button class="abtn" disabled>Kill run</button>')
        + (eng.disabled
          ? '<button class="abtn" data-act="engine-enable" data-engine="' + esc(e) + '">Enable engine</button>'
          : '<button class="abtn" data-act="engine-disable" data-engine="' + esc(e) + '">Disable engine</button>')
        + '</div></div>';
    }).join('');
  }

  function renderTiles() {
    var t = state.status.telemetry;
    var u = state.usage;
    var rate = t.recentCount ? pct(t.successCount, t.recentCount) + '%' : '—';
    var usd = u && u.totals ? '$' + (u.totals.apiEquivalentUsd || 0).toFixed(2) : '—';
    var toks = u && u.totals ? ftok(u.totals.promptTokens + u.totals.completionTokens) : ftok(t.estTotalTokens);
    $('ov-tiles').innerHTML =
      '<div class="tile mint"><div class="tl">Requests (window)</div><div class="big num">' + fmt(t.recentCount) + '</div><div class="sub">' + rate + ' success · ' + fmt(t.errorCount) + ' errors</div></div>'
      + '<div class="tile peach"><div class="tl">Avg latency</div><div class="big num">' + fmt(t.avgLatencyMs) + '<small>ms</small></div><div class="sub">across ' + fmt(t.recentCount) + ' calls</div></div>'
      + '<div class="tile peri"><div class="tl">Tokens (' + esc(state.usageRange) + ')</div><div class="big num">' + toks + '</div><div class="sub">' + (u && u.totals ? ftok(u.totals.promptTokens) + ' prompt · ' + ftok(u.totals.completionTokens) + ' completion' : 'telemetry window') + '</div></div>'
      + '<div class="tile plain"><div class="tl">API-equivalent value</div><div class="big num">' + usd + '</div><div class="sub">what this usage would cost on the API</div></div>';
  }

  function renderFeed() {
    var s = state.status;
    var activeRows = (s.activeRequests || []).map(function (a) {
      return '<div class="trow" style="grid-template-columns:64px 1.6fr 90px 90px 80px 80px 70px">'
        + '<span class="sub2 num">' + esc(tval(a.startedAt)) + '</span>'
        + '<span>' + esc(a.routeId) + '<div class="sub2">' + (a.streaming ? 'streaming' : 'blocking') + '</div></span>'
        + '<span class="nbadge">' + esc(a.appId) + '</span>'
        + '<span><span class="dsb run">running</span></span>'
        + '<span class="sub2 num">…</span><span class="sub2 num">—</span>'
        + '<span><button class="abtn danger" style="padding:4px 8px" data-act="kill" data-id="' + esc(a.id) + '">Kill</button></span></div>';
    }).join('');
    var doneRows = (s.recentRequests || []).slice(0, 30).map(function (r) {
      var sc = r.status >= 500 ? 's5' : r.status >= 400 ? 's4' : 's2';
      return '<div class="trow" style="grid-template-columns:64px 1.6fr 90px 90px 80px 80px 70px">'
        + '<span class="sub2 num">' + esc(tval(r.at)) + '</span>'
        + '<span>' + esc(r.label || r.aliasUsed) + (r.usageSource === 'real' ? '<div class="sub2">real usage</div>' : '') + '</span>'
        + '<span class="nbadge">' + esc(r.appId || 'default') + '</span>'
        + '<span><span class="dsb ' + sc + '">' + esc(r.status) + '</span></span>'
        + '<span class="sub2 num">' + esc(fmt(r.durationMs)) + 'ms</span>'
        + '<span class="sub2 num">' + ftok(r.estTotalTokens) + '</span><span></span></div>';
    }).join('');
    $('ov-feed').innerHTML = (activeRows + doneRows) || '<div class="empty">No calls yet</div>';
  }

  // ── Routes ────────────────────────────────────────────────────────────
  function routeCalls(routeId) {
    var pr = (state.status.telemetry.perRoute || []).find(function (r) { return r.routeId === routeId; });
    return pr ? pr.count : 0;
  }
  function renderRoutes() {
    var s = state.status;
    $('rt-table').innerHTML = (s.routes || []).map(function (r) {
      var isDefault = r.id === s.defaultRoute;
      return '<div class="trow" style="grid-template-columns:1.7fr 80px 1.2fr 1.3fr 70px 90px 150px">'
        + '<span>' + esc(r.label) + (isDefault ? ' <span class="chip" style="background:var(--tint-mint)">default</span>' : '') + '<div class="sub2">' + esc(r.id) + '</div></span>'
        + '<span><span class="nbadge">' + esc(r.engine) + '</span></span>'
        + '<span class="sub2">' + esc(r.upstreamModel) + '</span>'
        + '<span></span>'
        + '<span><button class="tog' + (r.enabled !== false ? ' on' : '') + '" data-act="route-toggle" data-id="' + esc(r.id) + '" data-enabled="' + (r.enabled !== false) + '" aria-label="toggle"></button></span>'
        + '<span class="sub2 num">' + fmt(routeCalls(r.id)) + '</span>'
        + '<span><button class="abtn danger" data-act="route-delete" data-id="' + esc(r.id) + '"' + (isDefault ? ' disabled title="default route"' : '') + '>Delete</button></span>'
        + '</div>';
    }).join('');
  }

  // ── Accounts ──────────────────────────────────────────────────────────
  function accountState(a) {
    if (!a.enabled) return { cls: 'down', label: 'Disabled' };
    if (a.needsLogin) return { cls: 'down', label: 'Needs login' };
    if (a.breaker && a.breaker.state === 'open') return { cls: 'down', label: 'Cooling ~' + a.breaker.retryInSec + 's' };
    if ((a.inflight || 0) > 0) return { cls: 'warn', label: 'Busy' };
    return { cls: 'ok', label: 'Ready' };
  }
  function renderAccounts() {
    var s = state.status;
    if (!s || !s.accounts) return;
    var usageByAcct = {};
    if (state.usage && state.usage.perAccount) {
      state.usage.perAccount.forEach(function (a) { usageByAcct[a.account] = a; });
    }
    var max = (s.telemetry && s.telemetry.maxConcurrent) || 1;
    var total = 0;
    var cards = Object.keys(s.accounts).map(function (e) {
      return (s.accounts[e] || []).map(function (a) {
        total += 1;
        var st = accountState(a);
        var b = a.breaker || {};
        var u = usageByAcct[a.name];
        var pips = '';
        for (var i = 0; i < max; i++) pips += '<span class="pip' + (i < (a.inflight || 0) ? ' on' : '') + '"></span>';
        var badgeCls = st.cls === 'ok' ? 'ok' : st.cls === 'warn' ? 'warn' : 'down';
        var loginCmd = (e === 'claude' ? 'CLAUDE_CONFIG_DIR=' : 'HOME=') + (a.dir || '<account dir>') + (e === 'claude' ? ' claude' : ' agy');
        var loginId = 'login-' + e + '-' + a.name;
        return '<div class="ecard">'
          + '<div class="erow"><span class="ename">' + esc(e) + ' · ' + esc(a.name) + '</span>'
          + (a.implicit ? '<span class="chip" style="background:var(--tint-mint)">default</span>' : '')
          + '<span class="spacer"></span><span class="sbadge ' + badgeCls + '"><i></i>' + esc(st.label) + '</span></div>'
          + '<div class="ekv">'
          + '<span class="k">Signed in</span><span>' + identityHtml(a.identity) + '</span>'
          + '<span class="k">Breaker</span><span>' + esc(b.state || 'closed') + (b.reason ? ' · ' + esc(b.reason) : '') + (b.state === 'open' ? ' · retry ~' + b.retryInSec + 's' : '') + '</span>'
          + '<span class="k">Slots</span><span class="pips">' + pips + '<span class="sub2" style="margin-left:6px">' + (a.inflight || 0) + '/' + max + (a.queued ? ' · ' + a.queued + ' queued' : '') + '</span></span>'
          + '<span class="k">Usage</span><span class="sub2">' + (u ? ftok(u.promptTokens + u.completionTokens) + ' tok · $' + (u.apiEquivalentUsd || 0).toFixed(2) + ' · ' + fmt(u.requests) + ' calls' : 'none in range') + '</span>'
          + '<span class="k">Config</span><span class="sub2 mono" style="word-break:break-all">' + (a.implicit ? 'ambient environment (no isolation)' : esc(a.dir)) + '</span>'
          + '</div>'
          + (a.needsLogin ? '<div class="loginbox"><span class="eyebrow">Log in once under this account, then Probe:</span><code id="' + esc(loginId) + '">' + esc(loginCmd) + '</code><button class="abtn" data-copy="' + esc(loginId) + '">Copy</button></div>' : '')
          + '<div class="eactions">'
          + '<button class="abtn primary" data-act="acct-probe" data-engine="' + esc(e) + '" data-name="' + esc(a.name) + '">Probe</button>'
          + (a.enabled
            ? '<button class="abtn" data-act="acct-disable" data-engine="' + esc(e) + '" data-name="' + esc(a.name) + '">Disable</button>'
            : '<button class="abtn" data-act="acct-enable" data-engine="' + esc(e) + '" data-name="' + esc(a.name) + '">Enable</button>')
          + '</div></div>';
      }).join('');
    }).join('');
    $('acct-cards').innerHTML = cards || '<div class="empty">No accounts.</div>';
    $('cnt-accounts').textContent = total;
  }

  // ── Usage ─────────────────────────────────────────────────────────────
  function renderUsage() {
    var u = state.usage;
    if (!u || !u.totals) return;
    var t = u.totals;
    var topApp = (u.perApp && u.perApp[0]) || null;
    $('us-tiles').innerHTML =
      '<div class="tile peri"><div class="tl">Total tokens</div><div class="big num">' + ftok(t.promptTokens + t.completionTokens) + '</div><div class="sub">' + ftok(t.promptTokens) + ' prompt · ' + ftok(t.completionTokens) + ' completion</div></div>'
      + '<div class="tile mint"><div class="tl">API-equivalent value</div><div class="big num">$' + (t.apiEquivalentUsd || 0).toFixed(2) + '</div><div class="sub">vs $0 marginal on subscription</div></div>'
      + '<div class="tile peach"><div class="tl">Top app</div><div class="big">' + esc(topApp ? topApp.appId : '—') + '</div><div class="sub">' + (topApp ? fmt(topApp.requests) + ' calls' : 'no traffic in range') + '</div></div>'
      + '<div class="tile plain"><div class="tl">Requests / errors</div><div class="big num">' + fmt(t.requests) + '</div><div class="sub">' + fmt(t.errors) + ' errors in range</div></div>';
    var dim = state.usageDim || 'app';
    var dimRows = dim === 'account' ? (u.perAccount || []) : dim === 'key' ? (u.perKey || []) : dim === 'user' ? (u.perUser || []) : (u.perApp || []);
    $('us-dim-label').textContent = dim === 'account' ? 'Account' : dim === 'key' ? 'Key' : dim === 'user' ? 'User' : 'App';
    $('us-apps').innerHTML = dimRows.map(function (a) {
      var name = dim === 'account' ? a.account : dim === 'key' ? a.keyName : dim === 'user' ? a.user : a.appId;
      var acc = dim === 'app'
        ? (a.usageAccuracy === 'real' ? '<span class="estb real">real</span>' : a.usageAccuracy === 'mixed' ? '<span class="estb real">mixed</span>' : '<span class="estb est">~est</span>')
        : '';
      return '<div class="trow" style="grid-template-columns:1.2fr 70px 90px 90px 95px 70px 70px">'
        + '<span>' + esc(name) + acc + '</span>'
        + '<span class="sub2 num">' + fmt(a.requests) + '</span>'
        + '<span class="sub2 num">' + ftok(a.promptTokens) + '</span>'
        + '<span class="sub2 num">' + ftok(a.completionTokens) + '</span>'
        + '<span class="sub2 num">$' + (a.apiEquivalentUsd || 0).toFixed(2) + '</span>'
        + '<span class="sub2 num">' + fmt(a.errors) + '</span>'
        + '<span class="sub2 num">' + (dim === 'app' ? fmt(a.avgLatencyMs) + 'ms' : '—') + '</span></div>';
    }).join('') || '<div class="empty">No usage in range</div>';
    $('us-note').textContent = u.note || '';
    var days = (u.perDay || []).slice(-14);
    var maxTok = days.reduce(function (m, d) {
      var sum = 0; Object.keys(d.byEngine).forEach(function (e) { sum += d.byEngine[e]; });
      return Math.max(m, sum);
    }, 1);
    $('us-bars').innerHTML = days.map(function (d) {
      var c = d.byEngine.claude || 0;
      var g = d.byEngine.gemini || 0;
      return '<div class="bar" title="' + esc(d.date) + ': claude ' + ftok(c) + ', gemini ' + ftok(g) + '">'
        + '<i class="bc" style="height:' + Math.max(1, Math.round((c / maxTok) * 90)) + 'px"></i>'
        + '<i class="bg" style="height:' + Math.max(1, Math.round((g / maxTok) * 90)) + 'px"></i></div>';
    }).join('') || '<div class="empty" style="width:100%">No data</div>';
    $('us-bar-x').innerHTML = days.map(function (d) { return '<span>' + esc(d.date.slice(5)) + '</span>'; }).join('');
    $('us-routes').innerHTML = (u.perRoute || []).map(function (r) {
      return '<div class="trow" style="grid-template-columns:1.6fr 80px 90px 90px"><span class="sub2">' + esc(r.routeId) + '</span><span class="sub2 num">' + fmt(r.requests) + '</span><span class="sub2 num">' + ftok(r.tokens) + '</span><span class="sub2 num">$' + (r.apiEquivalentUsd || 0).toFixed(2) + '</span></div>';
    }).join('') || '<div class="empty">No routed calls in range</div>';
  }

  // ── Tester ────────────────────────────────────────────────────────────
  function renderTesterRoutes() {
    var s = state.status;
    var opts = (s.routes || []).filter(function (r) { return r.enabled !== false; }).map(function (r) {
      var v = engineVerdict(r.engine, s);
      var mark = v.cls === 'ok' ? '✅' : v.cls === 'warn' ? '🟡' : '⛔';
      return '<option value="' + esc(r.id) + '">' + esc(r.label) + ' · ' + mark + '</option>';
    }).join('');
    ['t-route', 't-compare-route'].forEach(function (id) {
      var sel = $(id);
      var prev = sel.value;
      sel.innerHTML = opts;
      if (prev && [].some.call(sel.options, function (o) { return o.value === prev; })) sel.value = prev;
    });
  }

  function testerBody(routeId) {
    var messages = [];
    var sys = $('t-system').value.trim();
    if (sys) messages.push({ role: 'system', content: sys });
    messages.push({ role: 'user', content: $('t-prompt').value });
    var body = { model: routeId, messages: messages };
    var toolsRaw = $('t-tools').value.trim();
    if (toolsRaw) {
      try { body.tools = JSON.parse(toolsRaw); } catch (_) { throw new Error('Tools field is not valid JSON'); }
    }
    if (state.rf === 'json_object') body.response_format = { type: 'json_object' };
    if (state.rf === 'json_schema') {
      var schemaRaw = $('t-schema').value.trim();
      var schema;
      try { schema = schemaRaw ? JSON.parse(schemaRaw) : { type: 'object' }; } catch (_) { throw new Error('Schema field is not valid JSON'); }
      body.response_format = { type: 'json_schema', json_schema: { name: 'tester', schema: schema } };
    }
    if (state.transport === 'stream') body.stream = true;
    return body;
  }

  var testerAborts = [];
  function runOne(routeId, outId, metaId, tagId) {
    var out = $(outId);
    var meta = $(metaId);
    $(tagId).textContent = (outId === 't-out-a' ? 'A · ' : 'B · ') + routeId.split('-').pop();
    out.textContent = '';
    meta.textContent = state.transport === 'stream' ? 'SSE · streaming…' : 'POST · running…';
    var t0 = Date.now();
    var body;
    try { body = testerBody(routeId); } catch (err) { out.textContent = err.message; meta.textContent = 'input error'; return Promise.resolve(); }
    var ctl = new AbortController();
    testerAborts.push(ctl);
    var headers = { 'Content-Type': 'application/json', 'X-App-Id': 'dashboard-tester' };
    if (key()) headers.Authorization = 'Bearer ' + key();
    var authHint = function (status) {
      return status === 401
        ? '\n\n→ The provider requires a bearer key: open the Connect tab, paste the API key from `npm run bridge:status` (or .bridge-runtime/credentials.json) into the key field, and run again.'
        : '';
    };
    if (state.transport !== 'stream') {
      return fetch('/v1/chat/completions', { method: 'POST', headers: headers, body: JSON.stringify(body), signal: ctl.signal })
        .then(function (r) { return r.json().then(function (j) { return { r: r, j: j }; }); })
        .then(function (o) {
          var c = o.j.choices && o.j.choices[0];
          out.textContent = (c ? (c.message.tool_calls ? JSON.stringify(c.message.tool_calls, null, 2) : c.message.content) : JSON.stringify(o.j, null, 2)) + authHint(o.r.status);
          var usage = o.j.usage ? ' · ' + o.j.usage.total_tokens + ' tok' : '';
          meta.textContent = o.r.status + usage + ' · ' + (Date.now() - t0) + 'ms' + (c && c.finish_reason ? ' · ' + c.finish_reason : '');
        })
        .catch(function (err) { out.textContent = String(err.message || err); meta.textContent = 'aborted/error'; });
    }
    return fetch('/v1/chat/completions', { method: 'POST', headers: headers, body: JSON.stringify(body), signal: ctl.signal })
      .then(function (res) {
        if (!res.ok) return res.text().then(function (t) { out.textContent = t + authHint(res.status); meta.textContent = 'error ' + res.status; });
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var buf = '';
        var acc = '';
        var finish = '';
        function pump() {
          return reader.read().then(function (rd) {
            if (rd.done) {
              meta.textContent = '200 · streamed · ' + (Date.now() - t0) + 'ms' + (finish ? ' · ' + finish : '');
              return undefined;
            }
            buf += dec.decode(rd.value, { stream: true });
            var parts = buf.split('\n\n');
            buf = parts.pop();
            parts.forEach(function (ln) {
              ln = ln.trim();
              if (ln.indexOf('data:') !== 0) return;
              var data = ln.slice(5).trim();
              if (data === '[DONE]') return;
              try {
                var j = JSON.parse(data);
                var ch = j.choices && j.choices[0];
                if (ch && ch.delta && ch.delta.content) { acc += ch.delta.content; out.textContent = acc; out.scrollTop = out.scrollHeight; }
                if (ch && ch.delta && ch.delta.tool_calls) { acc += JSON.stringify(ch.delta.tool_calls, null, 2); out.textContent = acc; }
                if (ch && ch.finish_reason) finish = ch.finish_reason;
              } catch (_) {}
            });
            return pump();
          });
        }
        return pump();
      })
      .catch(function (err) { out.textContent = String(err.message || err); meta.textContent = 'aborted/error'; });
  }

  function runTester() {
    $('t-run').disabled = true;
    $('t-stop').disabled = false;
    $('t-status').textContent = 'Running';
    testerAborts = [];
    var runs = [runOne($('t-route').value, 't-out-a', 't-meta-a', 't-tag-a')];
    if (state.compare) runs.push(runOne($('t-compare-route').value, 't-out-b', 't-meta-b', 't-tag-b'));
    Promise.all(runs).then(function () {
      $('t-run').disabled = false;
      $('t-stop').disabled = true;
      $('t-status').textContent = 'Done';
      state.history.unshift(tval(Date.now()) + ' · ' + $('t-route').value.split('-').pop()
        + (state.compare ? ' vs ' + $('t-compare-route').value.split('-').pop() : '')
        + ' · ' + state.transport + (state.rf !== 'text' ? ' · ' + state.rf : ''));
      state.history = state.history.slice(0, 8);
      $('t-history').innerHTML = state.history.map(esc).join('<br>');
      throttledRefresh();
    });
  }

  function curlSnippet() {
    var body;
    try { body = testerBody($('t-route').value); } catch (_) { body = { model: $('t-route').value, messages: [] }; }
    return 'curl ' + location.origin + '/v1/chat/completions \\\n  -H "Authorization: Bearer ' + (key() || '<key>') + '" \\\n  -H "Content-Type: application/json" \\\n  -d ' + "'" + JSON.stringify(body) + "'";
  }

  // ── Requests (capture) ───────────────────────────────────────────────
  function renderCapture() {
    var s = state.status;
    var on = s.capture && s.capture.enabled;
    $('cap-tog').className = 'tog' + (on ? ' on' : '');
    $('cap-label').textContent = 'Capture bodies: ' + (on ? 'on' : 'off');
    $('cap-off').style.display = on ? 'none' : '';
    $('cap-on').style.display = on ? '' : 'none';
    if (on && state.view === 'requests') loadCaptureList();
  }
  function loadCaptureList() {
    admin('GET', '/admin/capture').then(function (d) {
      $('cap-list').innerHTML = (d.requests || []).map(function (e) {
        var sc = e.status >= 500 ? 's5' : e.status >= 400 ? 's4' : 's2';
        return '<div class="reqitem' + (state.capSelected === e.id ? ' sel' : '') + '" data-cap="' + esc(e.id) + '">'
          + '<span class="rt num">' + esc(tval(e.startedAt)) + '</span>'
          + '<span>' + esc(e.routeId || '?') + ' · ' + esc(e.appId || '') + '<div class="sub2">' + ftok(e.promptBytes) + 'B in · ' + ftok(e.outputBytes) + 'B out</div></span>'
          + '<span class="dsb ' + sc + '">' + esc(e.status == null ? '…' : e.status) + '</span>'
          + '<span class="sub2 num">' + (e.stages && e.stages.totalMs != null ? fmt(e.stages.totalMs) + 'ms' : '—') + '</span></div>';
      }).join('') || '<div class="empty">Nothing captured yet — make a request.</div>';
    }).catch(function () {});
  }
  function loadCaptureDetail(id) {
    state.capSelected = id;
    admin('GET', '/admin/capture/' + id).then(function (e) {
      var st = e.stages || {};
      var total = st.totalMs || 1;
      var seg = function (ms, cls) { return '<i class="' + cls + '" style="width:' + Math.max(1, Math.round(((ms || 0) / total) * 100)) + '%"></i>'; };
      var wait = Math.max(0, (st.firstByteMs || total) - (st.queuedMs || 0));
      var out = Math.max(0, total - (st.firstByteMs || total));
      $('cap-detail').innerHTML =
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">'
        + '<span style="font-weight:500">req ' + esc(e.meta.reqId) + ' · ' + esc(e.meta.routeId) + '</span>'
        + '<span class="dsb ' + (e.status >= 500 ? 's5' : e.status >= 400 ? 's4' : 's2') + '">' + esc(e.status) + (e.error ? ' ' + esc(e.error.kind) : '') + '</span>'
        + '<span class="spacer"></span><span class="sub2 mono">' + esc(tval(e.startedAt)) + ' · ' + esc(e.meta.appId) + '</span></div>'
        + '<div class="stages">' + seg(st.queuedMs, 'st-q') + seg(wait, 'st-w') + seg(out, 'st-o') + '</div>'
        + '<div class="stage-leg">'
        + '<span><i style="background:var(--hairline)"></i>queued ' + fmt(st.queuedMs || 0) + 'ms</span>'
        + '<span><i style="background:var(--mint)"></i>CLI wait ' + fmt(wait) + 'ms</span>'
        + '<span><i style="background:var(--ink)"></i>output ' + fmt(out) + 'ms</span></div>'
        + '<div class="dtabs" id="cap-dtabs">'
        + '<button class="dtab active" data-dtab="prompt">Sent prompt</button>'
        + '<button class="dtab" data-dtab="output">Raw output</button>'
        + '<button class="dtab" data-dtab="error">Error</button></div>'
        + '<div class="console" style="border-radius:0 0 4px 4px;border-top:none;min-height:170px">'
        + '<div class="cbar"><span class="ctag" id="cap-body-tag">flattened prompt</span></div>'
        + '<div class="cbody" id="cap-body"></div></div>';
      var bodies = {
        prompt: e.sentPrompt || '(empty)',
        output: e.rawOutput || '(no output)',
        error: e.error ? e.error.kind + ': ' + e.error.message : '(no error)',
      };
      $('cap-body').textContent = bodies.prompt;
      $('cap-dtabs').addEventListener('click', function (ev) {
        var b = ev.target.closest('.dtab');
        if (!b) return;
        [].forEach.call($('cap-dtabs').children, function (x) { x.classList.toggle('active', x === b); });
        $('cap-body').textContent = bodies[b.getAttribute('data-dtab')];
        $('cap-body-tag').textContent = b.textContent.toLowerCase();
      });
      loadCaptureList();
    }).catch(function () {});
  }

  // ── Connect ───────────────────────────────────────────────────────────
  function snippets() {
    var s = state.status;
    var base = s ? s.connection.baseUrl : location.origin + '/v1';
    var def = s ? s.defaultRoute : 'bridge-fast';
    var models = s ? (s.routes || []).map(function (r) { return '      - ' + r.id; }).join('\n') : '';
    return {
      hermes: { n: '~/.hermes/config.yaml', b: 'providers:\n  ai-cli-bridge:\n    type: openai\n    base_url: ' + base + '\n    api_key: ${AI_CLI_BRIDGE_API_KEY}\n    models:\n' + models },
      curl: { n: 'POST /v1/chat/completions', b: 'curl ' + base + '/chat/completions \\\n  -H "Authorization: Bearer <key>" \\\n  -H "X-App-Id: my-app" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"model":"' + def + '","messages":[{"role":"user","content":"Hello"}]}\'' },
      js: { n: 'openai · node', b: 'import OpenAI from "openai";\n\nconst client = new OpenAI({\n  baseURL: "' + base + '",\n  apiKey: process.env.AI_CLI_BRIDGE_API_KEY,\n  defaultHeaders: { "X-App-Id": "my-app" },\n});' },
      python: { n: 'openai · python', b: 'from openai import OpenAI\n\nclient = OpenAI(\n    base_url="' + base + '",\n    api_key=os.environ["AI_CLI_BRIDGE_API_KEY"],\n    default_headers={"X-App-Id": "my-app"},\n)' },
    };
  }
  function renderConnect() {
    var s = state.status;
    if (!s) return;
    $('c-base').textContent = s.connection.baseUrl;
    $('c-auth').textContent = s.connection.authHeader;
    $('c-default').textContent = s.defaultRoute;
    var sn = snippets()[state.snip];
    $('snip-name').textContent = sn.n;
    $('snip-body').textContent = sn.b;
    [].forEach.call($('c-tabs').children, function (b) { b.classList.toggle('active', b.getAttribute('data-snip') === state.snip); });
    renderKeys();
  }

  // Key management (admin-role only). Uses a raw fetch for the read so a
  // missing/app-role key shows a hint in-place instead of alerting on refresh.
  function renderKeys() {
    var el = $('keys-table');
    if (!el) return;
    // An admin session authorizes on its own (cookie); the pasted key is the
    // fallback for key-only / open-mode setups.
    if (!key() && !(state.user && state.user.role === 'admin')) {
      el.innerHTML = '<div class="empty">Sign in as an admin — or set the admin API key (left) — to manage keys.</div>';
      return;
    }
    fetch('/admin/keys', { headers: key() ? { Authorization: 'Bearer ' + key() } : {} }).then(function (r) {
      if (r.status === 401) { el.innerHTML = '<div class="empty">' + (key() ? 'Key not recognized.' : 'Session expired — sign in again.') + '</div>'; return null; }
      if (r.status === 403) { el.innerHTML = '<div class="empty">This key is app-role — an admin key is required to manage keys.</div>'; return null; }
      if (r.status === 503) { el.innerHTML = '<div class="empty">Auth is disabled — no keys to manage.</div>'; return null; }
      return r.json();
    }).then(function (d) {
      if (!d) return;
      el.innerHTML = (d.keys || []).map(function (k) {
        var pins = k.accountPin ? Object.keys(k.accountPin).map(function (e) { return esc(e + ':' + k.accountPin[e]); }).join(', ') : '—';
        var lim = k.limits || {};
        var use = k.usage || {};
        var parts = [];
        if (lim.rpm) parts.push(lim.rpm + '/min');
        if (lim.tokensPerDay) parts.push(ftok(use.tokensToday || 0) + ' of ' + ftok(lim.tokensPerDay) + ' tok/day');
        if (lim.usdPerMonth) parts.push('$' + (use.usdThisMonth || 0).toFixed(2) + ' of $' + lim.usdPerMonth + '/mo');
        var limHtml = parts.length ? parts.map(function (p) { return '<span class="chip">' + esc(p) + '</span>'; }).join(' ') : '<span class="sub2">unlimited</span>';
        return '<div class="trow" style="grid-template-columns:1.1fr 70px 1fr 1.4fr 150px">'
          + '<span>' + esc(k.name) + '</span>'
          + '<span><span class="nbadge">' + esc(k.role) + '</span></span>'
          + '<span class="sub2">' + pins + '</span>'
          + '<span>' + limHtml + '</span>'
          + '<span><button class="abtn" data-act="key-limits" data-name="' + esc(k.name) + '" data-limits="' + esc(JSON.stringify(lim)) + '">Limits</button> '
          + '<button class="abtn danger" data-act="key-revoke" data-name="' + esc(k.name) + '">Revoke</button></span></div>';
      }).join('') || '<div class="empty">No keys.</div>';
    }).catch(function () { el.innerHTML = '<div class="empty">Could not load keys.</div>'; });
  }

  // ── Render root ───────────────────────────────────────────────────────
  function renderAll() {
    if (!state.status) return;
    renderHeader();
    if (state.view === 'overview') { renderBanner(); renderEngines(); renderTiles(); renderFeed(); }
    if (state.view === 'routes') renderRoutes();
    if (state.view === 'accounts') renderAccounts();
    if (state.view === 'tester') renderTesterRoutes();
    if (state.view === 'requests') renderCapture();
    if (state.view === 'users') renderUsers();
    if (state.view === 'connect') renderConnect();
  }

  // ── Users (admin) ─────────────────────────────────────────────────────
  function renderUsers() {
    var el = $('users-table');
    if (!el) return;
    admin('GET', '/admin/users').then(function (d) {
      var users = d.users || [];
      $('cnt-users').textContent = users.length || '';
      el.innerHTML = users.map(function (u) {
        var lim = u.defaultLimits || {};
        var limParts = [];
        if (lim.rpm) limParts.push(lim.rpm + '/min');
        if (lim.tokensPerDay) limParts.push(ftok(lim.tokensPerDay) + ' tok/day');
        if (lim.usdPerMonth) limParts.push('$' + lim.usdPerMonth + '/mo');
        var t = u.usageToday || {}; var m = u.usageMonth || {};
        return '<div class="trow" style="grid-template-columns:1.1fr 70px 1.2fr 1fr 1fr 190px">'
          + '<span>' + esc(u.displayName) + '<div class="sub2">' + esc(u.username) + (u.disabled ? ' · <span style="color:var(--warn-d)">disabled</span>' : '') + '</div></span>'
          + '<span><span class="nbadge">' + esc(u.role) + '</span></span>'
          + '<span class="sub2">' + ((u.keys || []).map(function (k) { return esc(k.split('.').slice(1).join('.') || k); }).join(', ') || '—')
          + (limParts.length ? '<div class="sub2">' + limParts.join(' · ') + '</div>' : '') + '</span>'
          + '<span class="sub2 num">' + fmt(t.requests || 0) + ' req · ' + ftok((t.promptTokens || 0) + (t.completionTokens || 0)) + '</span>'
          + '<span class="sub2 num">' + fmt(m.requests || 0) + ' req · $' + (m.apiEquivalentUsd || 0).toFixed(2) + '</span>'
          + '<span>'
          + '<button class="abtn" data-act="user-limits" data-name="' + esc(u.username) + '" data-limits="' + esc(JSON.stringify(lim)) + '">Limits</button> '
          + '<button class="abtn" data-act="user-password" data-name="' + esc(u.username) + '">Pass</button> '
          + '<button class="abtn" data-act="user-toggle" data-name="' + esc(u.username) + '" data-disabled="' + (u.disabled ? '1' : '') + '">' + (u.disabled ? 'Enable' : 'Disable') + '</button> '
          + '<button class="abtn danger" data-act="user-delete" data-name="' + esc(u.username) + '">Delete</button>'
          + '</span></div>';
      }).join('') || '<div class="empty">No users yet.</div>';
    }).catch(function () { el.innerHTML = '<div class="empty">Sign in as an admin (or set the admin key in Connect) to manage users.</div>'; });
  }

  // ── Actions ───────────────────────────────────────────────────────────
  var ACTIONS = {
    'breaker-reset': function (el) { return admin('POST', '/admin/breakers/' + el.getAttribute('data-engine') + '/reset', {}); },
    'probe': function (el) {
      var e = el.getAttribute('data-engine');
      el.classList.add('busy');
      return admin('POST', '/admin/engines/' + e + '/probe', {}).then(function (d) {
        el.classList.remove('busy');
        var routed = {};
        (state.status.routes || []).forEach(function (r) { routed[r.upstreamModel] = true; });
        var chips = (d.models || []).map(function (m) {
          return '<span class="chip">' + esc(m.id) + ' <span class="estb ' + (routed[m.id] ? 'real">routed' : 'est">new') + '</span></span>';
        }).join('');
        $('rt-discovered').innerHTML = '<span class="k">' + esc(e) + '</span><span>' + (chips || '<span class="sub2">none reported</span>') + '</span>';
      }).catch(function () { el.classList.remove('busy'); });
    },
    'kill': function (el) {
      if (!confirm('Kill this in-flight run? The CLI process is terminated and the caller gets an error.')) return Promise.resolve();
      return admin('POST', '/admin/requests/' + el.getAttribute('data-id') + '/kill', {});
    },
    'engine-disable': function (el) {
      var e = el.getAttribute('data-engine');
      if (!confirm('Disable the ' + e + ' engine? All its routes will reject requests until re-enabled.')) return Promise.resolve();
      return admin('POST', '/admin/engines/' + e + '/disable', {});
    },
    'engine-enable': function (el) { return admin('POST', '/admin/engines/' + el.getAttribute('data-engine') + '/enable', {}); },
    'acct-probe': function (el) {
      var e = el.getAttribute('data-engine');
      var n = el.getAttribute('data-name');
      el.classList.add('busy');
      return admin('POST', '/admin/accounts/' + e + '/' + n + '/probe', {})
        .then(function () { el.classList.remove('busy'); })
        .catch(function (err) { el.classList.remove('busy'); if (err && err.message !== 'unauthorized') alert('Probe failed for ' + e + ':' + n + ' — ' + err.message); });
    },
    'acct-enable': function (el) { return admin('POST', '/admin/accounts/' + el.getAttribute('data-engine') + '/' + el.getAttribute('data-name') + '/enable', {}); },
    'acct-disable': function (el) {
      var e = el.getAttribute('data-engine');
      var n = el.getAttribute('data-name');
      if (!confirm('Disable ' + e + ':' + n + '? It leaves rotation until re-enabled (runtime only).')) return Promise.resolve();
      return admin('POST', '/admin/accounts/' + e + '/' + n + '/disable', {});
    },
    'key-revoke': function (el) {
      var n = el.getAttribute('data-name');
      if (!confirm('Revoke key "' + n + '"? Any app using it stops working immediately.')) return Promise.resolve();
      return admin('DELETE', '/admin/keys/' + encodeURIComponent(n)).then(function () { renderKeys(); });
    },
    'user-toggle': function (el) {
      var n = el.getAttribute('data-name');
      var dis = el.getAttribute('data-disabled') === '1';
      return admin('PATCH', '/admin/users/' + encodeURIComponent(n), { disabled: !dis })
        .then(renderUsers).catch(function (err) { if (err && err.message !== 'unauthorized') alert(err.message); });
    },
    'user-delete': function (el) {
      var n = el.getAttribute('data-name');
      if (!confirm('Delete user "' + n + '"? Their API keys are revoked and their sessions killed.')) return Promise.resolve();
      return admin('DELETE', '/admin/users/' + encodeURIComponent(n))
        .then(renderUsers).catch(function (err) { if (err && err.message !== 'unauthorized') alert(err.message); });
    },
    'user-password': function (el) {
      var n = el.getAttribute('data-name');
      var p = prompt('New password for "' + n + '" (min 8 chars) — they are signed out everywhere:');
      if (p === null) return Promise.resolve();
      return admin('PATCH', '/admin/users/' + encodeURIComponent(n), { password: p })
        .then(function () { alert('Password updated.'); }).catch(function (err) { if (err && err.message !== 'unauthorized') alert(err.message); });
    },
    'user-limits': function (el) {
      var n = el.getAttribute('data-name');
      var cur = {};
      try { cur = JSON.parse(el.getAttribute('data-limits') || '{}'); } catch (_) { cur = {}; }
      var ask = function (label, curVal) {
        var v = prompt(label + ' — default for keys "' + n + '" mints (blank = unlimited):', curVal == null ? '' : String(curVal));
        if (v === null) return undefined;
        return v.trim() === '' ? null : Number(v);
      };
      var rpm = ask('Requests / minute', cur.rpm); if (rpm === undefined) return Promise.resolve();
      var tpd = ask('Tokens / day', cur.tokensPerDay); if (tpd === undefined) return Promise.resolve();
      var usd = ask('$ / month (API-equivalent)', cur.usdPerMonth); if (usd === undefined) return Promise.resolve();
      var limits = {};
      if (rpm !== null) limits.rpm = rpm;
      if (tpd !== null) limits.tokensPerDay = tpd;
      if (usd !== null) limits.usdPerMonth = usd;
      return admin('PATCH', '/admin/users/' + encodeURIComponent(n), { defaultLimits: limits })
        .then(renderUsers).catch(function (err) { if (err && err.message !== 'unauthorized') alert(err.message); });
    },
    'pf-revoke': function (el) {
      var n = el.getAttribute('data-name');
      if (!confirm('Revoke your key "' + n + '"? Apps using it stop working immediately.')) return Promise.resolve();
      return fetch('/me/keys/' + encodeURIComponent(n), { method: 'DELETE' })
        .then(function (r) { return r.json(); })
        .then(function () { loadProfile(); });
    },
    'key-limits': function (el) {
      var n = el.getAttribute('data-name');
      var cur = {};
      try { cur = JSON.parse(el.getAttribute('data-limits') || '{}'); } catch (_) { cur = {}; }
      var ask = function (label, curVal) {
        var v = prompt(label + ' for "' + n + '" (blank = unlimited):', curVal == null ? '' : String(curVal));
        if (v === null) return undefined; // cancelled → abort the whole edit
        return v.trim() === '' ? null : Number(v);
      };
      var rpm = ask('Requests / minute', cur.rpm); if (rpm === undefined) return Promise.resolve();
      var tpd = ask('Tokens / day', cur.tokensPerDay); if (tpd === undefined) return Promise.resolve();
      var usd = ask('$ / month (API-equivalent)', cur.usdPerMonth); if (usd === undefined) return Promise.resolve();
      var limits = {};
      if (rpm !== null) limits.rpm = rpm;
      if (tpd !== null) limits.tokensPerDay = tpd;
      if (usd !== null) limits.usdPerMonth = usd;
      return admin('PATCH', '/admin/keys/' + encodeURIComponent(n), { limits: limits })
        .then(function () { renderKeys(); })
        .catch(function (err) { if (err && err.message !== 'unauthorized') alert(err.message); });
    },
    'route-toggle': function (el) {
      var enabled = el.getAttribute('data-enabled') === 'true';
      return admin('PUT', '/admin/routes/' + el.getAttribute('data-id'), { enabled: !enabled });
    },
    'route-delete': function (el) {
      var id = el.getAttribute('data-id');
      if (!confirm('Delete route "' + id + '" from routes.json?')) return Promise.resolve();
      return admin('DELETE', '/admin/routes/' + id);
    },
  };

  document.addEventListener('click', function (ev) {
    var actEl = ev.target.closest('[data-act]');
    if (actEl) {
      var fn = ACTIONS[actEl.getAttribute('data-act')];
      if (fn) fn(actEl).then(throttledRefresh).catch(function () {});
      return;
    }
    var copyEl = ev.target.closest('[data-copy]');
    if (copyEl) {
      var src = $(copyEl.getAttribute('data-copy'));
      if (src && navigator.clipboard) {
        navigator.clipboard.writeText(src.textContent);
        var old = copyEl.textContent;
        copyEl.textContent = 'Copied';
        setTimeout(function () { copyEl.textContent = old; }, 1100);
      }
      return;
    }
    var capEl = ev.target.closest('[data-cap]');
    if (capEl) loadCaptureDetail(capEl.getAttribute('data-cap'));
  });

  // Tabs
  $('tabs').addEventListener('click', function (ev) {
    var t = ev.target.closest('.tab');
    if (!t) return;
    state.view = t.getAttribute('data-view');
    [].forEach.call($('tabs').children, function (x) { x.classList.toggle('active', x === t); });
    [].forEach.call(document.querySelectorAll('.view'), function (v) { v.classList.toggle('active', v.id === 'view-' + state.view); });
    window.scrollTo({ top: 0 });
    if (state.view === 'usage') fetchUsage();
    renderAll();
  });

  // Segmented controls
  $('us-range').addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    state.usageRange = b.getAttribute('data-range');
    [].forEach.call(this.children, function (x) { x.classList.toggle('active', x === b); });
    fetchUsage();
  });
  $('us-dim').addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    state.usageDim = b.getAttribute('data-dim');
    [].forEach.call(this.children, function (x) { x.classList.toggle('active', x === b); });
    renderUsage();
  });
  $('t-rf').addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    state.rf = b.getAttribute('data-rf');
    [].forEach.call(this.children, function (x) { x.classList.toggle('active', x === b); });
    $('t-schema-wrap').style.display = state.rf === 'json_schema' ? '' : 'none';
  });
  $('t-transport').addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    state.transport = b.getAttribute('data-tr');
    [].forEach.call(this.children, function (x) { x.classList.toggle('active', x === b); });
  });
  $('c-tabs').addEventListener('click', function (ev) {
    var b = ev.target.closest('button');
    if (!b) return;
    state.snip = b.getAttribute('data-snip');
    renderConnect();
  });

  // Tester controls
  $('t-compare').addEventListener('click', function () {
    state.compare = !state.compare;
    this.classList.toggle('on', state.compare);
    $('t-compare-route').disabled = !state.compare;
    $('t-console-b').style.display = state.compare ? '' : 'none';
  });
  $('t-run').addEventListener('click', runTester);
  $('t-stop').addEventListener('click', function () { testerAborts.forEach(function (c) { c.abort(); }); });
  $('t-curl').addEventListener('click', function () {
    if (navigator.clipboard) navigator.clipboard.writeText(curlSnippet());
    $('t-status').textContent = 'cURL copied';
  });

  // Capture toggle
  $('cap-tog').addEventListener('click', function () {
    var on = state.status && state.status.capture && state.status.capture.enabled;
    admin('POST', '/admin/capture', { enabled: !on }).then(function () {
      state.capSelected = null;
      $('cap-detail').innerHTML = '<div class="empty">Select a request.</div>';
      throttledRefresh();
    }).catch(function () {});
  });

  // Routes add form
  $('rt-add').addEventListener('click', function () {
    var body = {
      id: $('rt-id').value.trim(),
      label: $('rt-label').value.trim() || $('rt-id').value.trim(),
      engine: $('rt-engine').value,
      model: $('rt-model').value.trim(),
      bestFor: '',
      aliases: $('rt-aliases').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
    };
    admin('POST', '/admin/routes', body).then(function () {
      $('rt-msg').textContent = 'Added.';
      ['rt-id', 'rt-label', 'rt-model', 'rt-aliases'].forEach(function (id) { $(id).value = ''; });
      throttledRefresh();
    }).catch(function (err) { $('rt-msg').textContent = err.message; });
  });
  document.querySelectorAll('[data-probe]').forEach(function (b) {
    b.setAttribute('data-act', 'probe');
    b.setAttribute('data-engine', b.getAttribute('data-probe'));
  });

  // Key field. A key change may unlock an auth-gated dashboard: refetch and
  // reconnect the event stream with the new key.
  $('c-key').value = key();
  $('c-key').addEventListener('change', function () {
    localStorage.setItem('providerApiKey', this.value);
    renderKeys();
    $('login-overlay').style.display = 'none';
    if (es) { es.close(); es = null; }
    connectEvents();
    fetchStatus().then(fetchUsage);
  });

  // Mint a named key (admin). Secret is shown once, in-page, then cleared from state.
  $('key-mint').addEventListener('click', function () {
    var name = $('key-name').value.trim();
    if (!name) { $('key-msg').textContent = 'Name required.'; return; }
    var body = { name: name, role: $('key-role').value };
    var pin = {};
    if ($('key-pin-claude').value.trim()) pin.claude = $('key-pin-claude').value.trim();
    if ($('key-pin-gemini').value.trim()) pin.gemini = $('key-pin-gemini').value.trim();
    if (Object.keys(pin).length) body.accountPin = pin;
    var limits = {};
    if ($('key-rpm').value) limits.rpm = Number($('key-rpm').value);
    if ($('key-tpd').value) limits.tokensPerDay = Number($('key-tpd').value);
    if ($('key-usd').value) limits.usdPerMonth = Number($('key-usd').value);
    if (Object.keys(limits).length) body.limits = limits;
    admin('POST', '/admin/keys', body).then(function (d) {
      $('key-msg').textContent = 'Minted "' + d.name + '".';
      $('minted-key').style.display = '';
      $('minted-secret').textContent = d.key;
      ['key-name', 'key-pin-claude', 'key-pin-gemini', 'key-rpm', 'key-tpd', 'key-usd'].forEach(function (id) { $(id).value = ''; });
      renderKeys();
    }).catch(function (err) { if (err && err.message !== 'unauthorized') $('key-msg').textContent = err.message; });
  });

  // Live toggle (pause SSE-driven refreshes)
  $('livebtn').addEventListener('click', function () {
    if (es) { es.close(); es = null; setLive(false); if (!pollTimer) pollTimer = setInterval(fetchStatus, 10000); }
    else { connectEvents(); fetchStatus(); }
  });

  // ── Login / profile (SaaS mode) ───────────────────────────────────────
  function doLogin() {
    $('li-msg').textContent = '';
    fetch('/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('li-user').value.trim(), password: $('li-pass').value }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (out) {
      if (!out.ok) { $('li-msg').textContent = out.j.error || 'Login failed.'; return; }
      location.reload();
    }).catch(function () { $('li-msg').textContent = 'Network error.'; });
  }
  $('li-btn').addEventListener('click', doLogin);
  $('li-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  $('logoutbtn').addEventListener('click', function () {
    fetch('/auth/logout', { method: 'POST' }).then(function () { location.reload(); });
  });

  function showWhoami() {
    $('whoami').style.display = '';
    $('whoami-name').textContent = state.user.displayName + ' (' + state.user.role + ')';
  }

  function loadProfile() {
    fetch('/me/keys').then(function (r) { return r.json(); }).then(function (d) {
      var lim = d.defaultLimits || {};
      $('pf-keys').innerHTML = (d.keys || []).map(function (k) {
        var use = k.usage || {};
        var kl = k.limits || {};
        var parts = [];
        if (kl.rpm) parts.push(kl.rpm + '/min');
        if (kl.tokensPerDay) parts.push(ftok(use.tokensToday || 0) + ' of ' + ftok(kl.tokensPerDay) + ' tok/day');
        if (kl.usdPerMonth) parts.push('$' + (use.usdThisMonth || 0).toFixed(2) + ' of $' + kl.usdPerMonth + '/mo');
        return '<div class="trow" style="grid-template-columns:1.4fr 1.6fr 90px">'
          + '<span>' + esc(k.name.split('.').slice(1).join('.') || k.name) + '<div class="sub2">' + esc(k.name) + '</div></span>'
          + '<span>' + (parts.length ? parts.map(function (p) { return '<span class="chip">' + esc(p) + '</span>'; }).join(' ') : '<span class="sub2">unlimited</span>') + '</span>'
          + '<span><button class="abtn danger" data-act="pf-revoke" data-name="' + esc(k.name) + '">Revoke</button></span></div>';
      }).join('') || '<div class="empty">No keys yet — mint one for your app.</div>';
      var limNote = [];
      if (lim.rpm) limNote.push(lim.rpm + ' req/min');
      if (lim.tokensPerDay) limNote.push(ftok(lim.tokensPerDay) + ' tok/day');
      if (lim.usdPerMonth) limNote.push('$' + lim.usdPerMonth + '/mo');
      $('pf-msg').textContent = limNote.length ? 'New keys get: ' + limNote.join(' · ') : '';
    });
    fetch('/me/usage?range=7d').then(function (r) { return r.json(); }).then(function (u) {
      var t = u.totals || {};
      $('pf-tiles').innerHTML =
        '<div class="tile peri"><div class="tl">Tokens (7d)</div><div class="big num">' + ftok((t.promptTokens || 0) + (t.completionTokens || 0)) + '</div><div class="sub">' + ftok(t.promptTokens || 0) + ' prompt · ' + ftok(t.completionTokens || 0) + ' completion</div></div>'
        + '<div class="tile mint"><div class="tl">API-equivalent value</div><div class="big num">$' + (t.apiEquivalentUsd || 0).toFixed(2) + '</div><div class="sub">7 days</div></div>'
        + '<div class="tile plain"><div class="tl">Requests / errors</div><div class="big num">' + fmt(t.requests || 0) + '</div><div class="sub">' + fmt(t.errors || 0) + ' errors</div></div>';
      $('pf-usage-rows').innerHTML = (u.perKey || []).map(function (k) {
        return '<div class="trow" style="grid-template-columns:1.2fr 70px 90px 90px 95px">'
          + '<span class="sub2">' + esc(k.keyName) + '</span>'
          + '<span class="sub2 num">' + fmt(k.requests) + '</span>'
          + '<span class="sub2 num">' + ftok(k.promptTokens) + '</span>'
          + '<span class="sub2 num">' + ftok(k.completionTokens) + '</span>'
          + '<span class="sub2 num">$' + (k.apiEquivalentUsd || 0).toFixed(2) + '</span></div>';
      }).join('') || '<div class="empty">No usage yet.</div>';
    });
  }

  $('pf-mint').addEventListener('click', function () {
    var app = $('pf-app').value.trim();
    if (!app) { $('pf-msg').textContent = 'App name required.'; return; }
    fetch('/me/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app: app }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (out) {
      if (!out.ok) { $('pf-msg').textContent = out.j.error || 'Mint failed.'; return; }
      $('pf-app').value = '';
      $('pf-minted').style.display = '';
      $('pf-secret').textContent = out.j.key;
      $('pf-base').textContent = location.origin + '/v1';
      loadProfile();
    });
  });

  $('pf-passbtn').addEventListener('click', function () {
    fetch('/auth/password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: $('pf-cur').value, newPassword: $('pf-new').value }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); }).then(function (out) {
      $('pf-passmsg').textContent = out.ok ? 'Changed — sign in again.' : (out.j.error || 'Failed.');
      if (out.ok) setTimeout(function () { location.reload(); }, 1200);
    });
  });

  $('user-create').addEventListener('click', function () {
    var body = {
      username: $('u-name').value.trim(),
      displayName: $('u-display').value.trim() || undefined,
      password: $('u-pass').value,
      role: $('u-role').value,
    };
    var lim = {};
    if ($('u-rpm').value) lim.rpm = Number($('u-rpm').value);
    if ($('u-tpd').value) lim.tokensPerDay = Number($('u-tpd').value);
    if ($('u-usd').value) lim.usdPerMonth = Number($('u-usd').value);
    if (Object.keys(lim).length) body.defaultLimits = lim;
    admin('POST', '/admin/users', body).then(function (d) {
      $('user-msg').textContent = 'Created "' + d.username + '".';
      ['u-name', 'u-display', 'u-pass', 'u-rpm', 'u-tpd', 'u-usd'].forEach(function (id) { $(id).value = ''; });
      renderUsers();
    }).catch(function (err) { if (err && err.message !== 'unauthorized') $('user-msg').textContent = err.message; });
  });

  function enterUserMode() {
    // Regular users get their profile only — the ops tabs are admin territory.
    $('tabs').style.display = 'none';
    $('livebtn').style.display = 'none';
    [].forEach.call(document.querySelectorAll('.view'), function (v) { v.classList.toggle('active', v.id === 'view-profile'); });
    $('pf-hello').textContent = 'Hi, ' + state.user.displayName;
    loadProfile();
    setInterval(loadProfile, 30000);
  }

  function bootAdmin() {
    fetchStatus().then(fetchUsage);
    connectEvents();
    setInterval(function () { if (state.view === 'overview' || state.view === 'usage') fetchUsage(); }, 30000);
  }

  // Boot: who am I? user role → profile; admin/none → full dashboard (data
  // fetches 401 into the login overlay when DASHBOARD_AUTH is on).
  $('loginbtn').addEventListener('click', function () { $('login-overlay').style.display = 'flex'; });
  fetch('/auth/me').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (d && d.user) {
      state.user = d.user;
      showWhoami();
      if (d.user.role === 'user') return enterUserMode();
    } else {
      $('loginbtn').style.display = '';
    }
    bootAdmin();
  }).catch(bootAdmin);
}());
