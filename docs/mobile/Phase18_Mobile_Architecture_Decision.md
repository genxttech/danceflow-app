# Phase 18: Mobile App Architecture Decision

**Status:** two-app decision accepted by the owner on 2026-11-09.
**Evidence:** read-only audit of `origin/main` at `e95f52fe`, plus the competition branch `cf1/integration-5` at `400cce2b`.
**Checks run:** install, typecheck, `expo-doctor` and Android JS bundle export of `mobile/student`.
**Not checked:** on-device behavior, live database policies, EAS and store account state.

## Decision

Two apps. No separate judging or competition app.

| | DanceFlow | DanceFlow Business |
|---|---|---|
| **For** | Dancers, students, parents | Owners, staff, instructors, organizers, scorers, judges |
| **Contains** | Discovery, schedule, wallet, learning, partners, Competition Companion | Today view, rosters, clients, booking, check-in, competition operations, judging |
| **Stays web-only** | Studio administration | Billing, payroll runs, settings, campaigns, Stripe onboarding |

The owner's acceptance also means Business work starts before Phases 12 and 17 finish, limited to stable workflows.

## Architecture

- **Repository:** `mobile/student`, `mobile/business` and a pure-TypeScript `mobile/shared`. No root npm workspaces, so the Vercel build is untouched.
- **Identity:** one Supabase login across both apps, with separate sessions, EAS projects and bundle IDs. People who are both dancers and staff use both apps.
- **Business API:** a new `/api/staff/*` layer. It takes the user from the bearer token only, uses a user-scoped client, checks an explicit workspace ID against memberships, returns JSON errors rather than redirects, and enforces subscription status. Platform admins are excluded from v1.
- **Permissions:** `/api/staff/me` returns capabilities computed from `permissions.ts`. Phase 12 later changes only the source of that data.
- **Judges:** access comes from the event assignment, not a studio role. The locked web ballot stays the judge path until a native ballot ships. Offline entry is P2.
- **Purchases in Business:** no DanceFlow subscriptions or add-ons are sold in the app.
- **Push:** sends must filter on `app_slug` before a second app registers tokens.

## Still open

These do not change the decision above.

1. **Store accounts:** whether Apple and Google organization accounts exist, and under which legal entity. Blocks TestFlight and Play testing, not development.
2. **Minors:** the recommendation is 18+ for partner search and messaging, with guardian controls handled later under the Companion. Blocks store submission, not development.
3. **Native judging in v1:** native judging stays after v1 unless the owner chooses otherwise, which would change the locked web ballot decision.

## Sequence

1. **Now, in parallel:** Student stabilization (Phase 20-R) and the staff API foundation with the instructor Today slice.
2. **After Student fixes land:** SDK upgrade, `mobile/shared` and the `mobile/business` shell, because they change the same files.
3. **After CF1, R2, CI-B and F3 reach a reconciled `main`:** Companion and competition operations, then native judging.
4. **Last:** store submission, which remains a separate owner approval.

## Constraints that carry forward

- Production is not `main` at the time of this record. Mobile-facing server changes ship through the reconciled release, and dev builds point at DEV until then.
- Store listing copy follows the roadmap's public-claim restrictions: no Competition OS or judging claims, and Partner Match is described only as a directory.
- Competition OS is not discussed with outside directors or organizers.
