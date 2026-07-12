# AI CLI Bridge Feature Map

## Current Surfaces

- Claude MCP delegate: Hermes-facing MCP server that wraps Claude Code subscription/OAuth usage.
- Claude HTTP bridge: app-facing HTTP wrapper around Claude Code print mode.
- Gemini/Antigravity HTTP bridge: app-facing HTTP wrapper around Antigravity `agy --print`.
- Provider bridge: private OpenAI-style `/v1` facade for Waqar's own apps.
- Provider dashboard: local operations console for provider health, engine reachability, model routes, app connection snippets, local request telemetry, recent non-sensitive calls, and quick prompt tests.
- Local launcher: `npm run bridge:up`, `npm run bridge:status`, and `npm run bridge:down` manage the three local HTTP bridge processes when they were started by the launcher.
- Hermes custom provider: `ai-cli-bridge` points Hermes at the provider bridge for text calls.

## Working Model Routes

- `bridge-agy-gemini-3.5-flash-medium-pulse`: balanced everyday app calls through Antigravity Gemini 3.5 Flash Medium.
- `bridge-agy-gemini-3.5-flash-high-forge`: stronger fast reasoning through Antigravity Gemini 3.5 Flash High.
- `bridge-agy-gemini-3.1-pro-high-atlas`: long context and broad project scans through Antigravity Gemini 3.1 Pro High.
- `bridge-claude-haiku-4.5-spark`: quick Claude responses through Claude Haiku.
- `bridge-claude-sonnet-4.6-northstar`: coding, planning, and careful reasoning through Claude Sonnet.
- `bridge-claude-opus-4.5-oracle`: harder reasoning through Claude Opus when usage limits allow.

The older `bridge-fast`, `bridge-smart`, `bridge-long`, `bridge-deep`, `gemini-*`, `claude-*`, `auto-*`, `gemini-cli-*`, and `claude-subscription-*` names remain accepted as hidden compatibility routes.

## Boundaries

- Private/internal use only.
- No public SaaS resale of subscription-backed Claude/Gemini usage.
- Hermes should prefer MCP delegate for agentic work.
- Apps should prefer provider bridge for normal model-call integration.
- Provider bridge supports OpenAI-style streaming and text-only compatibility with Hermes tool metadata.
- Provider bridge does not yet translate actual tool calls from OpenAI/Hermes format into local tool execution.
- Dashboard telemetry is in-memory request metadata only. It does not store prompts or response bodies.
