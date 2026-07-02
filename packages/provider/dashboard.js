'use strict';

// Legacy dashboard page, copied verbatim from provider-bridge/server.js.
// Phase 5 replaces this with static files per the approved mockup.
function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Provider Console · AI CLI Bridge</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root{
      --canvas:#ffffff; --canvas-dark:#010120;
      --hairline:#ebebeb; --surface-dark-soft:#26263a; --surface-dark-fill:#313641;
      --ink:#000000; --body:#717182; --body-faint:#999999; --on-dark:#ffffff; --on-dark-soft:#b9bcd6;
      --orange:#fc4c02; --magenta:#ef2cc1; --periwinkle:#bdbbff; --mint:#c8f6f9;
      --tint-mint:#dff7fb; --tint-peri:#ecebff; --tint-peach:#ffe7d8;
      --brand-grad:linear-gradient(96deg,#fc4c02,#ef2cc1 54%,#bdbbff);
      --ok:#1a7f4b; --warn:#b2590a; --down:#c0392b;
      --ok-d:#3ddc84; --warn-d:#f5b53d; --down-d:#ff6b6b;
      --r-xs:3.25px; --r-sm:4px; --r-md:8px; --r-full:9999px;
      --xs:4px; --sm:8px; --md:12px; --lg:16px; --xl:20px; --x2:24px; --x3:32px; --x5:48px;
      --sans:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      --mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    }
    *{ box-sizing:border-box; }
    html,body{ margin:0; padding:0; }
    body{ background:var(--canvas); color:var(--ink); font-family:var(--sans); font-size:16px; line-height:1.4; letter-spacing:-.011em; -webkit-font-smoothing:antialiased; }
    .band{ width:100%; }
    .band-dark{ background:var(--canvas-dark); color:var(--on-dark); }
    .inner{ max-width:1240px; margin:0 auto; padding:0 var(--x3); }
    .num{ font-variant-numeric:tabular-nums; }
    .mono{ font-family:var(--mono); }
    .eyebrow{ font-family:var(--mono); text-transform:uppercase; font-size:11px; font-weight:500; letter-spacing:.055em; color:var(--body); }
    .band-dark .eyebrow{ color:var(--on-dark-soft); }
    .h-xxl{ font-size:44px; font-weight:500; line-height:1.06; letter-spacing:-.03em; margin:0; }
    .lead{ font-size:17px; font-weight:400; line-height:1.45; letter-spacing:-.01em; color:var(--on-dark-soft); }
    .sec{ padding:var(--x5) 0; }
    .sec-head{ display:flex; align-items:baseline; gap:var(--lg); margin-bottom:var(--x2); flex-wrap:wrap; }
    .sec-head .note{ font-family:var(--mono); font-size:11px; color:var(--body-faint); margin-left:auto; text-transform:uppercase; letter-spacing:.04em; }

    .cmd .inner{ padding-top:var(--x3); padding-bottom:var(--x3); display:grid; grid-template-columns:1.15fr .85fr; gap:var(--x3); align-items:center; }
    .cmd-nav{ display:flex; align-items:center; gap:var(--md); margin-bottom:var(--x3); }
    .logo-dot{ width:9px; height:9px; border-radius:var(--r-full); background:var(--brand-grad); }
    .cmd-nav .name{ font-family:var(--mono); text-transform:uppercase; letter-spacing:.12em; font-size:11px; color:var(--on-dark); font-weight:500; }
    .cmd-nav .spacer{ flex:1; }
    .h1grad{ background:var(--brand-grad); -webkit-background-clip:text; background-clip:text; color:transparent; }
    .cmd .lead{ margin:var(--lg) 0 0; max-width:46ch; }
    .status-chips{ display:flex; gap:var(--sm); flex-wrap:wrap; margin-top:var(--x2); }
    .chip{ display:inline-flex; align-items:center; gap:8px; background:var(--surface-dark-soft); border:1px solid var(--surface-dark-fill); border-radius:var(--r-sm); padding:8px 12px; }
    .chip .ck{ font-family:var(--mono); font-size:9.5px; text-transform:uppercase; letter-spacing:.1em; color:var(--on-dark-soft); }
    .chip .cv{ font-size:13px; font-weight:500; }
    .dot{ width:8px; height:8px; border-radius:50%; background:var(--on-dark-soft); position:relative; flex:0 0 auto; }
    .dot.ok{ background:var(--ok-d); } .dot.warn{ background:var(--warn-d); } .dot.down{ background:var(--down-d); }
    .dot.ok::after{ content:""; position:absolute; inset:-4px; border-radius:50%; border:1.5px solid var(--ok-d); opacity:.5; animation:ring 2.2s ease-out infinite; }
    @keyframes ring{ 0%{transform:scale(.5);opacity:.6} 70%{transform:scale(1.7);opacity:0} 100%{opacity:0} }
    .live-btn{ display:inline-flex; align-items:center; gap:8px; cursor:pointer; font-family:var(--mono); font-size:11px; text-transform:uppercase; letter-spacing:.08em; font-weight:500; color:var(--on-dark); background:var(--surface-dark-soft); border:1px solid var(--surface-dark-fill); border-radius:var(--r-sm); padding:8px 14px; }
    .live-btn .pl{ width:7px; height:7px; border-radius:50%; background:var(--ok-d); animation:blink 1.4s steps(2,end) infinite; }
    .live-btn.paused .pl{ background:var(--on-dark-soft); animation:none; }
    @keyframes blink{ 50%{opacity:.25} }
    .ribbon-wrap{ position:relative; min-height:230px; }
    .ribbon-wrap svg{ width:100%; height:100%; display:block; }
    .ribbon-grp{ animation:drift 16s ease-in-out infinite alternate; }
    @keyframes drift{ from{ transform:translateX(-10px) } to{ transform:translateX(10px) } }

    .tiles{ display:grid; grid-template-columns:repeat(4,1fr); gap:var(--md); }
    .tile{ border-radius:var(--r-sm); padding:var(--x2); border:1px solid transparent; }
    .tile.mint{ background:var(--tint-mint); } .tile.peri{ background:var(--tint-peri); } .tile.peach{ background:var(--tint-peach); } .tile.plain{ background:var(--canvas); border-color:var(--hairline); }
    .tile .tl{ font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--ink); opacity:.6; }
    .tile .big{ font-size:33px; font-weight:500; letter-spacing:-.03em; line-height:1; margin-top:12px; }
    .tile .big small{ font-size:15px; opacity:.55; letter-spacing:0; }
    .tile .sub{ font-family:var(--mono); font-size:11px; color:var(--ink); opacity:.55; margin-top:10px; }
    .tile .trend{ width:100%; height:30px; display:block; margin-top:10px; }
    .meta-row{ display:grid; grid-template-columns:1fr 1fr; gap:var(--md); margin-top:var(--md); }
    .panel{ background:var(--canvas); border:1px solid var(--hairline); border-radius:var(--r-sm); padding:var(--x2); }
    .panel .ph{ display:flex; align-items:center; justify-content:space-between; }
    .slot{ display:flex; align-items:center; gap:12px; margin-top:14px; }
    .slot .eng{ font-family:var(--mono); font-size:11px; text-transform:uppercase; letter-spacing:.06em; width:62px; }
    .pips{ display:flex; gap:5px; flex:1; }
    .pip{ height:10px; flex:1; border-radius:2px; background:var(--hairline); transition:background .25s ease; max-width:60px; }
    .pip.on{ background:var(--ink); }
    .slot .cnt{ font-family:var(--mono); font-size:11px; color:var(--body); width:40px; text-align:right; }
    .tok-bar{ display:flex; height:10px; border-radius:2px; overflow:hidden; margin-top:16px; background:var(--hairline); }
    .tok-bar .p{ background:var(--ink); } .tok-bar .c{ background:var(--periwinkle); }
    .tok-leg{ display:flex; gap:18px; margin-top:10px; font-family:var(--mono); font-size:11px; color:var(--body); }
    .tok-leg i{ width:9px; height:9px; border-radius:2px; display:inline-block; margin-right:6px; vertical-align:middle; }

    .table{ border:1px solid var(--hairline); border-radius:var(--r-sm); overflow:hidden; }
    .thead,.trow{ display:grid; align-items:center; gap:var(--md); padding:var(--md) var(--lg); }
    .matrix .thead,.matrix .trow{ grid-template-columns:minmax(0,1.7fr) 96px minmax(120px,1fr) 130px 70px; }
    .thead{ background:var(--hairline); font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--body); }
    .trow{ border-top:1px solid var(--hairline); background:var(--canvas); }
    .trow .mname .t{ font-size:15px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .trow .mname .id{ font-family:var(--mono); font-size:11px; color:var(--body-faint); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .nbadge{ font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--ink); background:var(--hairline); border-radius:var(--r-sm); padding:3px 9px; display:inline-block; }
    .sbadge{ font-family:var(--mono); font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:.04em; padding:3px 8px; border-radius:var(--r-sm); display:inline-flex; align-items:center; gap:6px; white-space:nowrap; }
    .sbadge i{ width:6px; height:6px; border-radius:50%; background:currentColor; }
    .sbadge.ok{ color:var(--ok); background:#e8f5ee; } .sbadge.warn{ color:var(--warn); background:#fbeede; } .sbadge.down{ color:var(--down); background:#fae9e7; } .sbadge.idle{ color:var(--body); background:var(--hairline); }
    .uptime{ display:flex; gap:2px; align-items:flex-end; height:22px; }
    .ubar{ width:5px; border-radius:1px; } .ubar.g{ background:var(--ok); } .ubar.w{ background:var(--warn); } .ubar.b{ background:var(--down); } .ubar.i{ background:var(--hairline); }
    .trow .calls{ font-family:var(--mono); font-size:12px; color:var(--body); text-align:right; }

    .grid2{ display:grid; grid-template-columns:1fr 1fr; gap:var(--x3); align-items:start; }
    .kv{ display:flex; align-items:center; gap:10px; margin-bottom:10px; }
    .kv .k{ font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--body); width:64px; flex:0 0 auto; }
    .kv code{ font-family:var(--mono); font-size:12px; color:var(--ink); background:var(--canvas); border:1px solid var(--hairline); border-radius:var(--r-sm); padding:5px 10px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .subtabs{ display:flex; gap:6px; flex-wrap:wrap; margin:6px 0 12px; background:var(--hairline); padding:4px; border-radius:var(--r-sm); width:fit-content; }
    .subtab{ font-family:var(--mono); font-size:10px; font-weight:500; text-transform:uppercase; letter-spacing:.05em; color:var(--body); background:transparent; border:none; border-radius:var(--r-xs); padding:6px 13px; cursor:pointer; }
    .subtab.active{ color:var(--on-dark); background:var(--ink); }
    .editor{ border:1px solid var(--surface-dark-soft); border-radius:var(--r-sm); overflow:hidden; background:var(--canvas-dark); }
    .editor .bar{ display:flex; align-items:center; justify-content:space-between; padding:8px 12px; border-bottom:1px solid var(--surface-dark-soft); }
    .editor .meth{ font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:.06em; color:var(--on-dark-soft); }
    pre.code{ margin:0; padding:14px; font-family:var(--mono); font-size:11.5px; line-height:1.65; color:#d8dcf2; white-space:pre; overflow-x:auto; }
    .outbtn{ font-family:var(--mono); font-size:9.5px; font-weight:500; text-transform:uppercase; letter-spacing:.06em; color:var(--on-dark); background:var(--surface-dark-soft); border:1px solid var(--surface-dark-fill); border-radius:var(--r-xs); padding:4px 9px; cursor:pointer; }
    .outbtn.light{ color:var(--ink); background:var(--canvas); border:1px solid var(--hairline); }
    .outbtn.done{ color:var(--on-dark); background:var(--ok); border-color:var(--ok); }

    .field{ margin-bottom:12px; }
    .field label{ display:block; font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--body); margin-bottom:6px; }
    .field input,.field select,.field textarea{ width:100%; font:inherit; font-size:14px; color:var(--ink); background:var(--canvas); border:1px solid var(--hairline); border-radius:var(--r-sm); padding:10px 12px; }
    .field textarea{ min-height:92px; resize:vertical; font-family:var(--mono); font-size:13px; }
    .field input:focus,.field select:focus,.field textarea:focus{ outline:none; border-color:var(--ink); }
    .seg{ display:inline-flex; background:var(--hairline); padding:4px; border-radius:var(--r-sm); margin-bottom:14px; }
    .seg button{ font-family:var(--mono); font-size:10px; font-weight:500; text-transform:uppercase; letter-spacing:.05em; color:var(--body); background:transparent; border:none; border-radius:var(--r-xs); padding:7px 14px; cursor:pointer; }
    .seg button.active{ color:var(--on-dark); background:var(--ink); }
    .actions{ display:flex; align-items:center; gap:12px; }
    .btn-primary{ font-family:var(--mono); font-size:13px; font-weight:500; text-transform:uppercase; letter-spacing:.06em; color:var(--on-dark); background:var(--ink); border:none; border-radius:var(--r-sm); padding:11px 26px; cursor:pointer; }
    .btn-primary:disabled{ opacity:.5; cursor:wait; }
    .btn-outline{ font-family:var(--mono); font-size:12px; font-weight:500; text-transform:uppercase; letter-spacing:.06em; color:var(--ink); background:var(--canvas); border:1px solid var(--hairline); border-radius:var(--r-xs); padding:10px 18px; cursor:pointer; }
    .btn-outline:disabled{ opacity:.45; cursor:default; }
    .console-out{ border:1px solid var(--surface-dark-soft); border-radius:var(--r-sm); overflow:hidden; background:var(--canvas-dark); display:flex; flex-direction:column; min-height:236px; }
    .console-out .bar{ display:flex; align-items:center; justify-content:space-between; padding:8px 12px; border-bottom:1px solid var(--surface-dark-soft); }
    .console-out .tag{ font-family:var(--mono); font-size:9.5px; font-weight:500; letter-spacing:.1em; text-transform:uppercase; color:var(--on-dark-soft); }
    .console-out .meta{ font-family:var(--mono); font-size:10px; color:var(--on-dark-soft); opacity:.7; }
    .console-out .body{ flex:1; padding:14px; font-family:var(--mono); font-size:13px; line-height:1.6; color:#dfe2f5; white-space:pre-wrap; overflow-wrap:anywhere; overflow-y:auto; }

    .feedwrap{ display:grid; grid-template-columns:1.55fr 1fr; gap:var(--x3); align-items:start; }
    .feed{ border:1px solid var(--surface-dark-soft); border-radius:var(--r-sm); overflow:hidden; }
    .feed .fhead,.feed .frow{ display:grid; grid-template-columns:64px minmax(0,1.5fr) 78px 58px 60px 56px; gap:10px; align-items:center; padding:9px 12px; font-size:13px; }
    .feed .fhead{ background:var(--surface-dark-soft); font-family:var(--mono); font-size:9.5px; text-transform:uppercase; letter-spacing:.07em; color:var(--on-dark-soft); }
    .feed .frow{ border-top:1px solid var(--surface-dark-soft); }
    .feed .frow.fresh{ animation:fadein .45s ease; }
    @keyframes fadein{ from{ opacity:0; background:rgba(189,187,255,.12) } to{ opacity:1 } }
    .feed .rt{ font-family:var(--mono); font-size:11px; color:var(--on-dark-soft); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .feed .tm,.feed .lt,.feed .tk{ font-family:var(--mono); font-size:11px; color:var(--on-dark-soft); opacity:.7; }
    .feed .lt,.feed .tk{ text-align:right; }
    .dnbadge{ font-family:var(--mono); font-size:9.5px; text-transform:uppercase; letter-spacing:.04em; color:var(--on-dark); background:var(--surface-dark-soft); border-radius:var(--r-sm); padding:2px 8px; }
    .dsbadge{ font-family:var(--mono); font-size:9.5px; font-weight:600; padding:2px 7px; border-radius:var(--r-sm); }
    .dsbadge.s2{ color:var(--ok-d); background:rgba(61,220,132,.13); } .dsbadge.s4{ color:var(--warn-d); background:rgba(245,181,61,.14); } .dsbadge.s5{ color:var(--down-d); background:rgba(255,107,107,.14); }
    .dist{ display:flex; flex-direction:column; gap:12px; }
    .drow{ display:grid; grid-template-columns:150px 1fr 38px; gap:10px; align-items:center; }
    .dname{ font-family:var(--mono); font-size:11px; color:var(--on-dark-soft); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .dtrack{ height:8px; border-radius:2px; background:var(--surface-dark-soft); overflow:hidden; }
    .dfill{ height:100%; background:var(--periwinkle); transition:width .5s ease; }
    .dval{ font-family:var(--mono); font-size:11px; color:var(--on-dark-soft); opacity:.7; text-align:right; }
    .privacy{ margin-top:16px; font-family:var(--mono); font-size:11px; color:var(--on-dark-soft); opacity:.7; display:flex; gap:8px; align-items:center; }
    .empty{ padding:14px; font-family:var(--mono); font-size:12px; color:var(--body-faint); text-align:center; }
    .feed .empty,.dist .empty{ color:var(--on-dark-soft); opacity:.6; }
    .footnote{ display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; font-family:var(--mono); font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--body-faint); padding:var(--x3) 0 0; }
    .wordmark{ font-family:var(--sans); font-weight:500; letter-spacing:-.04em; color:var(--hairline); font-size:clamp(54px,15vw,190px); line-height:.9; text-align:center; padding:var(--x3) 0 var(--x5); user-select:none; }

    @media(max-width:980px){ .cmd .inner{ grid-template-columns:1fr; } .ribbon-wrap{ order:-1; min-height:150px; } .tiles{ grid-template-columns:repeat(2,1fr); } .grid2,.feedwrap{ grid-template-columns:1fr; } }
    @media(max-width:600px){ .inner{ padding:0 var(--lg); } .tiles,.meta-row{ grid-template-columns:1fr; } .matrix .thead,.matrix .trow{ grid-template-columns:1fr 84px; } .matrix .uptime,.matrix .calls{ display:none; } .feed .fhead,.feed .frow{ grid-template-columns:54px 1fr 56px 50px; } .feed .col-eng,.feed .tk{ display:none; } .drow{ grid-template-columns:110px 1fr 34px; } }
    @media(prefers-reduced-motion:reduce){ *,*::after{ animation:none !important; transition:none !important; } }
  </style>
</head>
<body>
  <header class="band band-dark cmd">
    <div class="inner">
      <div>
        <nav class="cmd-nav">
          <span class="logo-dot"></span><span class="name">AI CLI Bridge</span>
          <span class="spacer"></span>
          <button class="live-btn" id="live"><span class="pl"></span><span id="live-l">Live</span></button>
        </nav>
        <div class="eyebrow" style="margin-bottom:12px" id="env-line">PROVIDER · LOCAL</div>
        <h1 class="h-xxl">Provider <span class="h1grad">console</span></h1>
        <p class="lead">One OpenAI-compatible endpoint in front of your local Claude and Gemini CLIs, with live health, routing, and a built-in tester.</p>
        <div class="status-chips">
          <span class="chip"><span class="dot ok" id="d-prov"></span><span class="ck">Provider</span><span class="cv" id="v-prov">online</span></span>
          <span class="chip"><span class="dot" id="d-claude"></span><span class="ck">Claude</span><span class="cv num" id="v-claude">—</span></span>
          <span class="chip"><span class="dot" id="d-gemini"></span><span class="ck">Gemini</span><span class="cv num" id="v-gemini">—</span></span>
          <span class="chip"><span class="ck">Uptime</span><span class="cv num" id="v-up">—</span></span>
          <span class="chip"><span class="ck">Inflight</span><span class="cv num" id="v-inf">—</span></span>
        </div>
      </div>
      <div class="ribbon-wrap">
        <svg viewBox="0 0 520 320" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <defs><linearGradient id="rb" x1="0" y1="0" x2="1" y2="0.4"><stop offset="0" stop-color="#fc4c02"/><stop offset="0.54" stop-color="#ef2cc1"/><stop offset="1" stop-color="#bdbbff"/></linearGradient></defs>
          <g class="ribbon-grp" fill="none" stroke="url(#rb)" stroke-linecap="round">
            <path d="M-20 70 C 120 10, 260 150, 400 70 S 620 30, 720 110" stroke-width="26" opacity="0.95"/>
            <path d="M-20 120 C 130 60, 250 200, 410 120 S 600 90, 720 160" stroke-width="20" opacity="0.6"/>
            <path d="M-20 180 C 120 120, 280 250, 420 180 S 610 150, 720 210" stroke-width="14" opacity="0.4"/>
            <path d="M-20 240 C 140 190, 270 300, 430 240 S 600 220, 720 270" stroke-width="9" opacity="0.25"/>
          </g>
        </svg>
      </div>
    </div>
  </header>

  <section class="band sec">
    <div class="inner">
      <div class="sec-head"><span class="eyebrow">Telemetry</span><span class="note">in-memory · resets on restart · est. tokens ~4 chars/tok</span></div>
      <div class="tiles">
        <div class="tile mint"><div class="tl">Requests served</div><div class="big num" id="k-total">0</div><div class="sub"><span id="k-rate">—</span> success · <span class="num" id="k-err">0</span> errors</div><svg class="trend" id="spark-lat" viewBox="0 0 220 30" preserveAspectRatio="none"></svg></div>
        <div class="tile peach"><div class="tl">Avg latency</div><div class="big num" id="k-lat">0<small>ms</small></div><div class="sub">across <span class="num" id="k-latn">0</span> calls</div></div>
        <div class="tile peri"><div class="tl">Est. token usage</div><div class="big num" id="k-tok">0</div><div class="tok-bar"><div class="p" id="tok-p" style="width:40%"></div><div class="c" id="tok-c" style="width:60%"></div></div><div class="tok-leg"><span><i style="background:var(--ink)"></i>prompt <span class="num" id="tok-pv">0</span></span><span><i style="background:var(--periwinkle)"></i>compl. <span class="num" id="tok-cv">0</span></span></div></div>
        <div class="tile plain"><div class="tl">Reliability</div><div class="big num" id="k-rate2">—</div><div class="sub">429: <span class="num" id="k-429">0</span> · 5xx: <span class="num" id="k-5xx">0</span></div></div>
      </div>
      <div class="meta-row">
        <div class="panel"><div class="ph"><span class="eyebrow">Inflight slots</span><span class="mono" style="font-size:10px;color:var(--body-faint)" id="slot-max">max 1 / engine</span></div>
          <div class="slot"><span class="eng">claude</span><div class="pips" id="pips-claude"></div><span class="cnt num" id="cnt-claude">0/1</span></div>
          <div class="slot"><span class="eng">gemini</span><div class="pips" id="pips-gemini"></div><span class="cnt num" id="cnt-gemini">0/1</span></div>
        </div>
        <div class="panel"><div class="ph"><span class="eyebrow">By engine</span><span class="mono" style="font-size:10px;color:var(--body-faint)">share of calls</span></div>
          <div class="dist" id="by-engine" style="margin-top:14px"></div>
        </div>
      </div>
    </div>
  </section>

  <section class="band sec" style="padding-top:0">
    <div class="inner">
      <div class="sec-head"><span class="eyebrow">Engine &amp; model health</span><span class="note">passive · from real traffic + /health pings</span></div>
      <div class="table matrix">
        <div class="thead"><span>Model route</span><span>Engine</span><span>Status</span><span>Uptime</span><span>Calls</span></div>
        <div id="matrix"></div>
      </div>
    </div>
  </section>

  <section class="band sec" style="padding-top:0">
    <div class="inner">
      <div class="sec-head"><span class="eyebrow">Connect an app</span></div>
      <div class="grid2">
        <div>
          <div class="kv"><span class="k">Base URL</span><code id="c-base">—</code><button class="outbtn light" data-copy="c-base">Copy</button></div>
          <div class="kv"><span class="k">Auth</span><code id="c-auth">—</code><button class="outbtn light" data-copy="c-auth">Copy</button></div>
          <div class="kv"><span class="k">Default</span><code id="c-model">—</code><button class="outbtn light" data-copy="c-model">Copy</button></div>
          <p class="mono" style="font-size:11px;color:var(--body);line-height:1.6;margin-top:14px">Point any OpenAI-compatible client at the base URL. The route id is the model name.</p>
        </div>
        <div>
          <div class="subtabs" id="conn-tabs"><button class="subtab active" data-snip="hermes">Hermes</button><button class="subtab" data-snip="curl">curl</button><button class="subtab" data-snip="js">OpenAI JS</button><button class="subtab" data-snip="python">Python</button></div>
          <div class="editor"><div class="bar"><span class="meth" id="snip-meth">~/.hermes/config.yaml</span><button class="outbtn" data-copy="snip-code">Copy</button></div><pre class="code" id="snip-code"></pre></div>
        </div>
      </div>
    </div>
  </section>

  <section class="band sec" style="padding-top:0">
    <div class="inner">
      <div class="sec-head"><span class="eyebrow">Prompt Tester</span><span class="note">POST /v1/chat/completions · non-streaming &amp; SSE</span></div>
      <div class="grid2">
        <div>
          <div class="field"><label for="t-key">Provider API key</label><input id="t-key" type="password" placeholder="Bearer token"></div>
          <div class="field"><label for="t-model">Model route</label><select id="t-model"></select></div>
          <div class="field"><label for="t-prompt">Prompt</label><textarea id="t-prompt">Reply with exactly: bridge-ok</textarea></div>
          <div class="field" style="margin-bottom:14px"><label>Transport</label><div class="seg" id="seg"><button data-s="stream" class="active">SSE stream</button><button data-s="block">Non-streaming</button></div></div>
          <div class="actions"><button class="btn-primary" id="t-run">Run</button><button class="btn-outline" id="t-stop" disabled>Stop</button><span class="mono" id="t-status" style="font-size:11px;color:var(--body-faint)">Ready</span></div>
        </div>
        <div><div class="console-out"><div class="bar"><span class="tag">Response</span><span class="meta" id="t-meta">awaiting run</span></div><div class="body" id="t-out">No response yet.</div></div></div>
      </div>
    </div>
  </section>

  <section class="band band-dark sec">
    <div class="inner">
      <div class="sec-head"><span class="eyebrow">Live request stream</span><span class="note" style="color:var(--on-dark-soft);opacity:.6">newest first · metadata only</span></div>
      <div class="feedwrap">
        <div>
          <div class="feed"><div class="fhead"><span>Time</span><span>Route</span><span class="col-eng">Engine</span><span>Status</span><span>Latency</span><span class="tk">Tokens</span></div><div id="feed"></div></div>
          <div class="privacy"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>Prompts and responses are never stored or shown, counts, status, route, latency, and estimated tokens only.</div>
        </div>
        <div><div class="eyebrow" style="margin-bottom:14px">Route distribution</div><div class="dist" id="dist"></div></div>
      </div>
    </div>
  </section>

  <section class="band"><div class="inner"><div class="footnote"><span>AI CLI Bridge · Provider Console</span><span id="foot-auth">local only</span></div></div><div class="wordmark">ai-cli-bridge</div></section>

  <script>
    var state = { data:null, snip:'hermes', live:true };
    var keyInput = document.getElementById('t-key');
    keyInput.value = localStorage.getItem('providerApiKey') || '';

    function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); }
    function fmt(n){ return (Number(n)||0).toLocaleString('en-US'); }
    function ftok(n){ n=Number(n)||0; if(n>=1e6) return (n/1e6).toFixed(2)+'M'; if(n>=1e3) return (n/1e3).toFixed(1)+'k'; return String(n); }
    function pctv(a,b){ return b?Math.round(a/b*100):0; }
    function fmtUptime(s){ if(!isFinite(s)) return '—'; s=Math.floor(s); var h=Math.floor(s/3600),m=Math.floor(s/60)%60,ss=s%60; return h?h+'h '+m+'m':m?m+'m '+ss+'s':ss+'s'; }
    function tval(d){ return new Date(d).toLocaleTimeString(); }
    function setDot(id,cls){ var e=document.getElementById(id); e.className='dot'+(cls?' '+cls:''); }

    function spark(svg, data, color){
      if(!data.length){ svg.innerHTML=''; return; }
      var W=220,H=30,pad=3,mn=Math.min.apply(null,data),mx=Math.max.apply(null,data),rng=(mx-mn)||1,step=W/Math.max(1,data.length-1);
      var pts=data.map(function(v,i){ return [i*step, H-pad-((v-mn)/rng)*(H-pad*2)]; });
      var line=pts.map(function(p,i){ return (i?'L':'M')+p[0].toFixed(1)+' '+p[1].toFixed(1); }).join(' ');
      var last=pts[pts.length-1];
      svg.innerHTML='<path d="'+line+' L'+W+' '+H+' L0 '+H+' Z" fill="'+color+'" opacity="0.12"/><path d="'+line+'" fill="none" stroke="'+color+'" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/><circle cx="'+last[0].toFixed(1)+'" cy="'+last[1].toFixed(1)+'" r="2.3" fill="'+color+'"/>';
    }
    function uptimeStrip(history){
      var arr=(history||[]).slice(-30);
      if(!arr.length){ var o=''; for(var i=0;i<30;i++) o+='<span class="ubar i" style="height:9px"></span>'; return o; }
      return arr.map(function(s){ var c=s.ok?'g':'b'; var h=s.ok?(12+Math.round((s.source==='traffic')?6:3)):14; return '<span class="ubar '+c+'" style="height:'+h+'px"></span>'; }).join('');
    }

    function engineState(eng){
      var e = state.data && state.data.engines && state.data.engines[eng];
      if(!e) return { cls:'idle', label:'Idle', ok:false };
      if(!e.ok) return { cls:'down', label:'Down', ok:false };
      var busy = state.data.inflight && state.data.inflight[eng] > 0;
      return { cls: busy?'warn':'ok', label: busy?'Busy':'Operational', ok:true };
    }

    function renderHero(d){
      document.getElementById('env-line').textContent='PROVIDER · '+(d.connection?d.connection.baseUrl.replace('/v1',''):'LOCAL').replace(/^https?:\\/\\//,'');
      var c=engineState('claude'), g=engineState('gemini');
      setDot('d-prov','ok'); document.getElementById('v-prov').textContent=d.status||'online';
      setDot('d-claude',c.cls); document.getElementById('v-claude').textContent=(d.engines.claude.ok?(d.engines.claude.durationMs+'ms'):'down');
      setDot('d-gemini',g.cls); document.getElementById('v-gemini').textContent=(d.engines.gemini.ok?(d.engines.gemini.durationMs+'ms'):'down');
      document.getElementById('v-up').textContent=fmtUptime(d.uptime);
      document.getElementById('v-inf').textContent=(d.inflight.claude||0)+' / '+(d.inflight.gemini||0);
      document.getElementById('foot-auth').textContent=d.authEnabled?'auth enabled · local':'open · local';
    }

    function renderKpis(d){
      var t=d.telemetry;
      document.getElementById('k-total').textContent=fmt(t.recentCount);
      var rate = t.successRate!=null ? Math.round(t.successRate*100)+'%' : (t.recentCount?pctv(t.successCount,t.recentCount)+'%':'—');
      document.getElementById('k-rate').textContent=rate;
      document.getElementById('k-rate2').textContent=rate;
      document.getElementById('k-err').textContent=fmt(t.errorCount);
      document.getElementById('k-lat').innerHTML=fmt(t.avgLatencyMs)+'<small>ms</small>';
      document.getElementById('k-latn').textContent=fmt(t.recentCount);
      var tot=(t.estTotalTokens)||0;
      document.getElementById('k-tok').textContent=ftok(tot);
      document.getElementById('tok-pv').textContent=ftok(t.estPromptTokens);
      document.getElementById('tok-cv').textContent=ftok(t.estCompletionTokens);
      document.getElementById('tok-p').style.width=pctv(t.estPromptTokens,tot)+'%';
      document.getElementById('tok-c').style.width=pctv(t.estCompletionTokens,tot)+'%';
      var rej=0,s5=0; (d.recentRequests||[]).forEach(function(r){ if(r.statusClass==='rejected')rej++; else if(r.statusClass==='server_error')s5++; });
      document.getElementById('k-429').textContent=fmt(rej);
      document.getElementById('k-5xx').textContent=fmt(s5);
      var lat=(d.recentRequests||[]).slice(0,40).map(function(r){return r.durationMs||0;}).reverse();
      spark(document.getElementById('spark-lat'), lat, '#fc4c02');
      // inflight slots
      var max=t.maxConcurrent||1;
      document.getElementById('slot-max').textContent='max '+max+' / engine';
      ['claude','gemini'].forEach(function(e){
        var on=d.inflight[e]||0, html='';
        for(var i=0;i<max;i++){ html+='<span class="pip'+(i<on?' on':'')+'"></span>'; }
        document.getElementById('pips-'+e).innerHTML=html;
        document.getElementById('cnt-'+e).textContent=on+'/'+max;
      });
      // by engine
      var pe=t.perEngine||{}, tote=(pe.claude||0)+(pe.gemini||0);
      document.getElementById('by-engine').innerHTML=['gemini','claude'].map(function(e){
        return '<div class="drow" style="grid-template-columns:64px 1fr 38px"><span class="dname" style="color:var(--body)">'+e+'</span><div class="dtrack" style="background:var(--hairline)"><div class="dfill" style="background:var(--ink);width:'+pctv(pe[e]||0,tote)+'%"></div></div><span class="dval" style="color:var(--body)">'+pctv(pe[e]||0,tote)+'%</span></div>';
      }).join('');
    }

    function renderMatrix(d){
      var perRoute={}; (d.telemetry.perRoute||[]).forEach(function(r){ perRoute[r.routeId]=r; });
      var health={}; (d.telemetry.perEngineHealth||[]).forEach(function(h){ health[h.engine]=h; });
      document.getElementById('matrix').innerHTML=(d.routes||[]).map(function(r){
        var es=engineState(r.engine);
        var hist=(d.engines[r.engine]&&d.engines[r.engine].history)||[];
        var up=health[r.engine]&&health[r.engine].uptimePct!=null?health[r.engine].uptimePct+'%':'—';
        var pr=perRoute[r.id];
        var calls=pr?(pr.success+'/'+pr.count):'—';
        return '<div class="trow"><div class="mname"><div class="t">'+esc(r.label)+'</div><div class="id">'+esc(r.id)+'</div></div>'+
          '<div><span class="nbadge">'+esc(r.engine)+'</span></div>'+
          '<div><span class="sbadge '+es.cls+'"><i></i>'+es.label+'</span></div>'+
          '<div class="uptime" title="engine uptime '+up+'">'+uptimeStrip(hist)+'</div>'+
          '<div class="calls num" title="success/total">'+calls+'</div></div>';
      }).join('');
    }

    function buildSnippets(d){
      var base=d.connection.baseUrl, def=d.defaultRoute, key=d.authEnabled?'<key>':'test-key';
      var models=(d.routes||[]).map(function(r){ return '      - '+r.id; }).join('\\n');
      return {
        hermes:{ meth:'~/.hermes/config.yaml', code:'providers:\\n  ai-cli-bridge:\\n    type: openai\\n    base_url: '+base+'\\n    api_key: \${AI_CLI_BRIDGE_API_KEY}\\n    models:\\n'+models },
        curl:{ meth:'POST /v1/chat/completions', code:'curl '+base+'/chat/completions \\\\\\n  -H "Authorization: Bearer '+key+'" \\\\\\n  -H "Content-Type: application/json" \\\\\\n  -d \\'{"model":"'+def+'","messages":[{"role":"user","content":"Hello"}]}\\'' },
        js:{ meth:'openai · node', code:'import OpenAI from "openai";\\n\\nconst client = new OpenAI({ baseURL: "'+base+'", apiKey: "'+key+'" });\\nconst res = await client.chat.completions.create({\\n  model: "'+def+'",\\n  messages: [{ role: "user", content: "Hello" }],\\n});\\nconsole.log(res.choices[0].message.content);' },
        python:{ meth:'openai · python', code:'from openai import OpenAI\\n\\nclient = OpenAI(base_url="'+base+'", api_key="'+key+'")\\nres = client.chat.completions.create(\\n    model="'+def+'",\\n    messages=[{"role": "user", "content": "Hello"}],\\n)\\nprint(res.choices[0].message.content)' }
      };
    }
    function renderConnection(d){
      document.getElementById('c-base').textContent=d.connection.baseUrl;
      document.getElementById('c-auth').textContent=d.connection.authHeader;
      document.getElementById('c-model').textContent=d.defaultRoute;
      state.snippets=buildSnippets(d);
      renderSnip();
    }
    function renderSnip(){
      var s=state.snippets&&state.snippets[state.snip]; if(!s) return;
      document.getElementById('snip-code').textContent=s.code;
      document.getElementById('snip-meth').textContent=s.meth;
      var tabs=document.querySelectorAll('#conn-tabs .subtab');
      for(var i=0;i<tabs.length;i++) tabs[i].classList.toggle('active',tabs[i].getAttribute('data-snip')===state.snip);
    }

    function renderFeed(d){
      var list=d.recentRequests||[];
      document.getElementById('feed').innerHTML=list.length?list.map(function(r){
        var sc=r.status>=500?'s5':r.status>=400?'s4':'s2';
        return '<div class="frow"><span class="tm num">'+esc(tval(r.at))+'</span><span class="rt" title="'+esc(r.aliasUsed)+'">'+esc(r.label)+'</span><span class="col-eng"><span class="dnbadge">'+esc(r.engine||'—')+'</span></span><span><span class="dsbadge '+sc+'">'+esc(r.status)+'</span></span><span class="lt num">'+esc(r.durationMs)+'ms</span><span class="tk num">'+ftok(r.estTotalTokens)+'</span></div>';
      }).join(''):'<div class="empty">No calls yet</div>';
      var pr=(d.telemetry.perRoute||[]).slice().sort(function(a,b){return b.count-a.count;});
      var max=pr.reduce(function(m,r){return Math.max(m,r.count);},0)||1;
      document.getElementById('dist').innerHTML=pr.length?pr.map(function(r){
        return '<div class="drow"><span class="dname" title="'+esc(r.label)+'">'+esc(r.label)+'</span><div class="dtrack"><div class="dfill" style="width:'+Math.round(r.count/max*100)+'%"></div></div><span class="dval num">'+r.count+'</span></div>';
      }).join(''):'<div class="empty">No routed calls yet</div>';
    }

    function renderModels(d){
      var sel=document.getElementById('t-model'), prev=sel.value||d.defaultRoute;
      sel.innerHTML=(d.routes||[]).map(function(r){ return '<option value="'+esc(r.id)+'">'+esc(r.label)+'</option>'; }).join('');
      if((d.routes||[]).some(function(r){return r.id===prev;})) sel.value=prev; else sel.value=d.defaultRoute;
    }

    async function refresh(){
      if(!state.live) return;
      try{
        var res=await fetch('/dashboard/status'); var d=await res.json(); state.data=d;
        renderHero(d); renderKpis(d); renderMatrix(d); renderConnection(d); renderFeed(d);
        if(!document.getElementById('t-model').options.length) renderModels(d);
      }catch(e){ setDot('d-prov','down'); document.getElementById('v-prov').textContent='refresh failed'; }
    }

    function copyFrom(id, btn){
      var el=document.getElementById(id); if(!el) return; var text=el.textContent;
      var done=function(){ var o=btn.textContent; btn.textContent='Copied'; btn.classList.add('done'); setTimeout(function(){ btn.textContent=o; btn.classList.remove('done'); },1100); };
      if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done,done); else done();
    }
    document.addEventListener('click',function(e){
      var b=e.target.closest&&e.target.closest('[data-copy]'); if(b){ copyFrom(b.getAttribute('data-copy'),b); return; }
      var t=e.target.closest&&e.target.closest('#conn-tabs .subtab'); if(t){ state.snip=t.getAttribute('data-snip'); renderSnip(); }
    });

    var streaming=true, abortCtl=null;
    document.getElementById('seg').addEventListener('click',function(e){ var b=e.target.closest('button'); if(!b)return; streaming=b.getAttribute('data-s')==='stream'; var btns=this.querySelectorAll('button'); for(var i=0;i<btns.length;i++) btns[i].classList.toggle('active',btns[i]===b); });
    document.getElementById('t-stop').addEventListener('click',function(){ if(abortCtl) abortCtl.abort(); });
    document.getElementById('t-run').addEventListener('click',runTest);

    async function runTest(){
      var model=document.getElementById('t-model').value, key=keyInput.value;
      var out=document.getElementById('t-out'), meta=document.getElementById('t-meta'), st=document.getElementById('t-status');
      localStorage.setItem('providerApiKey', key);
      document.getElementById('t-run').disabled=true; document.getElementById('t-stop').disabled=!streaming;
      st.textContent='Running'; out.textContent=''; meta.textContent=streaming?'SSE · streaming…':'POST · running…';
      var t0=Date.now();
      var body={ model:model, messages:[{role:'user',content:document.getElementById('t-prompt').value}] };
      var headers={ 'Authorization':'Bearer '+key, 'Content-Type':'application/json', 'X-App-Id':'dashboard-tester' };
      abortCtl=new AbortController();
      try{
        if(streaming){
          body.stream=true;
          var res=await fetch('/v1/chat/completions',{method:'POST',headers:headers,body:JSON.stringify(body),signal:abortCtl.signal});
          if(!res.ok){ out.textContent=await res.text(); meta.textContent='error '+res.status; return; }
          var reader=res.body.getReader(), dec=new TextDecoder(), buf='', acc='';
          while(true){
            var rd=await reader.read(); if(rd.done) break;
            buf+=dec.decode(rd.value,{stream:true});
            var parts=buf.split('\\n\\n'); buf=parts.pop();
            for(var i=0;i<parts.length;i++){
              var ln=parts[i].trim(); if(ln.indexOf('data:')!==0) continue;
              var data=ln.slice(5).trim(); if(data==='[DONE]') continue;
              try{ var j=JSON.parse(data); var dl=j.choices&&j.choices[0]&&j.choices[0].delta; if(dl&&dl.content){ acc+=dl.content; out.textContent=acc; out.scrollTop=out.scrollHeight; } }catch(_){}
            }
          }
          meta.textContent='200 · streamed · '+(Date.now()-t0)+'ms';
          st.textContent='Done';
        } else {
          var res2=await fetch('/v1/chat/completions',{method:'POST',headers:headers,body:JSON.stringify(body),signal:abortCtl.signal});
          var d2=await res2.json();
          out.textContent=(d2.choices&&d2.choices[0])?d2.choices[0].message.content:JSON.stringify(d2,null,2);
          meta.textContent=(res2.ok?'200 · ok':'error '+res2.status)+' · '+(Date.now()-t0)+'ms';
          st.textContent=res2.ok?'Done':'Error '+res2.status;
        }
      }catch(err){ out.textContent=String(err&&err.message||err); st.textContent='aborted/error'; meta.textContent='error'; }
      finally{ document.getElementById('t-run').disabled=false; document.getElementById('t-stop').disabled=true; abortCtl=null; refresh(); }
    }

    document.getElementById('live').addEventListener('click',function(){ state.live=!state.live; this.classList.toggle('paused',!state.live); document.getElementById('live-l').textContent=state.live?'Live':'Paused'; if(state.live) refresh(); });

    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;
}

module.exports = { dashboardHtml };
