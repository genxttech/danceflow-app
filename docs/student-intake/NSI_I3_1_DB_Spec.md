# NSI I3-1 (M12) database specification: invitations, sessions, rate limits (revision 3)

Status: **specification, amended after the independent review (CONDITIONAL GO, P1-1..P1-4 plus P2s), 2026-11-23.** Implementation is local-only DEV-safe work: no email, no outbox, no customer-visible surface, Gate A closed, no billing gating (pilot grants, staff role and Gate A only). Refines `NSI_I3_PartA_Design.md` §3 row I3-1 (items A1, A2, A7). Revision 1 is superseded; the changes are listed in section 9.

## 0. Revision 3: reconciliation with the implemented SQL (authoritative where it differs from sections 1 to 9)

Revision 2 was written before the implementation and two review rounds. Where the text below differs from this table, **this table and the migration win**.

| Topic | Implemented behavior |
|---|---|
| Issue signature | `intake_issue_invitation(p_studio_id, p_request_id, p_invitation_id, p_generation, p_kid, p_token_salt, p_token_hash, p_expires_at)`: the caller states the generation it derived the token for; a mismatch raises 22023 (so a delivery retry can never send a link that is already dead). Staff read it first with `intake_next_invitation_generation(p_studio_id, p_request_id)` (same `assert_staff('send')` rule) |
| Issue pre-checks | request open; **a request whose attached appointments are all dead is refused before anything is revoked** (`request_has_live_target`); expiry clamp 1 hour to 30 days |
| Lock order (every writer) | client lock (`lock_client`) first, then the request row, then the invitation rows. Exchange, issue, revoke, bulk revoke and erase all follow it. The bulk key revoke takes one invitation at a time in (studio, client, invitation) order, at most 500 per call (default 200), one run at a time; the purge does not wait on writer locks: it takes a **non-waiting client lock** (`intake_private.try_lock_client`, the same key as `lock_client`) per candidate row and skips any client whose lock is held. It cannot use row locks (`FOR UPDATE SKIP LOCKED`) because the restricted role has SELECT and DELETE only. The purge implementation is owned by `intake_destructive` (wrapper `intake_purge_expired` owned by postgres) and is **not audited** |
| Revoke | `intake_revoke_invitations(p_studio_id, p_request_id)` has **no `p_reason` parameter** (reason is always `staff_revoked`; `resent`, `key_rotation` are set by the system paths). Deviation recorded; `request_closed` and `erasure` reasons are reserved and currently unused |
| Exchange | unknown token: returns nothing and writes **nothing**; known token: per-token counter (20 per 10 minutes) is incremented under the invitation row lock; the live-session cap (10) is serialized by that same lock and is exact under concurrency |
| Audit | `link_exchanged` is a **system** event (an exchange proves possession of a link, not an authenticated student), metadata `audience` and `generation` so request plus generation joins back to the `invitation_issued` event and its staff actor. Purge is **not audited** (cross-studio); the I4 cron logs the counts |
| Minting actor (P1-A, option 2) | `intake_invitations.issued_by_user` is copied to `intake_sessions.issued_by_user` (the session guard enforces equality, the update guard makes it immutable) |
| Rate-limit table | primary key `(bucket_hash, window_seconds, window_start)`; **no BEFORE INSERT trigger** (writes happen only inside `intake_rate_limit_hit`, which refuses while Gate A is closed); TS keys are HMAC (subkey `intake/ratelimit/v1`) over kind, window and value |
| Signing secret | `INTAKE_ROOT_SECRET` is 32 random bytes encoded as hex or base64 (for example `openssl rand -base64 32`); anything else, and any degenerate value, is refused by `loadIntakeKeyring`. **It is not provisioned anywhere** (Student Intake is dark); the repository's example env files do not mention it. Whether a hosting environment already holds a value was not checked (names and values are owner-controlled) |

### P1-A rule (hard blocker for I3-4 and any UI wiring)
A submission made through a link session is **never student-authenticated evidence**: respondent assurance stays `declared_unverified` whoever opens the link. The I3-4 save and submit functions must carry session and invitation provenance (session id, invitation id, generation and the minting staff member) into the response and consent evidence, so staff-minted links are visible as such. The guardian path additionally requires the L2 email code on top of the link: with copy-link available, a link alone can never count as guardian consent, which is what makes a two-party issue unnecessary for the student path.

