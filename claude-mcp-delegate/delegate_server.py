#!/usr/bin/env python3
"""
Claude delegation MCP server.

This server is launched by Hermes via ~/.hermes/config.yaml and exposes Claude
Code, running on the user's local Claude subscription/OAuth auth, as MCP tools.

The original one-shot delegation tool is still present. Additional tools add:
- a plain-English router tool for normal use
- resumable Claude Code print-mode threads via --session-id
- PTY-backed interactive Claude Code sessions for stdin-oriented workflows
- optional Claude-launched MCP config/chrome flags for extra tool surfaces
- lightweight macOS desktop helpers (AppleScript + screenshots)

Claude still cannot directly call Hermes' in-process tools unless those tools are
also exposed to Claude as an MCP server. Use the mcp_config argument/env var to
give Claude extra MCP servers at launch time.
"""
from __future__ import annotations

import datetime as _dt
import errno
import json
import os
import pty
import re
import select
import signal
import subprocess
import time
import uuid
from pathlib import Path
from typing import Any

from mcp.server.auth.provider import AccessToken, TokenVerifier
from mcp.server.auth.settings import AuthSettings
from mcp.server.fastmcp import FastMCP

CLAUDE = os.environ.get("CLAUDE_PATH", "/Users/waqar/.local/bin/claude")
MODEL = os.environ.get("CLAUDE_DELEGATE_MODEL", "claude-sonnet-4-6")
TIMEOUT_S = int(os.environ.get("CLAUDE_DELEGATE_TIMEOUT", "1800"))
DEFAULT_CWD = os.environ.get("CLAUDE_DELEGATE_CWD") or os.getcwd()
DEFAULT_MCP_CONFIG = os.environ.get("CLAUDE_DELEGATE_MCP_CONFIG", "").strip()
HOST = os.environ.get("CLAUDE_DELEGATE_HOST", "127.0.0.1")
PORT = int(os.environ.get("CLAUDE_DELEGATE_PORT", "8000"))
HTTP_PATH = os.environ.get("CLAUDE_DELEGATE_HTTP_PATH", "/mcp")
STATE_DIR = Path(os.environ.get("CLAUDE_DELEGATE_STATE_DIR", "~/.claude-mcp-delegate")).expanduser()
THREADS_FILE = STATE_DIR / "threads.json"
SCREENSHOT_DIR = STATE_DIR / "screenshots"
MAX_CAPTURE_CHARS = int(os.environ.get("CLAUDE_DELEGATE_MAX_CAPTURE_CHARS", "6000"))
# Permission bypass. Default ON because the delegate is bound to 127.0.0.1 and
# used headlessly by Hermes. If you expose the server over the network (host !=
# 127.0.0.1) you MUST set CLAUDE_DELEGATE_SKIP_PERMISSIONS=false to keep a
# remote caller from driving Claude to run arbitrary shell/filesystem actions.
SKIP_PERMISSIONS = os.environ.get("CLAUDE_DELEGATE_SKIP_PERMISSIONS", "true").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
BRIDGE_API_KEY = os.environ.get("CLAUDE_DELEGATE_API_KEY", "").strip()


class StaticTokenVerifier(TokenVerifier):
    """Minimal bearer-token verifier for optional network MCP mode."""

    def __init__(self, token: str):
        self._token = token

    async def verify_token(self, token: str) -> AccessToken | None:
        if token != self._token:
            return None
        return AccessToken(token=token, client_id="claude-delegate-client", scopes=["claude-delegate"])


def _auth_settings() -> tuple[AuthSettings | None, TokenVerifier | None]:
    if not BRIDGE_API_KEY:
        return None, None
    scheme = "http"
    host_for_url = "127.0.0.1" if HOST in {"0.0.0.0", "::"} else HOST
    base_url = f"{scheme}://{host_for_url}:{PORT}"
    return (
        AuthSettings(
            issuer_url=base_url,
            resource_server_url=f"{base_url}{HTTP_PATH}",
            required_scopes=["claude-delegate"],
        ),
        StaticTokenVerifier(BRIDGE_API_KEY),
    )

_AUTH_SETTINGS, _TOKEN_VERIFIER = _auth_settings()
mcp = FastMCP(
    "claude-delegate",
    host=HOST,
    port=PORT,
    streamable_http_path=HTTP_PATH,
    auth=_AUTH_SETTINGS,
    token_verifier=_TOKEN_VERIFIER,
)

