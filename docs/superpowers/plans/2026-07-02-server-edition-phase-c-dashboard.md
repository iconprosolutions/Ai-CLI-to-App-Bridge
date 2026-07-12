# Server Edition Phase C — Dashboard Implementation Plan

> **For agentic workers:** Backend tasks are TDD (tests first). Dashboard UI (static app.js/index.html/styles.css) is verified by a live smoke against the running provider, since there is no DOM test harness. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Surface the Phase A pool and Phase B keys in the control center. A new **Accounts tab** (per-account cards: state, breaker countdown, inflight, probe, enable/disable, needs-login command), **Connect-tab key management** (admin list/mint/revoke, secret shown once), and an **account/key dimension** in the Usage tab.

**Architecture:** Two small backend gaps first, both testable with the existing fake-CLI harness: (1) admin `enable`/`disable` for a pooled account (in-memory, mirrors engine enable/disable — accounts.json stays the source of truth on reload); (2) `usage.js aggregate()` gains `perAccount` + `perKey` rollups (the ledger already carries `account` and `keyName` from Phase A/B). Then the static dashboard grows one tab and two panels — no build step, same `renderAll()`/`admin()`/`ACTIONS` patterns already in `app.js`.

**Tech Stack:** Node.js, existing harness; vanilla dashboard JS.

**Verified facts this plan relies on:**
- `pool.snapshot()` already returns per account `{engine,name,dir,implicit,enabled,needsLogin,breaker,inflight,queued}` and is exposed at `status.accounts[engine][]`. `pool.accounts(engine)` returns the live account objects; `clearNeedsLogin`/`resetBreakers` exist; there is **no** setEnabled yet.
- `admin.js` already has `POST /accounts/:engine/:name/probe`. Engine enable/disable is in-memory via `enginesDisabled` — accounts follow the same runtime-toggle model.
- `usage.js aggregate()` produces `perApp`/`perRoute`/`perDay`; ledger entries carry `account` and `keyName`. Dashboard `admin()` helper, `ACTIONS` map, tab switching, and SSE `throttledRefresh` are all in place.

---

### Task 1: pool.setEnabled + admin account enable/disable

**Files:** Modify `packages/provider/accounts.js`, `packages/provider/admin.js`; test `tests/provider2.test.js`.

- [ ] **Step 1 (accounts.js):** add
```js
function setEnabled(engine, name, enabled) {
  const acct = state[engine] && state[engine].accounts.find((a) => a.name === name);
  if (!acct) return null;
  acct.enabled = Boolean(enabled);
  emit({ kind: 'enabled', engine, account: name, enabled: acct.enabled });
  return acct;
}
```
export it in the returned object.

- [ ] **Step 2 (admin.js):** two routes (admin-gated already):
```js
router.post('/accounts/:engine/:name/:op(enable|disable)', (req, res) => {
  const engine = engineOr404(req, res);
  if (!engine) return undefined;
  const enabled = req.params.op === 'enable';
  const acct = pool.setEnabled(engine, req.params.name, enabled);
  if (!acct) return res.status(404).json({ error: `Unknown account "${engine}:${req.params.name}"` });
  events.emit('account.change', { kind: 'enabled', engine, account: acct.name, enabled });
  return res.json({ engine, account: acct.name, enabled });
});
```

- [ ] **Step 3 (test):** in the accounts boot, `POST /admin/accounts/claude/w2/disable` → `select` returns only w1 for two calls (disabled account skipped); `…/w2/enable` → rotation spans both again; unknown account → 404. Run `node tests/provider2.test.js` → PASS.
- [ ] **Step 4: Commit** `feat(provider): admin enable/disable for pooled accounts`.

### Task 2: usage aggregate — perAccount + perKey

**Files:** Modify `packages/provider/usage.js`; test `tests/provider.test.js` or `tests/provider2.test.js` (whichever holds the ledger-aggregate unit test).