## 1. Scope
M12 adds student-audience invitations, sessions and rate limits. **Audience is restricted to `student`**; the guardian audience (L2 email code, L3 link, attestation) arrives with O2 and I3-2/I3-3. The `audience` column and CHECK are written so adding `guardian` later is a CHECK widening, not a redesign.

## 2. Principles
1. **The database never sees the signing secret.** The app derives the token (HKDF subkey `intake/invitation/v1`) and passes `sha256(token)` plus the salt and key id. Anyone who holds the service key **and** can choose hashes could mint links (see 4a); this is documented, not hidden.
2. **One answer for every invalid link.** The exchange and context RPCs return **zero rows** for revoked, old generation, expired, suspended, submitted, gate-closed, barrier-active, cancelled appointment, rate-limited and unknown. The rate limit makes the branch observable only through its own counter, so no claim of constant timing is made.
3. **Writes are RPC-only**; no API-role table grants; RLS on; staff never read these tables (no staff policy).
4. **No writes to appointments, clients or `client_account_links`.**
5. **Gate behavior.** Issue is a new obligation (Gate A, Gate B, `live_collection` grant via the existing gate trigger). Exchange, session context and session revoke are continuing actions (Gate A and the erasure barrier), so an issued request stays completable after a grant lapses (spec §9 N1). **Rate-limit writes are refused while Gate A is closed** (the dark state writes nothing; a deliberate, documented difference from a bare counter).
6. **Not never-deleted.** Invitations and sessions are live operational rows linked to a client through the request. They are deleted by erasure (4e) and purged by retention (4f). Evidence that an invitation was issued is the `invitation_issued` audit event (ids only), not the row.

## 3. Tables (catalog level 10; owner postgres, RLS enabled, no API-role grants)

All hash and salt columns have `octet_length` CHECKs. `revoked_reason` is an enum-like CHECK (`resent`, `staff_revoked`, `request_closed`, `key_rotation`, `erasure`).

| Table | Columns (NOT NULL unless noted) | Constraints, triggers, policies |
|---|---|---|
| `intake_invitations` | `id uuid` (app-generated), `studio_id`, `request_id`, `audience` (`student`), `generation int >= 1`, `kid text`, `token_salt bytea` (16), `token_hash bytea` (32), `issued_by text` (`staff`\|`reconciler`), `issued_by_user uuid` null, `pinned_version_id uuid`, `expires_at`, `revoked_at` null, `revoked_reason` null, `created_at` | unique `(request_id, audience, generation)`; unique `(token_hash)`; composite FK `(studio_id, request_id)`; BEFORE INSERT gate trigger `new_obligation`; tenant guard; update guard (only `revoked_at`/`revoked_reason`, once); delete guard (delete only as `intake_destructive`); no truncate; policies `*_destructive_select`/`_delete` |
| `intake_sessions` | `id uuid`, `studio_id`, `request_id`, `invitation_id`, `audience`, `session_hash bytea` (32), `idle_seconds int` (stored per session, clamped), `created_at`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `revoked_at` null | unique `(session_hash)`; composite FK `(studio_id, invitation_id)` plus a guard that `request_id` and `audience` equal the invitation's; BEFORE INSERT gate `continuing`; tenant guard; update guard (only `last_seen_at`, `idle_expires_at`, `revoked_at`); delete as `intake_destructive` only; no truncate; destructive policies; **at most 10 live sessions per invitation** (checked in the exchange RPC under the invitation row lock) |
| `intake_rate_limits` | `bucket_hash bytea` (32), `window_start timestamptz`, `window_seconds int`, `hits int` | primary key `(bucket_hash, window_start)`; **no gate or tenant trigger** (no studio column); BEFORE INSERT refuses while Gate A is closed; update only `hits`; delete as `intake_destructive` only; destructive policies; no truncate |

**Rate-limit keys.** `bucket_hash = HMAC-SHA256(HKDF subkey "intake/ratelimit/v1", kind || window_seconds || value)`, computed in the app. This is **pseudonymous, not "no personal data"**: a key holder can test a guessed email or IP. Rows are short-lived: purged after 24 hours (4f). The window length is part of the key so a different window never shares a counter.

Audit: event types `invitation_issued`, `invitation_revoked`, `link_exchanged`, `session_revoked` are added to the audit CHECK (operational retention), carrying ids only. Widening the CHECK has a matching **narrowing in the rollback**, which is refused once any of those events exists.

## 4. Functions (level 10)

