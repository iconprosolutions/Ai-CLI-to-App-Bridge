# AI CLI Bridge State

## Current Status

- Provider bridge v1 is implemented and committed.
- Gemini/Antigravity provider path is verified with real `agy`.
- Claude provider path is verified through the provider bridge.
- Provider bridge now includes a local browser dashboard at `/` and `/dashboard`, including a prompt tester.
- Local launcher scripts are available through `npm run bridge:up`, `npm run bridge:down`, and `npm run bridge:status`.
- Public app-facing model routes are now `bridge-fast`, `bridge-smart`, `bridge-long`, and `bridge-deep`, with direct `gemini-*` and `claude-*` routes available.
- Provider bridge supports OpenAI-style streaming responses and accepts Hermes tool metadata in text-only compatibility mode.
- Hermes is registered with a custom `ai-cli-bridge` provider in `~/.hermes/config.yaml`, using `AI_CLI_BRIDGE_API_KEY` from `~/.hermes/.env`.
- Hermes smoke tests pass through `bridge-fast`; `bridge-smart` reaches the provider correctly but currently depends on Claude Code session-limit availability.
- Tests pass with 56 bridge hardening checks and 107 provider checks.

## Local Test Ports

- Gemini/Antigravity bridge: `9003`
- Claude bridge: `9002`
- Provider bridge: `9011` for manual testing when `9010` is occupied

## Known Gaps

- Docker not installed locally and not currently needed.
- No always-on LaunchAgent/NAS service yet.
- Provider mode does not translate real Hermes tool calls yet; keep the Claude MCP delegate as the preferred path for agentic Claude work.
- Claude Code can return subscription/session-limit errors even when the bridge is healthy. The bridge now preserves those CLI messages for callers.