_ANSI_RE = re.compile(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_interactive_sessions: dict[str, dict[str, Any]] = {}

_HTTP_RE = re.compile(r"^https?://", re.IGNORECASE)


def _now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def _ensure_state_dir() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)


def _load_threads() -> dict[str, Any]:
    _ensure_state_dir()
    if not THREADS_FILE.exists():
        return {}
    try:
        data = json.loads(THREADS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _save_threads(threads: dict[str, Any]) -> None:
    _ensure_state_dir()
    THREADS_FILE.write_text(json.dumps(threads, indent=2, sort_keys=True), encoding="utf-8")


def _clean_output(text: str, limit: int = MAX_CAPTURE_CHARS) -> str:
    text = _ANSI_RE.sub("", text or "")
    text = _CONTROL_RE.sub("", text)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = "\n".join(line.rstrip() for line in text.splitlines())
    text = text.strip()
    if limit > 0 and len(text) > limit:
        return text[-limit:]
    return text


def _resolve_cwd(cwd: str = "") -> str:
    selected = Path((cwd or DEFAULT_CWD or os.getcwd())).expanduser()
    if not selected.exists():
        raise ValueError(f"cwd does not exist: {selected}")
    if not selected.is_dir():
        raise ValueError(f"cwd is not a directory: {selected}")
    return str(selected)


def _validate_uuid(value: str) -> str:
    try:
        return str(uuid.UUID(value))
    except ValueError as exc:
        raise ValueError("session_id must be a UUID created by start_claude_thread") from exc


def _mcp_config_args(mcp_config: str = "") -> list[str]:
    selected = (mcp_config or DEFAULT_MCP_CONFIG).strip()
    return ["--mcp-config", selected] if selected else []


def _claude_env() -> dict[str, str]:
    env = dict(os.environ)
    # Force subscription/OAuth auth; never consume a billed API key from the host.
    env.pop("ANTHROPIC_API_KEY", None)
    return env


def _build_print_command(
    prompt: str,
    *,
    model: str = "",
    session_id: str = "",
    resume_session_id: str = "",
    continue_latest: bool = False,
    mcp_config: str = "",
    chrome: bool = False,
) -> list[str]:
    args = [CLAUDE, "-p", prompt, "--model", model or MODEL]
    if SKIP_PERMISSIONS:
        args.append("--dangerously-skip-permissions")
    if resume_session_id:
        args.extend(["--resume", _validate_uuid(resume_session_id)])
    elif session_id:
        args.extend(["--session-id", _validate_uuid(session_id)])
    elif continue_latest:
        args.append("--continue")
    args.extend(_mcp_config_args(mcp_config))
    if chrome:
        args.append("--chrome")
    return args


def _run_claude_print(
    prompt: str,
    *,
    cwd: str = "",
    model: str = "",
    session_id: str = "",
    resume_session_id: str = "",
    continue_latest: bool = False,
    timeout_s: int = TIMEOUT_S,
    mcp_config: str = "",
    chrome: bool = False,
) -> tuple[int, str, str]:
    selected_cwd = _resolve_cwd(cwd)
    cmd = _build_print_command(
        prompt,
        model=model,
        session_id=session_id,
        resume_session_id=resume_session_id,
        continue_latest=continue_latest,
        mcp_config=mcp_config,
        chrome=chrome,
    )
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout_s,
        env=_claude_env(),
        cwd=selected_cwd,
    )
    return result.returncode, result.stdout or "", result.stderr or ""


def _format_claude_result(returncode: int, stdout: str, stderr: str) -> str:
    if returncode == 0:
        return stdout.strip() or "(Claude completed but returned no text output.)"
    detail = (stderr or stdout or "").strip()
    return f"ERROR (claude exit {returncode}): {detail[:4000]}"


def _with_route(route: str, result: str) -> str:
    return f"Route: {route}\n\n{result}"


def _looks_like_open_target(text: str) -> str:
    words = text.strip().split()
    for word in words:
        cleaned = word.strip("\"'()[]<>.,")
        if _HTTP_RE.match(cleaned) or cleaned.startswith("file://") or cleaned.startswith("/") or cleaned.startswith("~/"):
            return cleaned
    return ""