### 4a. Issue and revoke (staff, authenticated)
`intake_issue_invitation(p_studio_id, p_request_id, p_invitation_id, p_kid, p_token_salt, p_token_hash, p_expires_at)` returns uuid. **Authenticated, SECURITY DEFINER; calls `assert_staff(p_studio_id, 'send')`** (owner, admin, front desk; instructors refused). The actor is `auth.uid()` and the role comes from `assert_staff`; there is **no caller-asserted actor parameter**. Behavior: client lock; request must be `pending`, `invited` or `in_progress` and not suspended or submitted; `p_expires_at` clamped to between now + 1 hour and now + 30 days (outside the range raises 22023); **pinning**: sets `request.pinned_version_id` once to the latest published version (immutable afterward) and `pinned_version_id` on the invitation equals the request's pin; first issue moves `pending` to `invited` and sets `issued_at`; generation = previous + 1, previous generation revoked (`resent`) and its sessions revoked in the same transaction; audit `invitation_issued`.
`intake_revoke_invitations(p_studio_id, p_request_id, p_reason)`: authenticated, `assert_staff(..., 'send')`, revokes all unrevoked invitations and their sessions (`staff_revoked`). A request cancelled by staff or reactivated: cancel calls the same internal revoke (`request_closed`); a reactivation issues a new generation.
`intake_revoke_all_invitations_for_key(p_kid)`: `service_role` only (operator runbook for root-key compromise), revokes every unrevoked invitation with that `kid` (`key_rotation`), bounded batches, audited.

**Service-role issue path.** The reconciler (I4) will issue through a separate `service_role` function with a NULL actor and `issued_by = 'reconciler'`. It is **not built in M12**; I4 defines it. Documented limit: the service key plus chosen hashes can mint a working link for any open request; the key must be treated as that powerful, which is already true of `intake_ensure_request`.

### 4b. Exchange (service_role)
`intake_exchange_invitation(p_token_hash, p_session_hash, p_idle_seconds, p_absolute_seconds)` returns table(session_id). Parameters are clamped (idle 5 minutes to 2 hours, absolute 15 minutes to 8 hours; out of range raises 22023, which is a programming error, not a user-visible path). Steps in one transaction: rate-limit check on a **per-token-hash bucket incremented inside this function** (so the claim "exchange writes nothing on invalid input" is replaced by "exchange writes only the rate-limit counter and, on success, one session row and one audit event"); lock the invitation `FOR SHARE` (revoke uses `FOR UPDATE`, so revoke wins races deterministically); run the **shared validity check** (4c); enforce the live-session cap; insert the session; audit `link_exchanged`. Anything else returns zero rows.

### 4c. Shared validity check and context (service_role)
`intake_private.link_valid(p_invitation_id)` is the single check used by exchange **and** by every context call: invitation not revoked and current generation, `expires_at` in the future, request status `invited` or `in_progress` (not `pending` without issue, not suspended, not submitted or terminal), **a linked appointment is live and in the future when the request has live attachments**, Gate A open, no erasure barrier. `intake_session_context(p_session_hash)` returns table(studio_id, request_id, audience) after re-running `link_valid`, the session's own idle and absolute limits and its not-revoked flag; on success it extends `idle_expires_at` by the session's stored `idle_seconds` (never beyond `absolute_expires_at`). Any failure returns zero rows and **does not** extend. Consequence, tested: suspension, barrier, Gate A re-closing, invitation expiry and submission each kill a live session at its next call. `intake_revoke_session(p_session_hash)`: idempotent, `service_role`.

### 4d. Rate limit (service_role)
`intake_rate_limit_hit(p_bucket_hash, p_limit, p_window_seconds)` returns boolean (true = allowed). Refuses to write while Gate A is closed (returns false); atomic upsert on `(bucket_hash, window_start)`; false on any error (fail closed); `p_limit` and `p_window_seconds` clamped (1..1000, 10 s..24 h).

### 4e. Erasure
M12 **replaces `intake_private.erase_client_impl`** (marker `nsi-body:m12` added to `c_guard`): sessions then invitations of the client's requests are deleted before the requests, inside the existing `intake_destructive` role context, counts added to the result (`sessions`, `invitations`). Legal holds still refuse first. Erasure and hold tests run with invitations and sessions present.

### 4f. Retention and purge
`intake_private.purge_expired_impl(p_limit)` (owner `postgres`, runs as `intake_destructive`, M5 wrapper pattern) and the role-owned wrapper `public.intake_purge_expired(p_limit)` (`service_role`): deletes sessions expired for more than 24 hours or revoked for more than 24 hours, rate-limit windows older than 24 hours, and **invitations only when their request is gone** (erasure covers that) or have been expired for more than 90 days. Bounded batches; each run audited with counts only. The cron that calls it ships with I4; until then rows accumulate, hashes only.

