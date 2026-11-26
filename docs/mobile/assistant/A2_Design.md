# A2 design: read-only server responder for LUMI and ARIA

Status: **design only**, 2026-11-26. Authorized by owner dispositions E8 (read-only A2 architecture, after the ledger design) and E9 (production flags off; internal QA activation only after its own environment gate). Nothing here is implemented, applied, configured or activated: no code, SQL, flag, environment value or provider call. **Building any slice needs a new authorization. ARIA (or LUMI) actions that write need a separate authorization and a separate design.**

Builds on [A1_Design.md](A1_Design.md), the usage audit (`docs/ai/LUMI_ARIA_AI_Usage_and_Entitlement_Audit.md`) and two documents that exist **only on PR #769** (draft, head `7674998e`, unmerged): `docs/ai/AI_Usage_Ledger_Proposal.md` with `docs/ai/proposals/ai_usage_ledger_v1.sql`, and `docs/ai/AI_Spend_Controls_Plan.md`. If the ledger changes in review, sections 3 to 5 here must be re-checked.

## 1. Prerequisites (in order)

| # | Prerequisite | State on 2026-11-26 |
|---|---|---|
| P1 | #769 merged: `callOpenAiResponses` wrapper, LUMI plan rule (`isLumiPlanAllowed`) applied to `studio-links` | draft |
| P2 | Ledger SQL: independent database review, moved into migrations, DEV apply with fingerprint, isolated QA including PostgREST calls | proposal, not applied anywhere |
| P3 | Metering port next to the provider wrapper (ledger proposal, application slice 1) | not built |
| P4 | Ledger gaps in section 5 closed or explicitly accepted | open |
| P5 | Provider hard spend limit and a separate non-production project and key (A4, A6) | recommended, not verified |

The assistant must not have its own metering path, and must not fall back to `usage_events` or an in-memory counter if the ledger is unavailable: no ledger, no provider call.

## 2. Shape

Two endpoints, one server pipeline (`src/lib/assistant/`), per-assistant context builders.

| | LUMI | ARIA |
|---|---|---|
| Route | `POST /api/student/assistant` | `POST /api/staff/workspaces/{studioId}/assistant` |
| Identity | bearer token only, **no cookie fallback**; account must be active (`getStudentApiUser` alone does not give either, so a stricter guard is needed) | `requireStaffApi` (bearer, membership, account status, workspace status, platform admins refused) |
| Ledger feature | `lumi` | `aria_chat` (new control row) |

Pipeline, in this order. Every step before 7 costs no provider money, and every failure stops the request.

1. Authenticate.
2. Capability gate: one JSON environment policy `MOBILE_ASSISTANT_POLICY`, same fail-closed rules as `STAFF_API_WRITE_POLICY` (`lumiChat`, `ariaChat`, minimum and blocked build codes from `x-danceflow-app`, optional user allow-list). Unset or malformed means disabled.
3. Validate and bound the body (section 3). Unknown fields are ignored.
4. Entitlement (section 4).
5. Re-authorize the screen context and build server facts (section 6).
6. `ai_reserve` with the worst-case cost. Not admitted: stop.
7. `callOpenAiResponses` (`store: false`, input and output caps, timeout).
8. `ai_settle`: `settled` when the request may have been billed (including timeouts and unusable output), `released` only when it provably was not. Settle even if the client has gone away.
9. Validate link targets against the server copy of the app's whitelist; reply.

**Read-only guarantee.** No tool or function calling. The model returns text and link requests, nothing that the server executes. The only writes the pipeline may make are ledger reserve and settle. Enforce it with a test that fails if the assistant module imports a write helper or calls `insert`, `update`, `upsert`, `delete`, or any RPC other than the two ledger functions, and with an endpoint test using a recording database client.

## 3. Wire contract

Request: the existing `AssistantRequest` plus one **new** field, `requestId`. Response: the existing `AssistantReply`. Errors: `{ error, code }` with `Cache-Control: private, no-store`.