def _read_pty(master_fd: int, wait_ms: int = 500, max_chars: int = MAX_CAPTURE_CHARS) -> str:
    deadline = time.time() + max(wait_ms, 0) / 1000
    chunks: list[bytes] = []
    while True:
        timeout = max(0, deadline - time.time())
        readable, _, _ = select.select([master_fd], [], [], timeout)
        if not readable:
            break
        try:
            chunk = os.read(master_fd, 4096)
        except OSError as exc:
            if exc.errno in (errno.EIO, errno.EBADF):
                break
            raise
        if not chunk:
            break
        chunks.append(chunk)
        if sum(len(c) for c in chunks) >= max_chars * 2:
            break
        # Keep draining immediately available output, but don't spin forever.
        deadline = min(deadline, time.time() + 0.05)
    return _clean_output(b"".join(chunks).decode("utf-8", errors="replace"), max_chars)


def _get_interactive(session_id: str) -> dict[str, Any]:
    session = _interactive_sessions.get(session_id)
    if not session:
        raise ValueError(f"No interactive Claude session found for id: {session_id}")
    proc: subprocess.Popen[str] = session["proc"]
    if proc.poll() is not None:
        _interactive_sessions.pop(session_id, None)
        raise ValueError(f"Interactive Claude session {session_id} has exited with code {proc.returncode}")
    return session


@mcp.tool()
def claude_delegate(
    request: str,
    context: str = "",
    mode: str = "auto",
    session_id: str = "",
    interactive_session_id: str = "",
    cwd: str = "",
    model: str = "",
    mcp_config: str = "",
    chrome: bool = False,
    title: str = "",
) -> str:
    """One plain-English front door for the Claude delegation bridge.

    Use this first when you do not want to remember the specialist tools. In
    auto mode it routes common requests to one-shot delegation, persistent
    threads, interactive sessions, desktop helpers, or status/capability tools.

    Optional mode overrides:
    one_shot, thread, interactive, screenshot, open, capabilities, list_threads,
    list_interactive, stop_interactive, forget_thread.
    """
    request = (request or "").strip()
    context = (context or "").strip()
    selected_mode = (mode or "auto").strip().lower().replace("-", "_").replace(" ", "_")
    text = request.lower()

    if not request and selected_mode not in {"capabilities", "list_threads", "list_interactive"}:
        return "ERROR: 'request' is required and was empty."

    if selected_mode in {"capability", "capabilities", "help", "status"}:
        return _with_route("capabilities", claude_delegate_capabilities())

    if selected_mode in {"list_threads", "threads"}:
        return _with_route("list_threads", list_claude_threads())

    if selected_mode in {"list_interactive", "interactive_sessions"}:
        return _with_route("list_interactive", list_interactive_claude_sessions())

    if selected_mode in {"stop_interactive", "stop"}:
        if not interactive_session_id:
            return "ERROR: interactive_session_id is required for stop_interactive mode."
        return _with_route("stop_interactive", stop_interactive_claude(interactive_session_id))

    if selected_mode in {"forget_thread", "forget"}:
        if not session_id:
            return "ERROR: session_id is required for forget_thread mode."
        return _with_route("forget_thread", forget_claude_thread(session_id))

    if selected_mode == "auto":
        if any(phrase in text for phrase in ["what can you do", "capabilities", "capability", "help", "status"]):
            selected_mode = "capabilities"
        elif "list" in text and "thread" in text:
            selected_mode = "list_threads"
        elif "list" in text and "interactive" in text:
            selected_mode = "list_interactive"
        elif any(word in text for word in ["screenshot", "screen shot", "capture screen", "desktop capture"]):
            selected_mode = "screenshot"
        elif text.startswith("open ") and _looks_like_open_target(request):
            selected_mode = "open"
        elif interactive_session_id or any(
            phrase in text
            for phrase in [
                "interactive",
                "stdin",
                "wizard",
                "terminal prompt",
                "login prompt",
                "asks for input",
                "needs input",
            ]
        ) or re.search(r"\brepl\b", text):
            selected_mode = "interactive"
        elif session_id or any(
            phrase in text
            for phrase in [
                "continue",
                "follow up",
                "remember this",
                "keep context",
                "persistent",
                "same thread",
                "ongoing",
            ]
        ):
            selected_mode = "thread"
        else:
            selected_mode = "one_shot"

    if selected_mode in {"capability", "capabilities", "help", "status"}:
        return _with_route("capabilities", claude_delegate_capabilities())

    if selected_mode in {"list_threads", "threads"}:
        return _with_route("list_threads", list_claude_threads())

    if selected_mode in {"list_interactive", "interactive_sessions"}:
        return _with_route("list_interactive", list_interactive_claude_sessions())

    if selected_mode in {"one_shot", "oneshot", "delegate", "ask"}:
        return _with_route("one_shot", delegate_to_claude(request, context, cwd, model, mcp_config, chrome))

    if selected_mode in {"thread", "persistent"}:
        if session_id:
            return _with_route(
                "continue_thread",
                continue_claude_thread(session_id, request, context, cwd, model, mcp_config, chrome),
            )
        return _with_route(
            "start_thread",
            start_claude_thread(request, context, title, cwd, model, mcp_config, chrome),
        )

    if selected_mode in {"interactive", "stdin", "pty"}:
        if interactive_session_id:
            return _with_route("send_interactive", send_to_interactive_claude(interactive_session_id, request))
        initial_task = f"{context}\n\n{request}".strip() if context else request
        return _with_route(
            "start_interactive",
            start_interactive_claude(initial_task, cwd, model, session_id, mcp_config, chrome),
        )

    if selected_mode in {"screenshot", "desktop_screenshot"}:
        return _with_route("desktop_screenshot", desktop_screenshot())

    if selected_mode in {"open", "open_url", "open_file"}:
        target = _looks_like_open_target(request) or request
        return _with_route("desktop_open_url", desktop_open_url(target))

    return (
        f"ERROR: Unknown mode '{mode}'. Use auto, one_shot, thread, interactive, "
        "screenshot, open, capabilities, list_threads, list_interactive, "
        "stop_interactive, or forget_thread."
    )


