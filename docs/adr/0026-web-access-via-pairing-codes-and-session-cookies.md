# ADR-0026: Web access via one-time pairing codes and session cookies

Status: Accepted (2026-11-19)

- Context: The web UI and API (localhost now, Tailscale later) need authentication, and secrets must never appear in HTML, page JavaScript or logs. The Phase 1 plan assumed a static bearer token.
- Decision: `achords pair web` prints a single-use code (8 chars, 10 minutes, stored hashed). `POST /api/pair` exchanges it for a session cookie: `HttpOnly; Secure; SameSite=Strict`, token stored hashed, 14-day sliding idle expiry capped at 90 days. Five wrong codes within 15 minutes lock pairing and burn all outstanding codes. State-changing requests need a same-origin `Origin` and the per-session CSRF token in `X-Achords-CSRF`. Only exact Host headers are accepted (DNS-rebinding protection). Devices can be listed and revoked. The server binds to 127.0.0.1; remote access will go through `tailscale serve` (HTTPS), so `Secure` cookies work there.
- Consequences: No long-lived token in the browser; each device is revocable. Safari may refuse `Secure` cookies on plain `http://localhost` (Chrome and Firefox accept them); use the Tailscale HTTPS URL there. Telegram pairing (step 6b) reuses the same code mechanism.
