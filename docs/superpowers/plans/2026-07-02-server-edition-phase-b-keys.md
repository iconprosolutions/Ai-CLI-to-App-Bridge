# Server Edition Phase B — Named API Keys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:test-driven-development per task (tests first, watch them fail, implement, watch them pass). Steps use checkbox (`- [ ]`) tracking.

**Goal:** Replace the single provider key with **named keys** (one per app/teammate), each with a `role` (`admin` | `app`) and optional per-engine `accountPin`. Admin keys reach `/admin/*` and dashboard mutations; app keys reach `/v1/*` only. The usage ledger attributes every request to its `keyName`. A v1 `credentials.json` (`{"apiKey":"…"}`) migrates in place to v2 preserving the key value, so Hermes and the launcher keep working with zero changes.

**Architecture:** A new `packages/provider/keys.js` owns `credentials.json` (load, v1→v2 migration, verify, mint, revoke, list) — the same "own the file, validate precisely, keep it 0600" philosophy as `routes.js`/`accounts.js`. `server.js` swaps its single `API_KEY` string compare for the keystore: `/v1` auth attaches `req.auth = {name, role, accountPin}`; the admin router requires `role === 'admin'`. Account-pin precedence becomes **key pin → route pin → pool rotation**. The launcher (`scripts/bridge.js`) delegates bootstrap/migration to a shared keys.js helper so there is one source of truth for the file format.

**Tech Stack:** Node.js (zero new deps), existing fake-CLI + `bootProvider` harness.

**Verified facts this plan relies on:**
- Today `server.js:39` reads one `API_KEY` from env; `/v1` (server.js:119) and `admin.js:14` each do their own single-key `timingSafeEqual`. The launcher (`scripts/bridge.js:31-47`) generates + persists v1 `credentials.json` and passes the key via `PROVIDER_API_KEY`/`BRIDGE_API_KEY`.
- `record()` (server.js:232) already threads `account`; adding `keyName` is symmetric. `bootProvider` (tests/provider2.test.js) isolates `BRIDGE_USAGE_DIR`/`BRIDGE_ROUTES_FILE`/`BRIDGE_ACCOUNTS_FILE` — Phase B adds `BRIDGE_CREDENTIALS_FILE` so tests never touch the real file.
- Env key must remain valid (tests boot with `PROVIDER_API_KEY:'k'`; launcher passes it): the keystore treats any configured env key as an implicit **admin** key layered over the file.

---

### Task 1: `keys.js` keystore + unit suite

**Files:** Create `packages/provider/keys.js`, `tests/keys.test.js`; register the new suite in `package.json` `test` + `check`.

- [ ] **Step 1: Write failing tests** — `tests/keys.test.js` against a temp dir:
  1. **v1 migration** — write `{"apiKey":"deadbeef","createdAt":"…"}`; construct store; file is rewritten `version:2` with one key `{name:'admin',role:'admin',key:'deadbeef'}`; `verify('deadbeef')` → `{name:'admin',role:'admin'}`; file mode `0600`.
  2. **v2 verify** — known key → its `{name,role,accountPin}`; unknown token → `null`; wrong-length token → `null` (no throw).
  3. **env key** — no file + `envKey:'k'` → `verify('k')` → `{name:'env',role:'admin'}`; `authEnabled===true`.
  4. **open mode** — no file, no env → `authEnabled===false`; `verify('anything')===null`.
  5. **mint** — `mint({name:'hermes',role:'app',accountPin:{gemini:'main'}})` returns a record whose `key` is 48 lowercase hex; persisted; `verify(secret)` → app + pin; `list()` entries never carry a `key` field; duplicate name throws `/exists/`; bad role throws `/role/`; bad name (`'a b!'`) throws `/name/`; bad pin shape throws `/accountPin/`.
  6. **revoke** — `revoke('hermes')` removes it (`verify` → null); revoking unknown throws `/unknown/`; revoking the **last admin** throws `/last admin/`.
  7. **list** — returns `{name,role,accountPin,createdAt}` sorted by createdAt, no secrets.

- [ ] **Step 2: Run** `node tests/keys.test.js` → FAIL (module not found).