@mcp.tool()
def delegate_to_claude(
    task: str,
    context: str = "",
    cwd: str = "",
    model: str = "",
    mcp_config: str = "",
    chrome: bool = False,
) -> str:
    """Delegate a complete, self-contained one-shot task to Claude Code.

    Claude starts with no knowledge of this conversation, so include everything
    it needs. Set cwd to control where Claude runs. Set mcp_config to a Claude
    MCP JSON/path if you want Claude itself to receive extra tools. Set chrome to
    true to launch Claude with its Chrome integration flag.
    """
    task = (task or "").strip()
    context = (context or "").strip()
    if not task:
        return "ERROR: 'task' is required and was empty."

    prompt = f"{context}\n\n{task}".strip() if context else task

    try:
        code, stdout, stderr = _run_claude_print(
            prompt,
            cwd=cwd,
            model=model,
            mcp_config=mcp_config,
            chrome=chrome,
        )
    except FileNotFoundError:
        return f"ERROR: claude CLI not found at {CLAUDE}. Set CLAUDE_PATH."
    except subprocess.TimeoutExpired:
        return f"ERROR: Claude delegation timed out after {TIMEOUT_S}s."
    except ValueError as exc:
        return f"ERROR: {exc}"

    return _format_claude_result(code, stdout, stderr)


@mcp.tool()
def start_claude_thread(
    task: str,
    context: str = "",
    title: str = "",
    cwd: str = "",
    model: str = "",
    mcp_config: str = "",
    chrome: bool = False,
) -> str:
    """Start a persistent Claude Code print-mode thread and run the first task.

    The returned session_id is a real Claude --session-id UUID. Pass it to
    continue_claude_thread for future turns, even after this MCP server restarts.
    """
    task = (task or "").strip()
    context = (context or "").strip()
    if not task:
        return "ERROR: 'task' is required and was empty."

    session_id = str(uuid.uuid4())
    prompt = f"{context}\n\n{task}".strip() if context else task
    started = _now()

    try:
        selected_cwd = _resolve_cwd(cwd)
        code, stdout, stderr = _run_claude_print(
            prompt,
            cwd=selected_cwd,
            model=model,
            session_id=session_id,
            mcp_config=mcp_config,
            chrome=chrome,
        )
    except FileNotFoundError:
        return f"ERROR: claude CLI not found at {CLAUDE}. Set CLAUDE_PATH."
    except subprocess.TimeoutExpired:
        return f"ERROR: Claude delegation timed out after {TIMEOUT_S}s."
    except ValueError as exc:
        return f"ERROR: {exc}"

    if code == 0:
        threads = _load_threads()
        threads[session_id] = {
            "session_id": session_id,
            "title": title or task[:80],
            "cwd": selected_cwd,
            "model": model or MODEL,
            "created_at": started,
            "updated_at": _now(),
            "turns": 1,
            "mcp_config": mcp_config or DEFAULT_MCP_CONFIG,
            "chrome": chrome,
        }
        _save_threads(threads)
        header = f"Claude thread started: {session_id}\n"
        return header + _format_claude_result(code, stdout, stderr)

    return _format_claude_result(code, stdout, stderr)