## 5. Catalog inventory (assert_catalog)
Level 10 relations: the three tables, direct grants none (destructive select and delete policies for all three; invitations included because erasure deletes them). Level 10 functions: the nine public and private functions above plus guard functions, with grantees: issue and revoke `authenticated`, exchange/context/session revoke/rate limit/purge/key-bulk-revoke `service_role`, `link_valid` and impls none. Custom entries (the generic live-table expansion does not fit): `intake_rate_limits` has only the refuse-while-closed and update guards and no tenant trigger; `intake_sessions` and `intake_invitations` get the generic gate and tenant triggers as live tables. `c_guard`: `erase_client_impl|nsi-body:m12|10`. The self-check loop runs 1..10 (levels 10 and 11 of the M10 and M11 files have no objects and are not levels). The fingerprint harness needs no change.

## 6. App side (I3-4, not M12)
`intake_save_draft` and `intake_submit_response` take a request and respondent chosen by the caller today. I3-4 **replaces them with session-hash forms** (the respondent and audience derive from `intake_session_context`) and **revokes execute on the old signatures**, in a separate small migration. M12 leaves them unchanged, so M12 must not be wired to a UI. The TS helpers (`src/lib/intake/invitationToken.ts`) and a new rate-limit subkey (`intake/ratelimit/v1`, HMAC instead of plain SHA-256) are updated with M12.

## 7. Tests (new `test_T_nsi_i3_1_local.sql`, `nsi_i3_1_lifecycle_local.sh`, concurrency script)
- **Role matrix** per capability: owner, admin, front desk issue and revoke; instructor, plain staff, client, organizer, platform admin, anonymous refused; **EXECUTE denied to `anon` and `authenticated`** on every service-role function (catalog check; no live permission-denied probes on the local image).
- Issue: gate closed, grant lapsed, request suspended/submitted/closed refused; expiry clamp; pin set once and equal on request and invitation; `pending` to `invited` with `issued_at`; resend revokes the previous generation and its sessions; parallel issues end with one live generation.
- Exchange and context: every invalid class returns zero rows and identical shape; counter increments only in the per-token bucket; live-session cap; sliding extension capped at absolute; **each of suspension, barrier, Gate A re-closing, invitation expiry, submission and appointment cancellation kills a live session**; a lapsed grant does not.
- Rate limit: refused while Gate A is closed, denies over the limit and on error, window length is in the key, purge deletes old windows.
- Erasure and holds with invitations and sessions present (erase deletes them; hold refuses and leaves them); purge removes only what it should.
- Privileges: no API-role table grants; function ACLs exact; no token, secret or hash in audit rows.
- **Mutation probes** (drop a guard, widen a grant, skip a check; the suite must fail) and a **level-10 DEV-safe suite** for shared DEV (fixtures only inside the transaction, no auth users).
- Rollback: refused once any invitation, session or the four audit events exist; exact fingerprint restore otherwise, including narrowing the audit CHECK and restoring `erase_client_impl`.
- Full-chain replay re-run after the slice.

## 8. Open points
1. Guardian audience, L2/L3 verification and attestation: I3-2/I3-3 after O2 (roles) and O4 (decline).
2. Service-role issue path for the reconciler: I4.
3. Idle and absolute defaults for the app (30 minutes and 4 hours, O6) are app parameters inside the clamps above.
4. Trusted client-IP source on Vercel remains an engineering prerequisite for IP buckets.

## 9. Changes from revision 1 (review items)
P1-1 live rows, destructive policies, erasure replacement; P1-2 authenticated `assert_staff('send')` issue and revoke, no actor parameter, service path deferred to I4; P1-3 HMAC pseudonymous bucket keys with `intake/ratelimit/v1`, 24-hour purge, writes refused while Gate A is closed, window in key; P1-4 shared `link_valid`, stored `idle_seconds`, session-kill tests. P2s: exchange increments its own per-token bucket (wording fixed), parameter clamps, pin equals the request pin, `pending` to `invited` with `issued_at` and reactivation, student audience only, role-owned purge wrapper, custom catalog entries and audit CHECK narrowing in the rollback, live-session cap, session equals invitation (composite FK and guard), `FOR SHARE` versus `FOR UPDATE`, I3-4 replaces draft/submit signatures, `revoked_reason` enum, `octet_length` checks, constant-timing claim dropped, bulk key-compromise revoke.
