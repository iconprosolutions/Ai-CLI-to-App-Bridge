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

Useful model aliases:

- `auto-fast` for Antigravity/Gemini Flash
- `gemini-cli-pro` for Antigravity/Gemini Pro
- `auto-reasoning` for Claude