**Change to A1 that A2 needs.** A1_Design section 8 says only the responder changes. That is not quite true: the ledger refuses a reused idempotency key and stores no reply, and `AssistantRequest` carries nothing unique per attempt. Add `requestId` = `{conversationId}:{pendingId}` in `types.ts` and pass it from `provider.tsx` (`run` already has `pendingId`). A user Retry creates a new pending id, so it is a new attempt and counts again if the earlier one was billed. A transport-level resend of the same attempt reuses the id and is refused as a duplicate, so the app must not auto-resend.

Server bounds (tighter than the client's; from audit section 12): message 1,000 characters; history last 6 turns and 2,500 characters; server facts about 3,000 tokens; output 500 tokens; provider timeout 15 s, so settlement finishes inside the app's 20 s timeout. Client history is **untrusted**, including turns labelled `assistant`: send it as quoted transcript data in the user input, never as system or assistant authority.

| Server outcome | HTTP, `code` | App `AssistantError.kind` |
|---|---|---|
| no or bad token | 401 `unauthenticated` | existing session handling, then `refused` |
| not entitled, wrong role, not a member, paused | 403 | `refused` |
| gate off, old build | 403 / 426 | `unavailable` |
| `payer_day`, `payer_month`, burst limit | 429 `rate_limited` | `rate_limited` |
| `disabled`, `feature_day_cost`, `global_day_cost`, ledger error | 503 | `unavailable` |
| duplicate `requestId` | 409 | `unknown` |
| provider timeout | 504 | `timeout` |
| provider error or unusable output | 502 | `unavailable` |

Provider error text never reaches the app.

## 4. Entitlement and who pays

**LUMI** (E2, E3, E6, E7)
- Eligible: an active dancer with at least one linked studio that has LUMI enabled **and** a Growth or Pro plan, active or trialing. The server picks or verifies that studio; a client-supplied studio id is only a choice among eligible links.
- Pays: `payer_scope = platform_personal`, `payer_id` = the user, `studio_context_id` = the studio whose data is used. Never a studio pool; sponsorship stays off.
- Pilot limits: 5 a day, 20 a month per dancer, loaded into the `lumi` control row. Not product pricing.
- The existing web LUMI plan feature charges a studio LUMI pool in #769. This design does not change it.

**ARIA**
- Eligible: whatever role may open the matching read screen, using the same predicate as the read route (`canViewStudioSchedule`, `canViewClients`, and so on). A refused screen context is dropped, not echoed.
- Plan gate and payer are **not decided** (roadmap Decision #8; section 10, Q2). Until they are, the `ariaChat` gate stays limited to allow-listed internal accounts, and nothing draws on the studio `ai_action` allowance.

## 5. Ledger fit and gaps (input to the ledger's database review)

| Gap in `ai_usage_ledger_v1` | Effect on A2 | Proposal |
|---|---|---|
| Counts are per payer only; `actor_user_id` is stored but never limited | with a studio payer, one staff account can use up the studio's day | add a per-actor daily limit to the control row |
| No burst or concurrency limit (audit: 3 a minute, 2 in flight) | per-instance memory limiter only | check both inside `ai_reserve` |
| Duplicate key refuses and cannot replay a reply | covered by the `requestId` rule above | accept (no content is stored, by design) |
| No monthly cost ceiling, no `lock_timeout`; all reservations lock one row | a slow lock could eat the 15 s budget | add both; fail closed on lock timeout |
| Payer scope and id are caller-supplied | a server bug could charge the wrong payer | derive only server-side from the authenticated identity; test it |

## 6. Context: re-authorized, minimal, server-built

The client sends a screen id and ids only. For each request the server re-checks every id against the caller, ignores what it cannot authorize, and builds the facts itself. Prefer the caller-token client so row security applies; where the Student side must use the admin client (as `studio-links` does), every query carries an explicit user and link scope with a cross-user test.

| Assistant | Screen | Facts the model may receive (v1) |
|---|---|---|
| LUMI | today, schedule | the caller's own upcoming items: type, title, local date and time, status |
| LUMI | event-detail | public details of an event the caller may see |
| LUMI | wallet | pass and balance types, counts, expiry dates; no codes, amounts paid or order ids |
| LUMI | events-list | public listing fields already shown on the screen |
| ARIA | today, pulse | the aggregates and statuses the role already sees from the same loaders |
| ARIA | appointment-detail | time, type, status, roster count |
| ARIA | client-detail, clients | status, upcoming and past counts, dates |

Never sent in v1: names of dancers, clients or staff, email, phone, address, birth date, free-text notes, lesson recaps, payment details, tokens or ids. Studio-written strings (titles, descriptions) are untrusted data in a delimited block and cannot change instructions; links are limited to the whitelist and revalidated by the app; replies render as plain text.

Logging: the wrapper's accounting line and the ledger row only. No prompt, reply or fact content is stored or logged. Conversations stay in memory on the device, as in A1.

## 7. Release requirements beyond the server

- Privacy and Play data-safety text must name the AI processor and what is sent, before any build that can reach the endpoint is distributed beyond internal QA.
- Verify Google Play's current policy for AI-generated content (in-app reporting). The shared sheet has no report control. A user report is a write by the user, not an assistant action, but it needs its own scoped slice.
- Replace the "preview answer" intro and disclaimer copy.
- TalkBack: H11 accepts static accessibility proxies for limited internal QA only. Actual assisted or human TalkBack verification is required before wider release; it is not assigned to the owner. It is still unmet (`mobile/shared/qa-a1/README.md`).

## 8. Flags and the internal QA environment gate (E9)

Production stays off at every layer: app flags `ariaAssistant` and `lumiAssistant` unset, `MOBILE_ASSISTANT_POLICY` unset, ledger control rows absent or disabled.

Internal QA activation is a separate approval. Proposed conditions, all required:

1. P1 to P5 met in the non-production environment, with the DEV ledger fingerprint recorded.
2. Server target and database are non-production; the provider key belongs to the non-production project with a verified hard limit.
3. The policy allow-lists named test accounts only; test data only.
4. The expected cost of charge-bearing tests is reported before they run (E10).
5. Internal build with the flag word, not uploaded to Play, never built with production endpoints.
6. A written switch-off (unset the policy, disable the control row) tried once.

## 9. Delivery slices and verification (none authorized yet)

| Slice | Content | Done means |
|---|---|---|
| A2-1 | `requestId` in shared types and provider, parity copies | jest and parity tests pass; flags-off behaviour unchanged |
| A2-2 | pipeline, guards, policy parser, error mapping, with fake provider and ledger | refusals make zero provider calls; read-only test passes; both routes disabled by default |
| A2-3 | LUMI and ARIA context builders | cross-user, cross-studio and role-refusal tests; a payload test proves excluded fields never reach the provider |
| A2-4 | app server responder behind the existing flags | abort, timeout and error kinds covered; stub remains for flags-off tests |
| A2-5 | non-production activation | the section 8 gate; HTTP-level count and cost checks; device smoke |

## 10. Open decisions (recommendations are not approvals)

| Q | Question | Recommendation | Blocks |
|---|---|---|---|
| Q1 | Plan authorization (E7) means a dancer with no eligible studio gets no LUMI although the allowance is platform-funded (E6). Intended? | Yes for the pilot | A2-3 eligibility |
| Q2 | ARIA payer and plan gate | pilot: platform-bounded `aria_chat` control row with a small daily cost ceiling, payer `studio_ops` for attribution only, no `ai_action` deduction; plan placement stays with Decision #8 | ARIA beyond internal QA |
| Q3 | May ARIA ever send client first names to the provider? | No in v1; revisit with usage evidence | A2-3 |
| Q4 | Does server chat in mobile LUMI count as a new LUMI enhancement (roadmap Decision #24)? | Confirm explicitly when authorizing the build | LUMI build |
| Q5 | Close the ledger gaps before A2, or accept them for the pilot | Close per-actor, burst/concurrency and lock timeout first | P4 |
