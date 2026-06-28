# AI CLI Bridge Roadmap

## Now

- Use the one-command launcher and dashboard for manual testing.
- Connect one real app to `http://127.0.0.1:9011/v1/chat/completions`.
- Use Hermes' `ai-cli-bridge` custom provider for simple text calls with `bridge-fast` and `bridge-smart`.

## Next

- Add an always-on Mac LaunchAgent once the local workflow feels stable.
- Add a fuller runbook for app integration examples.
- Improve the dashboard into an operating console: copy-ready app snippets, per-route examples, recent errors, and start/stop status.
- Decide whether to build real Hermes/OpenAI tool-call translation or keep provider mode text-only and rely on MCP for tools.

## Later

- Validate Docker only when deployment becomes important.
- Package for always-on hosting on Mac/NAS.
- Put Cloudflare Tunnel in front only after auth, local stability, and operational visibility are solid.
- Consider official API-key provider mode if external users ever need access.
