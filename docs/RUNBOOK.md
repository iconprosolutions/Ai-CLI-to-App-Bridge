# AI CLI Bridge Runbook

## Local Daily Use

From the repo root:

```bash
cd /Users/waqar/Projects/experiments/ai-cli-bridge
npm run bridge:up
```

Then open:

```text
http://127.0.0.1:9011/dashboard
```

Use this provider API key in the dashboard prompt tester unless you override it:

```text
test-key
```

## Check Status

```bash
cd /Users/waqar/Projects/experiments/ai-cli-bridge
npm run bridge:status
```

## Stop Launcher-Owned Processes

```bash
cd /Users/waqar/Projects/experiments/ai-cli-bridge
npm run bridge:down
```

`bridge:down` only stops processes started by `bridge:up`. If a bridge was started manually in a terminal tab, close that tab or press `Ctrl+C` in that tab.

## App Integration

Point OpenAI-compatible clients at:

```text
http://127.0.0.1:9011/v1/chat/completions
```

Send:

```text
Authorization: Bearer test-key
```

Recommended model routes:

- `bridge-agy-gemini-3.5-flash-medium-pulse` for balanced everyday app calls.
- `bridge-agy-gemini-3.5-flash-high-forge` for stronger fast reasoning through Antigravity.
- `bridge-agy-gemini-3.1-pro-high-atlas` for long documents and broad project scans.
- `bridge-claude-haiku-4.5-spark` for quick Claude responses.
- `bridge-claude-sonnet-4.6-northstar` for planning, coding, and careful reasoning through Claude Sonnet.
- `bridge-claude-opus-4.5-oracle` for hard reasoning through Claude Opus when usage limits allow.

Older short names such as `bridge-fast`, `bridge-smart`, `gemini-pro`, and `claude-opus` still work as hidden compatibility aliases, but new apps should use the explicit names above.

OpenAI SDK-style clients should use:

```text
Base URL: http://127.0.0.1:9011/v1
API Key: test-key
Model: bridge-agy-gemini-3.5-flash-medium-pulse
```

Raw HTTP clients should call:

```text
POST http://127.0.0.1:9011/v1/chat/completions
Authorization: Bearer test-key
```

## Hermes Integration

Hermes has a custom provider entry named:

```text
ai-cli-bridge
```

The provider points at:

```text
http://127.0.0.1:9011/v1
```

The API key lives in `~/.hermes/.env`:

```text
AI_CLI_BRIDGE_API_KEY=test-key
```

Restart Hermes after changing the config or `.env`. Then use the provider from Hermes with:

```bash
hermes -z "Reply with exactly: hermes-bridge-fast-ok" --provider ai-cli-bridge -m bridge-agy-gemini-3.5-flash-medium-pulse -t ""
```

Claude through the provider:

```bash
hermes -z "Reply with exactly: hermes-bridge-smart-ok" --provider ai-cli-bridge -m bridge-claude-sonnet-4.6-northstar -t ""
```

In the desktop UI, this appears as a configured provider/model route, not as an OAuth account. Look for `AI CLI Bridge` or `ai-cli-bridge` in the model/provider picker after restart.

Use the routes this way:

- `bridge-agy-gemini-3.5-flash-medium-pulse`: default everyday Hermes side-call through Gemini/Antigravity.
- `bridge-claude-sonnet-4.6-northstar`: Claude Sonnet through the local provider.
- `bridge-agy-gemini-3.1-pro-high-atlas`: Gemini Pro for long context.
- `bridge-claude-opus-4.5-oracle`: Claude Opus when limits allow.

Important boundary: provider mode is text-only compatibility for Hermes today. It accepts Hermes tool metadata so simple model calls work, but it does not yet translate real Hermes tool calls. Keep Hermes' main model on a normal provider for tool-heavy sessions, and keep using the Claude MCP delegate when Hermes should hand agentic coding work to Claude.

If `bridge-claude-sonnet-4.6-northstar` or another Claude route says Claude has hit a session limit, the bridge is still working; Claude Code is refusing the underlying subscription request. Use `bridge-agy-gemini-3.5-flash-medium-pulse` or `bridge-agy-gemini-3.1-pro-high-atlas` until Claude resets, then retry the Claude route.

The dashboard's telemetry is local request metadata only: counts, status, route, engine, latency, and estimated token usage. Token counts are a local heuristic (~4 chars/token on prompt + completion length), not a real tokenizer or billing data. Calls are attributed to an app via the optional `X-App-Id` request header (defaults to `default`). The dashboard never stores prompts or response text, and all telemetry is in-memory and resets when the provider process restarts.