- [ ] **Step 1:** in `aggregate()`, add `perAccount` and `perKey` Maps keyed by `e.account || 'default'` / `e.keyName || 'legacy'`, each summing `{requests, promptTokens, completionTokens, usd, errors}`; return them sorted by requests desc (same shape as `perApp` minus the app-only accuracy field, which can stay).
- [ ] **Step 2 (test):** append ledger entries with `account`/`keyName` and assert the rollups group correctly and default/legacy fallbacks apply. Run → PASS.
- [ ] **Step 3: Commit** `feat(provider): usage rollups by account and by key`.

### Task 3: Accounts tab (dashboard)

**Files:** Modify `index.html`, `app.js`, `styles.css`.

- [ ] **Step 1 (index.html):** add `<button class="tab" data-view="accounts">Accounts<span class="cnt" id="cnt-accounts"></span></button>` after Routes; add `<main class="wrap view" id="view-accounts">` with a `#acct-cards` grid and a short note.
- [ ] **Step 2 (app.js):** `renderAccounts()` reads `state.status.accounts` (+ joins `state.usage.perAccount` for month tokens/value). One card per account showing: engine·name (+ `implicit`/`default` chip), a state badge (`needsLogin`→"Needs login", `!enabled`→"Disabled", breaker `open`→"Cooling · ~Ns", inflight>0→"Busy", else "Ready"), slots (inflight/queued), breaker line, and month tokens/value. Buttons via `data-act`: `acct-probe`, `acct-enable`/`acct-disable`; when `needsLogin`, show the one-time login command (`CLAUDE_CONFIG_DIR=<dir> claude` / `HOME=<dir> agy`) in a copyable `code`. Wire into `renderAll()` (`if (state.view === 'accounts') renderAccounts();`) and set `#cnt-accounts`.
- [ ] **Step 3 (ACTIONS):** `acct-probe` → `POST /admin/accounts/:e/:name/probe` (spinner, then refresh); `acct-enable`/`acct-disable` → the new endpoints. Add SSE `account.change` to the refresh listener list.
- [ ] **Step 4 (styles.css):** reuse `.ecard`/`.sbadge`/`.ekv`/`.eactions`; add only what's missing.
- [ ] **Step 5: Commit** `feat(dashboard): Accounts tab — per-account health, probe, enable/disable, login`.

### Task 4: Connect-tab key management

**Files:** Modify `index.html`, `app.js`.

- [ ] **Step 1 (index.html):** in the Connect view add an admin panel: a keys table (`#keys-table`), a mint form (name, role select, optional pins), and a "secret shown once" console (`#minted-key`, hidden until mint).
- [ ] **Step 2 (app.js):** `renderKeys()` calls `admin('GET','/admin/keys')` (only when a key is set; on 401/403 show "admin key required"); render rows (name, role, pins) with a Revoke button (`data-act="key-revoke"`). Mint posts `/admin/keys` and renders the returned secret **once** into `#minted-key` with a Copy button and a "copy now — not retrievable" warning. `key-revoke` → `DELETE /admin/keys/:name` (confirm). Call `renderKeys()` from `renderConnect()`.
- [ ] **Step 3: Commit** `feat(dashboard): Connect-tab named-key management (list/mint/revoke)`.

### Task 5: Usage account/key dimension

**Files:** Modify `index.html`, `app.js`.

- [ ] **Step 1:** add a segmented control to the "By app" panel header — `By app` / `By account` / `By key` — that re-renders the same table from `usage.perApp` / `perAccount` / `perKey`. Default `app`.
- [ ] **Step 2: Commit** `feat(dashboard): Usage tab account/key dimension`.

### Task 6: verification + docs

- [ ] **Step 1:** `npm test` + `npm run check` green.
- [ ] **Step 2:** Live smoke — write a two-account `accounts.json` + a second named key on a scratch runtime (or use the real one read-only), restart, and curl `/dashboard/status` (accounts present) and `/admin/keys` (admin). Load `/dashboard/` and confirm the three surfaces render (fetch the static assets + spot-check via the API the buttons call). Revert any scratch config.
- [ ] **Step 3:** Docs — `HOW-IT-WORKS.md` (dashboard tab table: Accounts row, Connect key mgmt, Usage dimension) + `STATE.md` (Phase C done).
- [ ] **Step 4: Commit** `docs: dashboard accounts + key management (server edition phase C)`.
