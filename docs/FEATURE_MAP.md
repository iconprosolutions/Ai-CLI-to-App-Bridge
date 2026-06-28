# AI CLI Bridge Feature Map

## Current Surfaces

- Claude MCP delegate: Hermes-facing MCP server that wraps Claude Code subscription/OAuth usage.
- Claude HTTP bridge: app-facing HTTP wrapper around Claude Code print mode.
- Gemini/Antigravity HTTP bridge: app-facing HTTP wrapper around Antigravity `agy --print`.
- Provider bridge: private OpenAI-style `/v1` facade for Waqar's own apps.
- Provider dashboard: local browser view for provider health, engine reachability, aliases, inflight counts, recent non-sensitive calls, and quick prompt tests.
- Local launcher: `npm run bridge:up`, `npm run bridge:status`, and `npm run bridge:down` manage the three local HTTP bridge processes when they were started by the launcher.
- Hermes custom provider: `ai-cli-bridge` points Hermes at the provider bridge for text calls.

## Working Model Routes

- `bridge-fast`: Gemini 3.5 Flash through Antigravity for fast everyday calls.
- `bridge-smart`: Claude Sonnet through Claude HTTP bridge for planning, coding, and reasoning.
- `bridge-long`: Gemini 3.1 Pro through Antigravity for long-context work.
- `bridge-deep`: Claude Opus through Claude HTTP bridge for harder reasoning when usage limits allow.
- `gemini-flash`, `gemini-pro`, `claude-sonnet`, and `claude-opus`: direct provider routes.

The older `auto-*`, `gemini-cli-*`, and `claude-subscription-*` names remain accepted as hidden compatibility routes.

## Boundaries

- Private/internal use only.
- No public SaaS resale of subscription-backed Claude/Gemini usage.
- Hermes should prefer MCP delegate for agentic work.
- Apps should prefer provider bridge for normal model-call integration.
- Provider bridge supports OpenAI-style streaming and text-only compatibility with Hermes tool metadata.
- Provider bridge does not yet translate actual tool calls from OpenAI/Hermes format into local tool execution.
