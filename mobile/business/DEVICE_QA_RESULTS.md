# DanceFlow Business: device and DEV QA results

How each check is run is in [DEVICE_QA.md](DEVICE_QA.md). A check is PASS only with evidence. Anything that couldn't be run is **BLOCKED**, never passed.

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| D1 | DEV GoTrue accepts `danceflow-business://auth/callback` as `redirect_to` (exact match) | **PASS** (2026-11-10) | [dev-redirect-check.json](../../docs/mobile/screenshots/business-shell/dev-redirect-check.json) |
| D2 | Full DEV PKCE sign-in from the app | **BLOCKED**: no QA inbox on DEV (the coordinator's decision; no account is created and nobody's mailbox is used) | — |
| E1 | SecureStore session persistence, plus a scan for plaintext tokens | Not run yet: waiting for the shared SDK (`docs/mobile/Local_Android_QA.md`) | — |
| E2 | PKCE deep link `danceflow-business://auth/callback` on the emulator (local iso-qa `--auth` stack and Mailpit, via `10.0.2.2`) | Not run yet: same | — |
| E3 | OS text size 2.0 on every screen | Not run yet: same | — |
| E4 | Reduce Motion (`animator_duration_scale` 0 → `reduceMotion=true`, fade transition) | Not run yet: same | — |

## D1: how it was checked

The check uses DEV GoTrue's email-link endpoint with a deliberately **invalid** token, `GET /auth/v1/verify?token=<invalid>&type=magiclink&redirect_to=<url>`, without following the redirect. An invalid token is a failed lookup, so **no email was sent and no user was created**. GoTrue sends the resulting error to `redirect_to` only if that URL passes the allow list; otherwise it falls back to the site URL.

| `redirect_to` | Answer | Meaning |
| --- | --- | --- |
| `danceflow-business://auth/callback` | `303` → `danceflow-business://auth/callback#error=access_denied&error_code=otp_expired…` | Accepted |
| `danceflow-business://auth/callback/x` | `303` → `http://localhost:3000#error=…` | Refused: the entry is exact-match |
| `https://not-allowed.example/cb` | `303` → `http://localhost:3000#error=…` | Refused (negative control) |

Side note: DEV's site URL is `http://localhost:3000`.
