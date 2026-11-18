# Student app: real GoTrue error codes (observed, 2026-11-17)

Captured on a disposable iso-qa stack (the local GoTrue behind Kong, `iso-qa up main --auth`), HTTP only, with the app's own client library (supabase-js, PKCE flow). Only error class, HTTP status and error code were recorded, never message text. Tool: `mobile/student/scripts/qa-smoke/gotrue-codes.mjs`. Fixture: `mobile/student/scripts/qa-smoke/gotrue-codes.fixture.json`. Test: `mobile/student/src/lib/__tests__/gotrueCodes.test.ts` (proves each answer maps to the intended wording). Hosted GoTrue was not touched; its version may differ, so re-capture after an auth server upgrade.

| Case | Call | Error class | Status | Code | App shows |
|---|---|---|---|---|---|
| Fresh admin-issued link (control) | verifyOtp | none | 200 | | signs in |
| Link used a second time | verifyOtp | AuthApiError | 403 | `otp_expired` | expired or already used |
| Token that never existed | verifyOtp | AuthApiError | 403 | `otp_expired` | expired or already used |
| Link of a deleted user | verifyOtp | AuthApiError | 403 | `otp_expired` | expired or already used |
| Empty token | verifyOtp | AuthApiError | 400 | `validation_failed` | expired or already used (link-open path) |
| Unsupported type | verifyOtp | AuthApiError | 400 | `validation_failed` | expired or already used (link-open path) |
| PKCE code, verifier stored, unknown code | exchangeCodeForSession | AuthApiError | 404 | `flow_state_not_found` | expired or already used |
| PKCE code, no verifier on this device | exchangeCodeForSession | AuthPKCECodeVerifierMissingError (client-side) | 400 | `pkce_code_verifier_not_found` | generic "request a new link" |
| Bad-format address (no @, empty, spaces, no domain) | signInWithOtp | AuthApiError | 400 | `validation_failed` | "address does not look right" (send path) |
| Account does not exist, creation off | signInWithOtp | AuthApiError | 422 | `otp_disabled` | generic "could not send right now" (the app always sends with creation on) |
| Same address again within the window | signInWithOtp | AuthApiError | 429 | `over_email_send_rate_limit` | "Too many link requests" |
| 40 different addresses in a row | signInWithOtp | none | 200 | | not rate limited on this stack (`over_request_rate_limit` NOT reached) |
| Reset for an address with no account | resetPasswordForEmail | none | 200 | | no error (no account enumeration) |

## What GoTrue sends that the mapping does not name
- `pkce_code_verifier_not_found` (client-side): opening a PKCE link on another device or after a reinstall. Falls to the generic "request a new link" wording, which is the right advice; not mislabelled as expired.
- `otp_disabled` (422): only when account creation is off; the app always sends with creation on, so it is unreachable from the app. Generic wording if it ever happens.
- Not observed here: `over_request_rate_limit` (not reachable on this stack with 40 addresses), `email_address_invalid` (GoTrue answered `validation_failed` for every bad address tried; both are mapped), `user_not_found`, `flow_state_expired` (mapped from the type definitions only).
- Both rate-limit codes and the 429 status are mapped; the per-address limit is the one a dancer can hit.

Result: no observed error is mislabelled; the mapping needed no change.
