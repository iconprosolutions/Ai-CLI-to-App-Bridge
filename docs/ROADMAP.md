# AI CLI Bridge Roadmap

## Now

- Add a local runbook for the three-process startup flow.
- Restart the provider bridge and use the dashboard during manual testing.
- Connect one real app to `http://127.0.0.1:9010/v1/chat/completions`.

## Next

- Add a small local launcher script so Gemini bridge, Claude bridge, and provider bridge can start together.
- Decide whether streaming is needed after one real app uses provider mode successfully.

## Later

- Validate Docker only when deployment becomes important.
- Package for always-on hosting on Mac/NAS.
- Put Cloudflare Tunnel in front only after auth, local stability, and operational visibility are solid.
- Consider official API-key provider mode if external users ever need access.
