# Student (and Business) apps: server-driven minimum version and kill switches (design options)

2026-11-18, main `793ef6439`. **Options analysis only. Nothing is implemented, no provider is involved, no SQL is written.** Decisions needed from the owner are in section 8. Companion: `Student_Release_Package_Internal_Testing.md` section 4 (today there is no in-app kill switch and no minimum-version mechanism), `docs/events/event-registration-claim-release-package.md` 15.13 (Gate 2 old-build handling, option C needs this).

## 1. The one fact that drives timing

A gate can only stop builds that **already contain the code that reads it**. Every Student build before the first one carrying the reader is permanently ungateable (except by changing the server routes it calls). So the reader, the version header and the kill-switch checks must be in the **first build any real user gets** (RC6 if no tester has a build yet), even if the server side is built later. The server side, the policy and the screens can change afterwards without a new build, if the first build's reader is generic enough.

Verified in the repo today: the app has `expo-updates` configured but no use of it; no version check; no remote flag; the API client (`mobile/student/src/lib/danceflowApi.ts`) sends no app version. Business has build-time switches only (`mobile/business/src/lib/features.ts`, `EXPO_PUBLIC_STAFF_FEATURES`), which cannot be changed after install. `src/proxy.ts` matches only `/app/*` and `/platform/*`, so a new `/api/*` route is not behind the sign-in proxy (the route itself decides).

## 2. Where the config can live

| Option | Change takes effect | Needs | Notes |
|---|---|---|---|
| A. Static JSON in the web `public/` folder, e.g. `/app-config/student.json` | after a web deploy (minutes) | web PR only | No function cost; CDN cached. Every change is a reviewed PR and a deploy; no instant switch |
| B. Route `GET /api/app-config` reading environment variables | after a redeploy (env change needs one) | web PR | Not better than A |
| **C. Route `GET /api/app-config` reading one DB row** (recommended) | seconds (cache TTL) | web PR + a small table/migration (protected path, owner gate) + an owner/admin way to edit | Kill switch without a deploy. Table is tiny: app id, JSON, updated_at. Writes through an existing admin path or manual SQL |
| D. App reads a Supabase table directly with the anon key | seconds | migration + RLS | Skips the web route but ties kill switches to the auth/db availability (see failure modes) |

Recommendation: **ship the reader in the app against a URL, start with A (no migration) and move to C when the owner wants instant switches.** The app code is identical for A and C if the payload is the same, so choosing A first does not cost a rebuild. Cache headers for the route/file: `public, max-age=60, stale-while-revalidate=300` (CDN absorbs load; no per-user data, no cookies, no auth).

## 3. Payload (schema 1, small and strict)

```json
{
  "schema": 1,
  "updatedAt": "2026-11-18T12:00:00Z",
  "apps": {
    "student": {
      "android": { "recommendedCode": 3, "minimumCode": 0, "blockedCodes": [], "storeUrl": "https://play.google.com/store/apps/details?id=com.idanceflow.student" },
      "ios":     { "recommendedCode": 0, "minimumCode": 0, "blockedCodes": [], "storeUrl": null },
      "message": null,
      "switches": { "claim": true, "availability": true, "eventCheckout": true, "pushRegistration": true }
    },
    "business": { "...": "same shape" }
  }
}
```

Compare on the **integer build number** (Android versionCode, iOS buildNumber), not the 0.1.0 string: it is monotonic and `autoIncrement` already maintains it. `minimumCode: 0`, `blockedCodes: []` and every switch `true` mean "no gating". Message text is optional and shown only if it is a short plain string (length-capped, no markup, no links other than `storeUrl`).

## 4. Fail-OPEN rules (the safety property)

The gate may only ever make the app **less** restrictive when anything is uncertain.

