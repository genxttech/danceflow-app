# NSI I3-1 (M12) database specification: invitations, sessions, rate limits

Status: **specification for review before implementation** (2026-11-23). Nothing here is built, applied or authorized beyond local DEV-safe work. No email, no customer-visible surface, no shared outbox, Gate A closed, no billing gating (pilot grants, staff role and Gate A only). Refines `NSI_I3_PartA_Design.md` §3 row I3-1 (items A1, A2, A7).

## 1. Why a specification first
M12 must extend `intake_private.assert_catalog` (exact inventory of relations, grants, triggers, policies and function ACLs), add three tables with the live-table guard pattern, add a capability to staff authorization, and keep every M1-M11 suite green. That is about 1,500 lines of migration, rollback, tests and harness. The points below fix the decisions that change that work, so the implementation is reviewed once.

## 2. Principles specific to this slice
1. **The database never sees the signing secret.** The token is derived in the app server (HKDF from `INTAKE_ROOT_SECRET`, spec §5.1). The app generates `invitation_id` and `token_salt`, derives the token, and passes only `sha256(token)` to the database. SQL stores hashes and salts, never tokens.
2. **Invalid, expired, revoked, suspended and gate-closed give one answer**: the exchange RPC returns zero rows (no error text, no timing-visible branch other than the rate limit).
3. **Writes are RPC-only**, `service_role` for the account-free path and the app server; no API-role table grants, RLS enabled with no policies except the destructive role's select and delete (same pattern as the M3 live tables).
4. **No writes to appointments, clients or `client_account_links`.** The catalog self-check already enforces the appointments half.
5. **Gate behavior**: issuing an invitation is a new obligation (Gate A and Gate B, plus the `live_collection` grant through the existing gate trigger); exchanging a link and saving a draft are continuing actions (Gate A and the erasure barrier only), so an already-issued request stays completable after a grant lapses (spec §9 N1).

## 3. Tables (catalog level 10; all `public`, owner postgres, RLS on, no API-role grants)