@mcp.tool()
def continue_claude_thread(
    session_id: str,
    task: str,
    context: str = "",
    cwd: str = "",
    model: str = "",
    mcp_config: str = "",
    chrome: bool = False,
) -> str:
    """Continue a persistent Claude Code print-mode thread created earlier."""
    task = (task or "").strip()
    context = (context or "").strip()
    if not task:
        return "ERROR: 'task' is required and was empty."

    try:
        valid_session_id = _validate_uuid(session_id)
    except ValueError as exc:
        return f"ERROR: {exc}"

    threads = _load_threads()
    thread = threads.get(valid_session_id, {})
    selected_cwd = cwd or thread.get("cwd") or DEFAULT_CWD
    selected_model = model or thread.get("model") or MODEL
    selected_mcp = mcp_config or thread.get("mcp_config") or DEFAULT_MCP_CONFIG
    selected_chrome = chrome or bool(thread.get("chrome"))
    prompt = f"{context}\n\n{task}".strip() if context else task

    try:
        code, stdout, stderr = _run_claude_print(
            prompt,
            cwd=selected_cwd,
            model=selected_model,
            resume_session_id=valid_session_id,
            mcp_config=selected_mcp,
            chrome=selected_chrome,
        )
    except FileNotFoundError:
        return f"ERROR: claude CLI not found at {CLAUDE}. Set CLAUDE_PATH."
    except subprocess.TimeoutExpired:
        return f"ERROR: Claude delegation timed out after {TIMEOUT_S}s."
    except ValueError as exc:
        return f"ERROR: {exc}"

    if code == 0:
        threads[valid_session_id] = {
            **thread,
            "session_id": valid_session_id,
            "title": thread.get("title") or task[:80],
            "cwd": _resolve_cwd(selected_cwd),
            "model": selected_model,
            "created_at": thread.get("created_at") or _now(),
            "updated_at": _now(),
            "turns": int(thread.get("turns") or 0) + 1,
            "mcp_config": selected_mcp,
            "chrome": selected_chrome,
            "last_error": "",
        }
        _save_threads(threads)
    elif thread:
        thread["updated_at"] = _now()
        thread["last_error"] = (stderr or stdout or "").strip()[:1000]
        threads[valid_session_id] = thread
        _save_threads(threads)

    return _format_claude_result(code, stdout, stderr)


@mcp.tool()
def list_claude_threads() -> str:
    """List persistent Claude Code thread IDs known to this delegate."""
    threads = _load_threads()
    if not threads:
        return "No Claude threads recorded."
    rows = []
    for thread in sorted(threads.values(), key=lambda t: t.get("updated_at", ""), reverse=True):
        rows.append(
            f"{thread.get('session_id')} | turns={thread.get('turns', 0)} | "
            f"updated={thread.get('updated_at')} | cwd={thread.get('cwd')} | "
            f"title={thread.get('title', '')}"
        )
    return "\n".join(rows)


@mcp.tool()
def forget_claude_thread(session_id: str) -> str:
    """Remove this delegate's local record of a persistent Claude thread."""
    try:
        valid_session_id = _validate_uuid(session_id)
    except ValueError as exc:
        return f"ERROR: {exc}"
    threads = _load_threads()
    if valid_session_id not in threads:
        return f"No local thread record found for {valid_session_id}."
    threads.pop(valid_session_id, None)
    _save_threads(threads)
    return f"Forgot local thread record for {valid_session_id}. Claude's own saved conversation was not deleted."