- Timeout 3 s, one attempt per cold start and per foreground after 15 minutes; never blocks first render (the app shows normally and the gate applies when the answer arrives).
- Any of these means "no gating": network error, non-200, non-JSON, wrong `schema`, missing app key, wrong types, an unknown field value, a payload older than 24 h whose block cannot be re-confirmed.
- The last good payload is cached on device, but a cached **hard block** is honored for at most 24 h and only with a fresh confirmation attempt. A cached soft nudge may persist longer. An offline user with an old build is not locked out.
- Kill switches default **ON** when unknown; only an explicit `false` turns a feature off.
- A hard block requires `minimumCode > ownCode` or `ownCode in blockedCodes`, both validated as integers. One typo such as `"minimumCode": "300"` is ignored, not enforced.
- Never gate: sign-out, account deletion (store policy and the user's right), the help/support and legal links, the update button.
- Protect the config itself: edits through a reviewed PR (A) or a two-person-checked admin action (C); a published "block everyone" payload is the largest single risk of this design (section 7).

## 5. What the app shows

| Level | Trigger | UI |
|---|---|---|
| None | all defaults, any error | nothing |
| Soft nudge | `recommendedCode > ownCode` | dismissible banner on Today/Wallet: "A newer version of DanceFlow is available." with Update; remembered for 3 days after dismissal |
| Hard block | `minimumCode > ownCode` or own code blocked | full-screen "Update required" (the message, if any; otherwise a default sentence), Update button (Play deep link `market://details?id=...` with https fallback), plus Sign out and Delete account / Help links; no data screens |
| Feature off | switch `false` | the feature behaves as if the server refused it: claim not called; availability shows "Admission spots available"; event checkout shows "Registration is paused. Try again later."; push registration skipped |

## 6. Interaction with Gate 2 and the old-build decision

- Today's builds before the first reader build cannot be gated. If none were ever distributed, the old-build problem does not exist (owner confirms).
- Sequence with the reader in the first build: (1) release the reader build; (2) when adoption is high, raise `recommendedCode` (soft nudge) to that build; (3) observe views reads; (4) before Gate 2, set `minimumCode` to the reader build so installed builds that still read the base tables show "Update required" instead of an empty Tickets screen; (5) apply Gate 2. This turns release-package option C into something that works without another release.
- If a build later turns out to be broken, `blockedCodes: [n]` stops that code only, and `switches.claim = false` can pause the claim without SQL, in addition to withholding execute in the database.
- The switches are a **second** line of defense for the claim; the SQL execute withhold remains the authority.

## 7. Failure modes and tests

| Risk | Mitigation / test |
|---|---|
| A wrong payload locks every user out | strict validation; hard block needs integers; shipped payload goes through a validator in CI; a "dry-run" field (`enforce: false`) that clients log only; staged edit (soft first); 24 h cap on cached blocks |
| Config host is down | fail open (timeout test) |
| Config route abused or scraped | public, static-ish, CDN cached, no secrets, small |
| Clock skew or cached old payload after a rollback | `updatedAt` informational only; decisions use the integers |
| Store link wrong or not yet live | `storeUrl` null means no Update button, banner only |
| Business app inherits the Student shape | same reader, different app key; Business staff work is a separate slice |

Test plan: jest units for the validator and compare logic (table of malformed/edge payloads, all must fail open); hook tests for timeout, offline, cache expiry; screen tests for soft nudge, hard block (including links that must stay available), switches off; a QA-harness stage with a mock route returning each level (smoke scenario per level at font 1.0/2.0 and dark); a web test that the route/file returns schema 1 and valid JSON and the CI validator rejects bad edits. Device: one pass per level on an emulator. All UNVERIFIED until built.

## 8. Effort and what must be in the first build

| Piece | Where | Effort (engineering days, estimate not measured) |
|---|---|---|
| Config reader, cache, validator, fail-open logic | Student | 1 |
| `X-DanceFlow-App: student/<version>/<code>/<platform>` header on `danceflowApiFetch` (lets the server also log and gate by build) | Student | 0.25 |
| Soft nudge and hard block screens, switch checks at 4 call sites | Student | 1.5 |
| Tests and smoke scenarios | Student | 1 |
| Static file or route + validator CI check | web | 0.5 (A) / 1.5 plus a migration (C) |
| Business reader (same library shape) | Business | 1 to 1.5 |

**Minimum in the first build:** the reader with validator and fail-open cache, the version header, the hard-block and soft-nudge screens, and the four switch checks. The server file/route and its content can follow. Without the reader, no later gating is possible.

## 9. Owner decisions

1. Include the reader in RC6 (recommended) or accept that RC6 and earlier cannot be gated.
2. Config host: A now, C later (recommended) or C at once (needs a migration).
3. Whether a hard block is acceptable at all or only soft nudges (hard block is what makes Gate 2 option C real).
4. Initial switch list (claim, availability, eventCheckout, pushRegistration).
5. Who may edit the live config.
