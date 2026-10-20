# Cookie-independent OAuth for the embedded manager

Date: 2026-10-20

## Goal and observed failure

Cloudflare redirects successfully to `/auth/callback` with a code and the requested scopes. The callback currently requires a state cookie set by `/auth/start`. When that cookie is unavailable in the embedded HTTP interface, the callback returns `authorization state is missing` before exchanging the code or setting an access cookie. `/api/session` then reports that Cloudflare sign-in is required. The backend does not log this callback rejection.

The manager must complete OAuth inside Deploy Commander at its current HTTP local interface origin, including when the browser does not store or send cookies for the embedded frame. Existing HTTPS cookie sessions should continue to work. The Cloudflare access token must never enter frontend JavaScript or the manager database.

## Pending authorization state

`POST /auth/start` remains a manager-JWT-signed route. It validates the browser `Origin`, requires `opener_origin` to equal that origin, validates the API origin and client ID, and generates a random 256-bit state and PKCE verifier. Before returning the Cloudflare authorization URL, the backend writes one pending record to the manager's database through its authenticated Commander manager API. If the write fails or the query reports a failed statement, the route fails without returning an authorization URL.

The record key is derived from a hash of the random state. It contains an expiry ten minutes after creation and an encrypted payload holding the PKCE verifier, saved client ID, exact redirect URI, opener origin, and manager identity. Encrypt with an authenticated key derived with domain separation from `MANAGER_PASSWORD`, which is available to the backend but not exposed through the frontend settings query. Do not derive this key from `JWT_SECRET`: the frontend reads that secret to sign manager requests. Never put the raw state or verifier in logs. Prune expired pending records during start operations so abandoned authorizations do not accumulate.

`GET /auth/callback` hashes the returned state, then consumes the matching unexpired record with one conditional delete that returns the deleted record. It validates the query result, decrypts the payload, checks expiry and redirect identity, and exchanges the code with the saved PKCE verifier. A missing, expired, already used, malformed, or undecryptable state produces a clear retry message and a structured reason in backend logs. Duplicate callbacks must not exchange a second code. Cloudflare error callbacks retain safe, actionable messages and never reflect arbitrary provider descriptions.

The Go Commander client must expose database query results and check every statement's status. It currently only returns an HTTP error and discards successful response bodies. The state store owns its fixed, bound queries and result validation. The storage operation must be verified against the installed Commander/SurrealDB version, including concurrent attempts to consume the same state.

## Signed-in manager session

After a successful code exchange, the callback continues to set the host-only, `HttpOnly` Cloudflare access cookie for browsers that can use it. It also creates a random, short-lived opaque session handle. The backend stores the Cloudflare access token, handle hash, expiry, and exact manager frontend origin in a bounded in-memory table. The raw access token is never sent to JavaScript or saved in the manager database. Expired handles are removed; a backend restart invalidates them and requires sign-in again in an embedded frame.

The callback posts the opaque handle to the opener using the saved, exact opener origin. The frontend accepts the message only from its popup and expected backend origin. It keeps the handle in memory and, when available, in tab-scoped `sessionStorage` so a manager reload can resume the session. It clears an invalid or expired handle. Signed manager API requests include the handle in a dedicated header; the backend validates the handle, expiry, manager identity, and signed request origin before using the stored Cloudflare token. `/api/session` and all Cloudflare operations use the same resolver, with the existing access cookie as a fallback. Cross-origin preflight permits the dedicated header. The frontend never receives or stores the Cloudflare access token.

The handle is a JavaScript-visible bearer credential. Binding it to the signed manager origin and keeping it short-lived limits where it can be used; script execution in the manager origin can still use it, as it can use the existing manager JWT secret. The installed manager runs one backend container. Supporting multiple replicas would require a shared session store and is outside this change.

## Diagnostics and user experience

Emit structured events for OAuth start, pending-state write failure, callback state lookup/validation failure, token exchange failure, callback success, and session rejection. Use a short hash-derived flow identifier to correlate start and callback without logging state, code, verifier, tokens, handles, cookies, JWT bodies, or full callback URLs. Include reason codes and the request host or origin where useful. Return a useful popup message when authorization fails so the user can retry from the manager.

The setup instructions for the OAuth client and its scope list remain accurate. Update README's cookie-only description to explain pending state in the manager database, the embedded session handle, and the restart behavior.

## Verification

- Backend tests cover state write failure, one-time consume, expiry, replay, concurrent callback attempts, restart with the same manager password, and safe logs.
- Backend tests cover access cookie issuance, handle issuance, session and Cloudflare API access without cookies, wrong origin, expired handle, and cookie fallback.
- Frontend tests cover popup message validation, handle storage/rehydration, handle transmission on signed requests, and clearing after a rejected session.
- A live Corvo test on the current HTTP `*.interface.localhost:8080` route verifies authorization, callback, `/api/session`, account listing, reload, and visible backend failure logs. The live test must check that neither the manager database nor browser JavaScript contains a raw Cloudflare access token.