@mcp.tool()
def start_interactive_claude(
    initial_task: str = "",
    cwd: str = "",
    model: str = "",
    session_id: str = "",
    mcp_config: str = "",
    chrome: bool = False,
    read_wait_ms: int = 1200,
) -> str:
    """Start a PTY-backed interactive Claude Code process.

    Use this when Claude or a command it runs needs stdin. Follow with
    send_to_interactive_claude/read_interactive_claude/stop_interactive_claude.
    Output is terminal UI text with ANSI stripped, so it may be less tidy than
    print-mode delegation.
    """
    interactive_id = str(uuid.uuid4())
    selected_cwd = ""
    try:
        selected_cwd = _resolve_cwd(cwd)
        master_fd, slave_fd = pty.openpty()
        args = [CLAUDE, "--model", model or MODEL]
        if SKIP_PERMISSIONS:
            args.append("--dangerously-skip-permissions")
        if session_id:
            args.extend(["--resume", _validate_uuid(session_id)])
        args.extend(_mcp_config_args(mcp_config))
        if chrome:
            args.append("--chrome")

        proc = subprocess.Popen(
            args,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            text=False,
            env=_claude_env(),
            cwd=selected_cwd,
            start_new_session=True,
            close_fds=True,
        )
        os.close(slave_fd)
        _interactive_sessions[interactive_id] = {
            "id": interactive_id,
            "proc": proc,
            "master_fd": master_fd,
            "cwd": selected_cwd,
            "model": model or MODEL,
            "created_at": _now(),
            "updated_at": _now(),
        }

        output = _read_pty(master_fd, read_wait_ms)
        normalized_output = re.sub(r"\s+", "", output).lower()
        if "yes,iaccept" in normalized_output and "bypasspermissionsmode" in normalized_output:
            os.write(master_fd, b"2\n")
            time.sleep(0.2)
            accepted = _read_pty(master_fd, read_wait_ms)
            output = "\n".join(part for part in [output, accepted] if part)
        if initial_task.strip():
            os.write(master_fd, (initial_task.strip() + "\n").encode("utf-8"))
            time.sleep(0.2)
            followup = _read_pty(master_fd, read_wait_ms)
            output = "\n".join(part for part in [output, followup] if part)
        return f"Interactive Claude session started: {interactive_id}\n{output}".strip()
    except FileNotFoundError:
        return f"ERROR: claude CLI not found at {CLAUDE}. Set CLAUDE_PATH."
    except ValueError as exc:
        return f"ERROR: {exc}"
    except Exception as exc:
        return f"ERROR: failed to start interactive Claude in {selected_cwd or cwd or DEFAULT_CWD}: {exc}"


@mcp.tool()
def send_to_interactive_claude(session_id: str, text: str, press_enter: bool = True, read_wait_ms: int = 1200) -> str:
    """Send text/stdin to an interactive Claude session and return new output."""
    try:
        session = _get_interactive(session_id)
        payload = text or ""
        if press_enter:
            payload += "\n"
        os.write(session["master_fd"], payload.encode("utf-8"))
        session["updated_at"] = _now()
        return _read_pty(session["master_fd"], read_wait_ms) or "(No new output yet.)"
    except (OSError, ValueError) as exc:
        return f"ERROR: {exc}"


@mcp.tool()
def read_interactive_claude(session_id: str, read_wait_ms: int = 1200) -> str:
    """Read pending output from an interactive Claude session without sending input."""
    try:
        session = _get_interactive(session_id)
        session["updated_at"] = _now()
        return _read_pty(session["master_fd"], read_wait_ms) or "(No new output yet.)"
    except (OSError, ValueError) as exc:
        return f"ERROR: {exc}"


@mcp.tool()
def list_interactive_claude_sessions() -> str:
    """List currently running PTY-backed interactive Claude sessions."""
    live = []
    for session_id, session in list(_interactive_sessions.items()):
        proc: subprocess.Popen[str] = session["proc"]
        if proc.poll() is not None:
            _interactive_sessions.pop(session_id, None)
            continue
        live.append(
            f"{session_id} | pid={proc.pid} | updated={session.get('updated_at')} | cwd={session.get('cwd')}"
        )
    return "\n".join(live) if live else "No interactive Claude sessions are running."


@mcp.tool()
def stop_interactive_claude(session_id: str) -> str:
    """Stop a PTY-backed interactive Claude session."""
    session = _interactive_sessions.pop(session_id, None)
    if not session:
        return f"No interactive Claude session found for id: {session_id}"
    proc: subprocess.Popen[str] = session["proc"]
    master_fd = session["master_fd"]
    try:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait(timeout=5)
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass
    return f"Stopped interactive Claude session {session_id}."


