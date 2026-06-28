# AI CLI Bridge State

## Current Status

- Provider bridge v1 is implemented and committed.
- Gemini/Antigravity provider path is verified with real `agy`.
- Claude provider path is verified through the provider bridge.
- Provider bridge now includes a local browser dashboard at `/` and `/dashboard`, including a prompt tester.
- Local launcher scripts are available through `npm run bridge:up`, `npm run bridge:down`, and `npm run bridge:status`.
- Tests pass with bridge hardening and provider checks.

## Local Test Ports

- Gemini/Antigravity bridge: `9003`
- Claude bridge: `9002`
- Provider bridge: `9011` for manual testing when `9010` is occupied

## Known Gaps

- Docker not installed locally and not currently needed.
- No always-on LaunchAgent/NAS service yet.
