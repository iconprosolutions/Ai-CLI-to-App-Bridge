# AI CLI Bridge State

## Current Status

- Provider bridge v1 is implemented and committed.
- Gemini/Antigravity provider path is verified with real `agy`.
- Claude provider path is verified through the provider bridge.
- Provider bridge now includes a local browser dashboard at `/` and `/dashboard`, including health, app snippets, route catalog, in-memory telemetry, recent calls, and a prompt tester.
- Local launcher scripts are available through `npm run bridge:up`, `npm run bridge:down`, and `npm run bridge:status`.
- Public app-facing model routes now use explicit model-plus-suffix names such as `bridge-agy-gemini-3.5-flash-medium-pulse`, `bridge-agy-gemini-3.1-pro-high-atlas`, and `bridge-claude-sonnet-4.6-northstar`.
- Provider bridge supports OpenAI-style streaming responses and accepts Hermes tool metadata in text-only compatibility mode.
- Hermes is registered with a custom `ai-cli-bridge` provider in `~/.hermes/config.yaml`, using `AI_CLI_BRIDGE_API_KEY` from `~/.hermes/.env`.
- Hermes smoke tests pass through the Gemini-backed public route; Claude-backed routes reach the provider correctly but currently depend on Claude Code session-limit availability.
- Tests pass with 56 bridge hardening checks and 116 provider checks.

## Local Test Ports

- Gemini/Antigravity bridge: `9003`
- Claude bridge: `9002`
- Provider bridge: `9011` for manual testing when `9010` is occupied

## Known Gaps

- Docker not installed locally and not currently needed.
- No always-on LaunchAgent/NAS service yet.
- Provider mode does not translate real Hermes tool calls yet; keep the Claude MCP delegate as the preferred path for agentic Claude work.
- Claude Code can return subscription/session-limit errors even when the bridge is healthy. The bridge now preserves those CLI messages for callers.
- Dashboard telemetry is in-memory only and resets when the provider process restarts.