- [ ] **Step 3: Implement `packages/provider/keys.js`:**
  - `NAME_RE = /^[A-Za-z0-9._-]+$/`, `ROLES = new Set(['admin','app'])`, `KEY_RE = /^[0-9a-f]{48}$/`.
  - `validateAccountPin(pin)` — object of `engine→accountName` (values match NAME_RE) or throw `accountPin`.
  - `loadAndMigrate(file)` — read; if `{apiKey}` (no `version`), return `{version:2, keys:[{name:'admin',role:'admin',key:apiKey,createdAt}]}` **and** write it back 0600 (migration); if `version===2`, validate each key (name/role/key/pin, unique names) and return; if absent, return `{version:2, keys:[]}` without writing.
  - `createKeyStore({file, envKey})`:
    - Holds in-memory `data` from `loadAndMigrate`; the env key becomes an ephemeral admin record `{name:'env',role:'admin',key:envKey}` prepended for verification but **never persisted / never in `list()`**.
    - `verify(token)` — constant-time compare (`crypto.timingSafeEqual` on equal-length buffers) against every key; return a shallow `{name,role,accountPin}` clone or `null`.
    - `authEnabled` — `keys.length>0 || Boolean(envKey)`.
    - `list()` — persisted keys → `{name,role,accountPin,createdAt}`.
    - `mint({name,role,accountPin})` — validate; reject dup; generate `crypto.randomBytes(24).toString('hex')`; push; `persist()`; return full record incl. `key` (shown once).
    - `revoke(name)` — reject unknown; reject if it is the last `role:'admin'`; splice; `persist()`.
    - `persist()` — atomic write (`tmp`+`rename`) of `{version:2,keys}` at mode `0600`.
  - Export `createKeyStore`, `loadAndMigrate`, `bootstrapCredentialsFile`.
  - `bootstrapCredentialsFile(file)` (for the launcher): `loadAndMigrate`; if no admin key exists, mint one (generate, write); return `{adminKey:<first admin key value>, created:<bool>, migrated:<bool>}`.

- [ ] **Step 4: Run** `node tests/keys.test.js` → PASS. Add `node tests/keys.test.js` to `package.json` `test`, and `node --check packages/provider/keys.js && node --check tests/keys.test.js` to `check`.
- [ ] **Step 5: Commit** `feat(provider): named API key store (v2 credentials, roles, account pins, migration)`.

### Task 2: server.js — keystore wiring, key-pin precedence, keyName attribution

**Files:** Modify `packages/provider/server.js`.

- [ ] **Step 1:** Add `const CREDENTIALS_FILE = process.env.BRIDGE_CREDENTIALS_FILE || path.resolve(__dirname, '../../.bridge-runtime/credentials.json');` and `const keyStore = createKeyStore({ file: CREDENTIALS_FILE, envKey: API_KEY });`. Keep `API_KEY` only as the env-key input.
- [ ] **Step 2:** `/v1` auth middleware → `if (!keyStore.authEnabled) return next();` else `const who = keyStore.verify(token); if (!who) return sendError(401…); req.auth = who; next();`.
- [ ] **Step 3:** Request path — `const keyPin = req.auth && req.auth.accountPin ? req.auth.accountPin[route.engine] : null;` then `pool.select(route.engine, { pin: keyPin || route.account || null })`. A key pin also **disables failover** (already gated on `!route.account`; extend to `!route.account && !keyPin`).
- [ ] **Step 4:** `record()` gains `keyName: (req.auth && req.auth.name) || null` in both `telemetry.record` and `ledger.append`.
- [ ] **Step 5:** `/dashboard/status`: `authEnabled: keyStore.authEnabled`; `connection.authHeader` keyed off `keyStore.authEnabled`. Pass `keyStore` into `createAdminRouter`.
- [ ] **Step 6: Run** `node tests/provider2.test.js && node tests/provider.test.js && node tests/security.test.js` → PASS (env key `'k'` still authorizes /v1 as admin; no accounts/pins → behavior unchanged).
- [ ] **Step 7: Commit** `feat(provider): multi-key auth wired into /v1 (req.auth, key pin precedence, keyName in ledger)`.

### Task 3: admin.js — role gate + key management endpoints

