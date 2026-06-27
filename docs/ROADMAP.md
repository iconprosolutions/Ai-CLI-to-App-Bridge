# AI CLI Bridge Roadmap

## Now

- Test Claude through provider mode after Claude usage resets.
- Add a local runbook for the three-process startup flow.
- Connect one real app to `http://127.0.0.1:9010/v1/chat/completions`.

## Next

- Add a small local launcher script so Gemini bridge, Claude bridge, and provider bridge can start together.
- Add a browser-visible status page showing bridge health, configured aliases, inflight counts, and recent non-sensitive request logs.
- Decide whether streaming is needed after one real app uses provider mode successfully.

## Later

- Validate Docker only when deployment becomes important.
- Package for always-on hosting on Mac/NAS.
- Put Cloudflare Tunnel in front only after auth, local stability, and operational visibility are solid.
- Consider official API-key provider mode if external users ever need access.
