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
