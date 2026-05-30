# dynamic-api

## Security model

The service has two planes with different trust assumptions.

**Management plane** (`/api/*` and the `/ui` dashboard) is where apps are created, edited, and configured, and where tokens are managed. It is protected by Cloudflare Access — only authenticated owners reach it. The application code itself performs no additional authentication for these routes, so the Access policy is the boundary that protects them.

**Execution plane** (`/apps/:id/*`) is where a created app actually runs and serves traffic. Access to it is governed per-app:

- **Private apps** (the default) require a token on every request, supplied either as a bearer token in the `Authorization` header or as a query parameter. Requests without a valid token are rejected.
- **Public apps** require no token — anyone can call them. Visibility is a per-app setting the owner can toggle at any time.

### App tokens

Each app can have any number of long-lived tokens, which are the credentials intended for real integrations. A token's secret value is shown only once, at creation time: the service stores only a one-way hash of it, so a leak of the stored data does not expose usable tokens. Tokens can be revoked individually, which takes effect immediately (edge locations cache this for 60s). Because the tokens are long, high-entropy random values rather than user-chosen secrets, they are safe against guessing without needing a slow password-style hash.

Validation is backed by a layered cache (in-memory, then a shared key-value store, then the authoritative per-app store) so that checking a token on each request stays fast without weakening the immediacy of revocation.

### Test token

For convenience during manual testing, every app exposes a test token that the owner can use to call a private app without minting a separate secret. It is a stateless, self-contained credential — no server-side storage is needed to verify it. The token embeds an expiry timestamp and is HMAC-signed with the server secret, binding it to a specific app: a token issued for one app is rejected by any other. A fresh token (valid for one hour) is returned whenever the owner reads the app through the management plane. Because the token is only readable through the Access-protected management plane, exposing it in recoverable form is acceptable.
