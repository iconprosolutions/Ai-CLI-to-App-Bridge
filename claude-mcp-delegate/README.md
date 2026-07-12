# Claude MCP Delegate

Hermes launches `delegate_server.py` as the `claude-delegate` MCP server. It wraps the local Claude Code CLI using your Claude subscription/OAuth auth and removes `ANTHROPIC_API_KEY` from the child environment so it does not accidentally use a billed API key.

## Tools

- `claude_delegate`: one plain-English front door. Use this first; it routes to the specialist tools below.
- `delegate_to_claude`: one-shot, backward-compatible delegation. Claude gets a complete task and exits.
- `start_claude_thread`: starts a persistent Claude Code print-mode conversation using a generated `--session-id`.
- `continue_claude_thread`: resumes a persistent conversation using `--resume <session_id>`.
- `list_claude_threads`: lists saved local thread records.
- `forget_claude_thread`: removes the local record without deleting Claude's own saved conversation.
- `start_interactive_claude`: starts a PTY-backed interactive Claude Code session for stdin/back-and-forth workflows.
- `send_to_interactive_claude`: sends text to an interactive session.
- `read_interactive_claude`: reads pending output from an interactive session.
- `list_interactive_claude_sessions`: lists running interactive sessions.
- `stop_interactive_claude`: terminates an interactive session.
- `desktop_screenshot`: captures the current macOS desktop to PNG.
- `desktop_applescript`: runs AppleScript via `osascript`.
- `desktop_open_url`: opens a URL or file with the default macOS app.
- `claude_delegate_capabilities`: reports the bridge capability map.

## Extra Claude Tooling

`claude_delegate`, `delegate_to_claude`, thread tools, and interactive sessions accept:

- `mcp_config`: a Claude Code MCP config path or JSON string to pass through as `--mcp-config`.
- `chrome`: true to pass Claude's `--chrome` flag.
- `cwd`: directory where Claude should run.
- `model`: per-call model override.

You can also set `CLAUDE_DELEGATE_MCP_CONFIG` in the MCP server environment to give Claude the same extra MCP config on every call.

## Plain-English Routing

Most callers should use `claude_delegate(request="...")`.

Examples:

- `claude_delegate(request="Review the Ops Hub auth flow and tell me the risky parts")`
- `claude_delegate(request="Keep context while you refactor this over several turns", mode="thread")`
- `claude_delegate(request="Continue the refactor and run tests", session_id="...")`
- `claude_delegate(request="This installer is asking for input; drive it interactively", mode="interactive")`
- `claude_delegate(request="Take a screenshot of the desktop")`

If auto-routing guesses wrong, set `mode` to one of: `one_shot`, `thread`, `interactive`, `screenshot`, `open`, `capabilities`, `list_threads`, `list_interactive`, `stop_interactive`, or `forget_thread`.

## Boundaries

This MCP server cannot directly invoke Hermes' private in-process tools for Claude. To give Claude Hermes-like tools, expose those tools as an MCP server that Claude Code can launch, then pass that config through `mcp_config` or `CLAUDE_DELEGATE_MCP_CONFIG`.

Interactive sessions are in-memory and only live while the MCP server process is alive. Persistent thread records are stored under `~/.claude-mcp-delegate/threads.json`.

## Network Mode

Hermes uses the default local `stdio` transport. Other clients can run the same server over MCP Streamable HTTP:

```bash
CLAUDE_DELEGATE_TRANSPORT=streamable-http \
CLAUDE_DELEGATE_HOST=127.0.0.1 \
CLAUDE_DELEGATE_PORT=8000 \
/Users/waqar/.hermes/hermes-agent/venv/bin/python delegate_server.py
```

The default endpoint path is `/mcp`; override it with `CLAUDE_DELEGATE_HTTP_PATH`.

Set `CLAUDE_DELEGATE_API_KEY` to require bearer-token auth in network mode:

```bash
CLAUDE_DELEGATE_API_KEY="$(openssl rand -hex 32)" \
CLAUDE_DELEGATE_TRANSPORT=streamable-http \
/Users/waqar/.hermes/hermes-agent/venv/bin/python delegate_server.py
```

Clients must then send `Authorization: Bearer <key>` with MCP HTTP requests.

For a private local network, bind to `127.0.0.1` and put an authenticated reverse proxy in front of it if another machine needs access. Do not expose this directly to the public internet without authentication, TLS, rate limits, and a clear allowlist, because it can run Claude Code with filesystem and shell access.