@mcp.tool()
def desktop_screenshot(output_path: str = "") -> str:
    """Capture the current macOS desktop to a PNG and return the file path."""
    _ensure_state_dir()
    if output_path.strip():
        path = Path(output_path).expanduser()
    else:
        stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
        path = SCREENSHOT_DIR / f"desktop-{stamp}.png"
    path.parent.mkdir(parents=True, exist_ok=True)

    try:
        result = subprocess.run(
            ["screencapture", "-x", str(path)],
            capture_output=True,
            text=True,
            timeout=30,
            env=_claude_env(),
        )
    except FileNotFoundError:
        return "ERROR: screencapture command not found on this system."
    except subprocess.TimeoutExpired:
        return "ERROR: desktop screenshot timed out after 30s."
    if result.returncode != 0:
        return f"ERROR (screencapture exit {result.returncode}): {(result.stderr or result.stdout).strip()}"
    return f"Screenshot saved: {path}"


@mcp.tool()
def desktop_applescript(script: str, timeout_s: int = 60) -> str:
    """Run AppleScript with osascript for lightweight macOS GUI automation."""
    script = (script or "").strip()
    if not script:
        return "ERROR: 'script' is required and was empty."
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=timeout_s,
            env=_claude_env(),
        )
    except FileNotFoundError:
        return "ERROR: osascript command not found on this system."
    except subprocess.TimeoutExpired:
        return f"ERROR: AppleScript timed out after {timeout_s}s."
    if result.returncode == 0:
        return (result.stdout or "").strip() or "(AppleScript completed with no output.)"
    detail = (result.stderr or result.stdout or "").strip()
    return f"ERROR (osascript exit {result.returncode}): {detail}"


@mcp.tool()
def desktop_open_url(url: str) -> str:
    """Open a URL or file path with the default macOS application."""
    url = (url or "").strip()
    if not url:
        return "ERROR: 'url' is required and was empty."
    try:
        result = subprocess.run(["open", url], capture_output=True, text=True, timeout=30, env=_claude_env())
    except FileNotFoundError:
        return "ERROR: open command not found on this system."
    except subprocess.TimeoutExpired:
        return "ERROR: open timed out after 30s."
    if result.returncode == 0:
        return f"Opened: {url}"
    detail = (result.stderr or result.stdout or "").strip()
    return f"ERROR (open exit {result.returncode}): {detail}"


@mcp.tool()
def claude_delegate_capabilities() -> str:
    """Explain what this MCP bridge can and cannot do after the upgrade."""
    return """Claude Delegate MCP capabilities:
- claude_delegate: the plain-English front door. Give it a normal request and it routes to the right capability.
- delegate_to_claude: one-shot Claude Code task, backward-compatible with the original bridge.
- start_claude_thread / continue_claude_thread: persistent Claude Code turns using Claude --session-id.
- start_interactive_claude / send_to_interactive_claude / read_interactive_claude / stop_interactive_claude: PTY-backed sessions for stdin and back-and-forth workflows.
- mcp_config argument or CLAUDE_DELEGATE_MCP_CONFIG env: launch Claude with extra MCP servers so Claude can use additional tool surfaces.
- chrome=true: launch Claude with the Claude Chrome integration flag.
- desktop_screenshot / desktop_applescript / desktop_open_url: host-side macOS GUI helpers exposed to Hermes.

Important boundary:
This MCP server cannot directly call Hermes' private in-process tools on Claude's behalf. To give Claude Hermes-like tools, expose those tools through an MCP server and pass that config via mcp_config or CLAUDE_DELEGATE_MCP_CONFIG."""


if __name__ == "__main__":
    transport = os.environ.get("CLAUDE_DELEGATE_TRANSPORT", "stdio").strip().lower()
    if transport == "http":
        transport = "streamable-http"
    if transport not in {"stdio", "sse", "streamable-http"}:
        raise ValueError("CLAUDE_DELEGATE_TRANSPORT must be stdio, sse, streamable-http, or http")
    # Warn loudly about the most dangerous misconfiguration: permission bypass
    # exposed beyond loopback. With skip-on + non-loopback bind, any network
    # caller can drive Claude to run arbitrary shell commands.
    if SKIP_PERMISSIONS and HOST not in {"127.0.0.1", "localhost", "::1"}:
        print(
            "WARNING: CLAUDE_DELEGATE_SKIP_PERMISSIONS is ON and the server is bound to "
            f"{HOST}, which is not loopback. Anyone who can reach this port can run "
            "arbitrary commands via Claude. Set CLAUDE_DELEGATE_SKIP_PERMISSIONS=false.",
            flush=True,
        )
    mcp.run(transport=transport)
