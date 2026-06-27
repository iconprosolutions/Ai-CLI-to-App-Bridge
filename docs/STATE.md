# AI CLI Bridge State

## Current Status

- Provider bridge v1 is implemented and committed.
- Gemini/Antigravity provider path is verified with real `agy`.
- Tests pass with 54 bridge hardening checks and 95 provider checks.
- Claude provider path still needs live smoke testing after Claude usage resets.

## Local Test Ports

- Gemini/Antigravity bridge: `9003`
- Claude bridge: `9002`
- Provider bridge: `9011` for manual testing when `9010` is occupied

## Known Gaps

- No runbook yet.
- No one-command local launcher yet.
- No web dashboard yet.
- Docker not installed locally and not currently needed.
