# AI CLI Bridge Feature Map

## Current Surfaces

- Claude MCP delegate: Hermes-facing MCP server that wraps Claude Code subscription/OAuth usage.
- Claude HTTP bridge: app-facing HTTP wrapper around Claude Code print mode.
- Gemini/Antigravity HTTP bridge: app-facing HTTP wrapper around Antigravity `agy --print`.
- Provider bridge: private OpenAI-style `/v1` facade for Waqar's own apps.
- Provider dashboard: local browser view for provider health, engine reachability, aliases, inflight counts, recent non-sensitive calls, and quick prompt tests.
- Local launcher: `npm run bridge:up`, `npm run bridge:status`, and `npm run bridge:down` manage the three local HTTP bridge processes when they were started by the launcher.

## Working Model Aliases

- `auto-fast`: Gemini 3.5 Flash through Antigravity.
- `auto-long-context`: Gemini through Antigravity.
- `gemini-cli-pro`: Gemini 3.1 Pro through Antigravity.
- `auto-reasoning`: Claude through Claude HTTP bridge.
- `claude-subscription-sonnet`: Claude Sonnet through Claude HTTP bridge.

## Boundaries

- Private/internal use only.
- No public SaaS resale of subscription-backed Claude/Gemini usage.
- Hermes should prefer MCP delegate for agentic work.
- Apps should prefer provider bridge for normal model-call integration.
