# AI CLI Bridge Feature Map

## Current Surfaces

- Claude MCP delegate: Hermes-facing MCP server that wraps Claude Code subscription/OAuth usage.
- Claude HTTP bridge: app-facing HTTP wrapper around Claude Code print mode.
- Gemini/Antigravity HTTP bridge: app-facing HTTP wrapper around Antigravity `agy --print`.
- Provider bridge: private OpenAI-style `/v1` facade for Waqar's own apps.

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
