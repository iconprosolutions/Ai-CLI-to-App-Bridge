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

- `bridge-fast` for quick app calls, summaries, and drafts.
- `bridge-smart` for planning, coding, and careful reasoning through Claude Sonnet.
- `bridge-long` for long documents and broad project scans through Gemini Pro.
- `bridge-deep` for hard reasoning through Claude Opus when usage limits allow.

Provider-specific routes are also available when you deliberately want one engine:

- `gemini-flash`
- `gemini-pro`
- `claude-sonnet`
- `claude-opus`

OpenAI SDK-style clients should use:

```text
Base URL: http://127.0.0.1:9011/v1
API Key: test-key
Model: bridge-fast
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
hermes -z "Reply with exactly: hermes-bridge-fast-ok" --provider ai-cli-bridge -m bridge-fast -t ""
```

Claude through the provider:

```bash
hermes -z "Reply with exactly: hermes-bridge-smart-ok" --provider ai-cli-bridge -m bridge-smart -t ""
```

In the desktop UI, this appears as a configured provider/model route, not as an OAuth account. Look for `AI CLI Bridge` or `ai-cli-bridge` in the model/provider picker after restart.

Use the routes this way:

- `bridge-fast`: default everyday Hermes side-call through Gemini/Antigravity.
- `bridge-smart`: Claude Sonnet through the local provider.
- `bridge-long`: Gemini Pro for long context.
- `bridge-deep`: Claude Opus when limits allow.

Important boundary: provider mode is text-only compatibility for Hermes today. It accepts Hermes tool metadata so simple model calls work, but it does not yet translate real Hermes tool calls. Keep Hermes' main model on a normal provider for tool-heavy sessions, and keep using the Claude MCP delegate when Hermes should hand agentic coding work to Claude.

If `bridge-smart` or another Claude route says Claude has hit a session limit, the bridge is still working; Claude Code is refusing the underlying subscription request. Use `bridge-fast`/`bridge-long` until Claude resets, then retry the Claude route.
