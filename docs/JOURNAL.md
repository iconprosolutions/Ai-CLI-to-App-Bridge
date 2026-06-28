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