**Files:** Modify `packages/provider/admin.js`.

- [ ] **Step 1:** Router signature `{ keyStore, … }` (drop `apiKey`). Guard: `if (!keyStore.authEnabled) 503 admin-disabled`; else `const who = keyStore.verify(token); if (!who) 401; if (who.role !== 'admin') 403 'Admin role required'; next()`.
- [ ] **Step 2:** Endpoints:
  - `GET /keys` → `{ keys: keyStore.list() }`.
  - `POST /keys` → validate body; `try { const rec = keyStore.mint(body); events.emit('keys.change',{action:'mint',name:rec.name}); res.json({name,role,accountPin,createdAt,key:rec.key}) } catch(e){ 400 }` (secret returned exactly once).
  - `DELETE /keys/:name` → `try { keyStore.revoke(name); events.emit('keys.change',{action:'revoke',name}); res.json({revoked:true}) } catch(e){ 400 }`.
- [ ] **Step 3: Run** `node tests/provider2.test.js` → PASS.
- [ ] **Step 4: Commit** `feat(provider): admin key management (mint/revoke/list, admin-role gate)`.

### Task 4: launcher — v2 bootstrap/migration

**Files:** Modify `scripts/bridge.js`.

- [ ] **Step 1:** `resolveKey()` keeps env priority and the `--insecure` hatch; the persisted branch calls `bootstrapCredentialsFile(CRED_FILE)` from `../packages/provider/keys.js` and returns `{ key: adminKey, source: migrated ? 'persisted (migrated v2)' : 'persisted' }`. A pre-existing v1 file is migrated on first `bridge up`.
- [ ] **Step 2: Run** `node --check scripts/bridge.js`; smoke `node scripts/bridge.js status` (no throw).
- [ ] **Step 3: Commit** `feat(launcher): bootstrap/migrate v2 named-key credentials`.

### Task 5: integration tests (roles, mint round-trip, key pin, ledger)

**Files:** Modify `tests/provider2.test.js`.

- [ ] **Step 1:** In `bootProvider`, add `process.env.BRIDGE_CREDENTIALS_FILE = path.join(TMP, \`creds-${port}.json\`);` (delete on teardown via the `oldEnv` restore) so the real file is never read/written.
- [ ] **Step 2:** `testKeys(port)` boot writing a v2 `credentials.json` with an `admin` key and an `app` key (app pins `claude:'w1'`), plus a two-account `accounts.json` and the env-logging claude stub:
  - app key → `/v1/chat/completions` **200**; app key → `GET /admin/keys` **403**; admin key → `/admin/keys` **200** listing both names with **no `key` field**.
  - `POST /admin/keys {name:'ci',role:'app'}` (admin) → 200 with a 48-hex `key`; that key then calls `/v1` → 200; `DELETE /admin/keys/ci` (admin) → 200; the deleted key → `/v1` **401**.
  - key-pin routing: the app key (pinned `claude:'w1'`) issued twice → env log shows **both** spawns under `…/w1` (pin overrides round-robin); ledger line (`BRIDGE_USAGE_DIR`) carries `keyName:'<app>'` and `account:'w1'`.
  - v1 migration boot: write a v1 `{apiKey:'legacyhex…'}` file, boot with **no** env key, `Bearer legacyhex…` → `/v1` 200 and file on disk now `version:2`.
- [ ] **Step 3: Run** `node tests/provider2.test.js` → all PASS.
- [ ] **Step 4: Commit** `test(provider): named keys — roles, mint/revoke, key pin routing, v1 migration`.

### Task 6: verification + docs

- [ ] **Step 1:** `for t in core pacer keys provider2 provider security; do node tests/$t.test.js || break; done` + `npm run check` → all green.
- [ ] **Step 2:** Live smoke: `bridge restart`; confirm the real `credentials.json` migrated to `version:2`, `bridge status` prints the admin key, one real `/v1` call still authorizes.
- [ ] **Step 3:** Docs — `HOW-IT-WORKS.md` (Named keys section: file format, roles, pin precedence, `BRIDGE_CREDENTIALS_FILE`, migration) and `STATE.md` (Phase B done).
- [ ] **Step 4: Commit** `docs: named API keys (server edition phase B)`.