| Table | Columns (all NOT NULL unless noted) | Constraints and guards |
|---|---|---|
| `intake_invitations` | `id uuid` (app-generated), `studio_id`, `request_id`, `audience text` (`student`\|`guardian`), `generation int >= 1`, `kid text`, `token_salt bytea` (16 bytes), `token_hash bytea` (32 bytes), `issued_by text` (`staff`\|`reconciler`), `issued_by_user uuid` null, `pinned_version_id uuid` (A7), `expires_at`, `revoked_at` null, `revoked_reason text` null, `created_at` | unique `(request_id, audience, generation)`; unique `(token_hash)`; FK `(studio_id, request_id)` to requests; gate trigger `new_obligation`; tenant guard (request belongs to studio, pinned version belongs to the request's template and is published); update guard: only `revoked_at`/`revoked_reason` may change, once; delete guard; no truncate |
| `intake_sessions` | `id uuid`, `studio_id`, `request_id`, `invitation_id`, `audience`, `session_hash bytea` (32), `created_at`, `last_seen_at`, `idle_expires_at`, `absolute_expires_at`, `revoked_at` null | unique `(session_hash)`; FK to invitation; gate trigger `continuing`; update guard: only `last_seen_at`, `idle_expires_at`, `revoked_at`; delete only by `intake_destructive` (retention purge of expired sessions) |
| `intake_rate_limits` | `bucket_hash bytea` (32, sha256 of `kind\|key`), `window_start`, `hits int` | primary key `(bucket_hash, window_start)`; no studio column (keys are hashed); delete only by `intake_destructive`; fail-closed function (below) |

Audit: new event types (`invitation_issued`, `invitation_revoked`, `link_exchanged`, `session_revoked`) are added to the audit event-type CHECK with `operational` retention. Audit rows carry ids only, never hashes or tokens.

## 4. Functions (level 10)

| Function | Callers | Behavior |
|---|---|---|
| `intake_issue_invitation(p_studio_id, p_request_id, p_audience, p_invitation_id, p_kid, p_token_salt, p_token_hash, p_expires_at, p_source, p_actor_user)` returns uuid | `service_role` | Takes the client lock; refuses unless the request is open and not suspended; pins the request's version once (A7: pins the latest published version if not pinned); generation = previous + 1 for this audience; revokes the previous generation in the same transaction; inserts; audits. Caller authorization (which staff role) is enforced by the app and recorded in `issued_by_user`; DB-side per-role capability arrives with O2 (D1) in I3-2. |
| `intake_revoke_invitations(p_studio_id, p_request_id, p_audience, p_reason)` | `service_role` | Revokes all unrevoked generations; revokes their sessions. |
| `intake_exchange_invitation(p_token_hash, p_session_hash, p_idle_seconds, p_absolute_seconds)` returns table(studio_id, request_id, audience, session_id) | `service_role` | Looks up by hash; returns **zero rows** unless: not revoked, current generation, not expired, request open and not suspended, linked appointment live (when the request has live attachments), Gate A open, no erasure barrier, rate limit not exceeded. Creates the session row and audits `link_exchanged`. Multi-use: repeated exchange creates additional sessions. |
| `intake_session_context(p_session_hash)` returns table(studio_id, request_id, audience, respondent context) | `service_role` | Resolves a live session (idle and absolute limits, invitation still current, request open); extends the idle window (sliding, capped at absolute); zero rows otherwise. |
| `intake_revoke_session(p_session_hash)` | `service_role` | Marks revoked; idempotent. |
| `intake_rate_limit_hit(p_bucket_hash, p_limit, p_window_seconds)` returns boolean | `service_role` | Atomic upsert increment; returns false (deny) when over the limit **or on any error** (fail closed). |
| `intake_purge_expired(p_limit)` | `intake_destructive` | Deletes expired sessions and old rate-limit windows in bounded batches; never touches invitations (they are evidence of issue). |

The completion RPCs that exist (`intake_save_draft`, `intake_submit_response`) are not changed in I3-1; I3-4 (app) calls them with the context returned by `intake_session_context`. A7's "submission refused after expires_at" is enforced by `intake_session_context` returning zero rows past the invitation's `expires_at`, and by a check added in I3-4 when those RPCs derive the respondent from the session (separate small migration, because they are M5 functions).

## 5. Catalog inventory deltas (assert_catalog)
- `c_rel`: the three tables, level 10, no direct grants (the live-table expansion supplies the destructive select and delete policies for sessions and rate limits only; invitations are never deleted).
- `c_fn`: the seven functions plus the guard functions, level 10, grantees as above; `c_guard` markers for replaced bodies (none in M12 beyond assert_catalog itself).
- `c_trg`: gate, tenant, update-guard, delete-guard and no-truncate triggers per the table column above.
- The self-check loop runs 1..10 (the objects of the M10 and M11 files never had their own level; level 10 is the first new catalog level since M9).
- Fingerprint harness (`nsi_i2_catalog_fingerprint_local.sql`) needs no change: it already covers every `intake_%` object.

## 6. Test matrix (new suite `test_T_nsi_i3_1_local.sql`, plus lifecycle harness `nsi_i3_1_lifecycle_local.sh`)
Issue: gate closed refused; grant lapsed refused; request suspended or submitted refused; generation increments and the previous generation is revoked; pinned version set once and immutable; two parallel issues for one request end with one live generation (concurrency script). Exchange: every invalid class returns the identical empty result and writes nothing (revoked, old generation, expired, suspended, wrong audience, gate closed, barrier active, cancelled appointment); repeated exchange creates sessions; rate limit denies after the limit and on error. Sessions: idle and absolute limits, sliding extension capped at absolute, revoke, invitation revoke kills sessions, a lapsed grant does not kill an already-issued request's session. Privileges: no API-role table grants, function ACLs exactly as listed, tokens and secrets absent from every column and from audit. Rollback: refused once any invitation, session or audit event of these types exists (forward-fix only), exact fingerprint restore otherwise. Full-chain replay re-run after the slice.

## 7. Open points for review
1. **Staff capability.** Staff-initiated issue (copy link) goes through the app server with `service_role` and records `issued_by_user`; the database cannot independently enforce the role. This is the same trust model as `intake_ensure_request` today. DB-side capability enforcement is planned with O2 (guardian invitation roles). Acceptable for DEV-only local work? Recommendation: yes.
2. **Where the session cookie is minted.** App server generates 256 bits of randomness and passes `sha256` to `intake_exchange_invitation`; the cookie is never stored in clear. (Confirms spec §5.2.)
3. **Idle and absolute limits** are parameters of the exchange call (defaults 1,800 s and 14,400 s per recommendation O6), not table defaults, so changing them needs no migration.
4. **Rate limit buckets** are keyed per token hash, IP, email and request by the app (hashing `kind|value`); the database only counts. The trusted client-IP source on Vercel remains an engineering prerequisite.
5. **Purge ownership.** `intake_purge_expired` runs under the restricted `intake_destructive` role from a cron the app provides in I4; until then expired rows simply accumulate (no PII, hashes only).
