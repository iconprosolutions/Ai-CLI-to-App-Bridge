# AI CLI Bridge Journal

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
