# AI CLI Bridge Decisions

## Provider Mode Target

Use an OpenAI-style Chat Completions facade for apps. It is the broadest compatibility target for existing app SDKs and keeps apps from spawning local CLIs directly.

## Runtime Split

Hermes uses the Claude MCP delegate for agentic work. Apps use the provider bridge. This keeps Hermes orchestration separate from app-facing model calls.

Hermes can also use the provider bridge as `ai-cli-bridge` for simple text calls. Do not make it the default Hermes main model for tool-heavy work until the bridge supports real tool-call translation.

## Gemini Runtime

Use Antigravity `agy --print`, not the old `gemini` CLI. The old Gemini CLI no longer supports individual Gemini Code Assist accounts.

## Deployment

Local Node processes first. Docker/NAS/Cloudflare come later, after real local app integration works.
