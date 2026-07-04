# AI CLI Bridge Journal

## 2026-07-02

- [Claude Code] session 9c0c5520-fc52-4039-ab0e-269cafbc906e closed, 17 tool calls, 0 files read, 17 files written
- [Claude Code] session 54a8c865-54dc-4b47-9b39-91c580e863dd closed, 9 tool calls, 0 files read, 9 files written

## 2026-07-01

### Quick Note

[Claude] Shipped dashboard overhaul + DX hardening as 5 test-gated commits on feat/dashboard-overhaul (npm test 117/0 throughout). Phase A: launcher hardening (auto-generated persisted key with --insecure hatch, PATH binary discovery, loopback BIND_HOST, port 9011). Phase B: bridge probe/connect/restart/logs and --open. Phase C: additive /dashboard/status telemetry (maxConcurrent, successRate, tokensByEngine, engines.history, perEngineHealth) with passive health, no quota probes. Phase D: dashboardHtml restyled to Together AI (docs/DESIGN.md) with a live SSE-capable tester. Pinned test substrings and the /dashboard/status contract preserved. Phase E (SSE stream, CSP, auth-when-keyed) deferred as optional.

## 2026-06-28

- [Antigravity] Successfully onboarded ai-cli-bridge project to Dev OS with dedicated vault inventory, canonical Roadmap, Decisions log, and STATE tracking.
- Implemented real-time token streaming over SSE with a 10ms smooth token pacing queue in `provider-bridge/server.js`.
- Closed all 4 core model provider gaps (Native Tool Call Translation, Structured JSON output schemas, Multimodal array content parsing, and Token Usage statistics) verified with 117 passing unit tests.
- Hardened process lifecycles across all bridge servers with `res.on('close')` listeners and background server execution directives.
- Implemented Phase A of the launcher and DX overhaul: auto-generated API key persistence (`.bridge-runtime/credentials.json`), system PATH binary resolution (`agy`/`claude`), loopback BIND_HOST default, and standard port 9011 binding.
- Onboarded `ai-cli-bridge` into Dev OS with dedicated vault inventory (`Feature Map.md`), Roadmap (`Roadmap.md`), and Decisions log (`Decisions.md`).

## 2026-06-27

- Added Claude MCP delegate bridge and Hermes operating guidance.
- Hardened Claude/Gemini HTTP bridges with auth, CORS, path safety, timeouts, output caps, and tests.
- Added OpenAI-style provider bridge for private app use.
- Switched Gemini runtime from retired `gemini` CLI to Antigravity `agy`.
- Verified provider to Gemini 3.5 Flash and Gemini 3.1 Pro end to end.
- Verified provider to Claude end to end.
- Added the provider dashboard for local health, aliases, inflight counts, and recent non-sensitive calls.
- Added dashboard prompt testing and a local three-process bridge launcher.
- Replaced internal-looking public model names with clearer app routes while keeping old names as hidden compatibility aliases.
- Registered Hermes custom provider `ai-cli-bridge`, added provider streaming plus text-only tool metadata compatibility, and verified Hermes through `bridge-fast` and `bridge-smart`.
- Preserved nonzero CLI stdout in bridge error responses so Claude session-limit messages are visible to provider callers.
- Renamed public provider models to explicit bridge/model/suffix IDs and upgraded the dashboard into a local operations console with app snippets and request telemetry.
- Added estimated token-usage analytics (local char-based heuristic) with per-app attribution via `X-App-Id`, surfaced in the dashboard telemetry panel; no prompts or response text are stored.
