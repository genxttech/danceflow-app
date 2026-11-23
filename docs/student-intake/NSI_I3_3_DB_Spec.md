# NSI I3-3 (M15) database specification: minor determination service path (revision 2, for review before any migration)

Status: **specification only (revision 2, after the independent review: conditional GO for local-only work).** No SQL, code, flag, env or email is authorized by this document. Gate A stays closed; no billing gating (pilot grants, staff roles and Gate A only). **Numbering:** this slice is **M15**. M14 is the hold-semantics and purge-liveness fix (`NSI_M14_Hold_Semantics_Spec.md`), a safety item that comes first. Sequence: M13 DEV apply, M14, this slice (M15), then I3-2 (M16).

**Owner-decision labels.** Everything marked **[recommended, pending owner decision]** is a DRAFT default that implements my recommendation. It stays flag-free and changeable (one function or one setting each). Silence is not approval.

## 1. Scope
1. The **minor determination service path** (A5): a birthday-based determination, a self-declaration fallback, a session-facing routing read, and a staff-facing read of the basis.
2. **Moved to I3-2 (M16):** guardian decline (A6) and N1 outcome alignment (A9). A terminal declined status with no writer would be dead code, and guardian sessions do not exist yet (M12 is student audience only).
3. Post-completion changes (a birthday corrected after submission, a client who turns 18 between invitation and submission) are handled by the I3-4 submit step calling the determination again (section 5) and, for already-completed requests, by I3-2.

## 2. Principles
1. **No personal value crosses the function boundary.** The database reads `clients.birthday` itself, scoped to the request's studio; callers get only outcome words. No birthday, age or threshold appears in a return value, an audit row or an error text.
2. **Determinations are append-only and monotone.** The latest row governs, but **an automatic path may never write "adult" once any row says "minor"**. Only an owner or admin (existing staff function, mandatory reason, source `staff_override`) can move a request from minor to adult. A `staff_override` row also blocks every later automatic insert.
3. **A declaration is not authenticated evidence** (P1-A rule): it is stored as `declared`, with provenance (section 4), and the birthday rule runs first inside the database so a declaration can never override a trusted birthday.
4. **Lock order** (every writer): read session and request without locks, `lock_client`, `request FOR UPDATE`, then **re-check** the session (not revoked, not expired, `link_valid`) after the lock. Each function gets a deterministic lock-order check and a probe removing `lock_client`.
5. Nothing writes to appointments, clients or `client_account_links`. The age rule is isolated in helpers so O5 changes one function, not the design.

## 3. Age rule [recommended, pending owner decision O5]
**Reference date: the studio-local date.** `intake_private.studio_local_date(p_studio_id)` returns `(now() at time zone tz)::date` where `tz` is the studio's validated time zone (`studio_settings.timezone`, checked against `pg_timezone_names`). **A null or invalid time zone falls back to `Etc/GMT+12` (UTC-12, the last place on Earth to reach a new date)**, so a misconfigured studio can never make anyone an adult early. The local date is stored in `evaluated_on`.
`intake_private.age_in_years(p_birthday date, p_on date)` = completed years using `date_part('year', age(p_on::timestamp, p_birthday::timestamp))` (the `timestamp` overload, never the `timestamptz` one), flagged IMMUTABLE. A person is a **minor** when that age is below the **effective threshold** `greatest(intake_settings.minor_age_threshold, 18)`.
- **Threshold clamp [recommended, pending owner decision O5b]:** the studio setting allows 13 to 21 today; until the owner and counsel decide otherwise, values below 18 are **clamped up to 18** inside the function (a studio cannot lower the age of majority for intake). The conflict between the setting's range and the clamp is itself an explicit owner decision; tests cover thresholds 13, 18 and 21.
- The day of the 18th birthday: adult. The day before: minor. 29 February birthdays: PostgreSQL semantics, the person turns 18 on 1 March; flagged for legal review with O5.
- A birthday in the future, or older than 120 years, is **not trusted**: treated as no birthday.
- The "pending legal review" note stays attached in the staff UI until cleared (spec 14.9).

## 4. Functions (level 11; all `SECURITY DEFINER`, pinned search path; explicit `REVOKE ALL ... FROM public, anon, authenticated, service_role, intake_destructive`, then `GRANT EXECUTE` to the listed role only)

| Function | Role | Behavior |
|---|---|---|
| `intake_determine_minor_from_birthday(p_studio_id, p_request_id)` returns text | `service_role` | Lock order of section 2. Early returns, each its own **explicit outcome word or error code**: unknown request (22023), Gate A closed (`gate_closed`), erasure barrier (`erasure_barrier`), client/studio drift (`assert_drift_free`, 42501), request not open (`request_not_open`: only `pending`, `invited`, `in_progress` qualify). Then: `staff_override_exists`, `kept_minor` (a minor row exists and the birthday would say adult), `no_birthday` (also for untrusted birthdays), `already_current` (the latest automatic row has the same answer, source and threshold: **no new row**, so a daily call cannot grow the table; the comparison ignores the date), or `determined_minor` / `determined_adult` (one `birthday` row, `evaluated_on` = studio-local date, effective threshold recorded, audit `minor_determination_recorded` with `basis` only) |
| `intake_declare_minor_status(p_session_hash, p_is_minor)` returns text | `service_role` | Session rules of section 2 (audience must be `student`). **First applies the birthday rule inside the database** by running the determine logic: if a trusted birthday exists the declaration is ignored (`birthday_used`, the birthday result governs, a birthday-minor can never be overridden by a declaration). Otherwise: `already_determined` if any row exists, else one `declared` row (declared class `minor` or `adult`; [recommended, pending decision O12] plus `under_13` as a third class so the app can route it to staff without collecting a date). **Provenance:** audit `minor_determination_recorded` with `actor_type = 'student'`, `object_type = 'intake_session'`, `object_ref` = the session id, metadata `basis` = `declared` or `declared_via_staff_link` (when the session's minting actor is a staff member) and `generation` |
| `intake_session_minor_state(p_session_hash)` returns text | `service_role` | `unknown`, `minor` or `adult` for the session's request (latest row); nothing for an invalid session. **Routing only: the app must never display it.** No source, date or threshold |
| `intake_minor_basis(p_studio_id, p_request_id)` returns table | authenticated, `assert_staff('view_status')` | For staff: the source word (`birthday`, `declared`, `staff_override`), whether the declaration came through a staff-minted link, the effective threshold and the local date it was evaluated on. **Never the birthday.** The UI labels a birthday-based answer as such |
| `intake_private.studio_local_date(uuid)`, `intake_private.age_in_years(date, date)` | none | Internal helpers (STABLE and IMMUTABLE respectively, recorded in the catalog inventory); no API grants |

**[Recommended, pending owner decision O11] A declared adult never completes without staff confirmation.** Because a self-declared "adult" through a link is not verified, `fulfillment_state` gains a derived state `staff_confirmation_outstanding` when the latest determination is `declared` and adult; staff clear it with the existing override (reason required). Implemented as one branch in `fulfillment_state` (changeable); listed as an owner decision.

The existing staff function `intake_record_minor_determination` is unchanged: owner/admin, mandatory reason, source `staff_override`; it is the only path from minor to adult.

## 5. How the student path uses it (I3-4, not here)
The app calls `determine` when the invitation is issued, `session_minor_state` when a session opens (`minor` leads to the guardian flow, `adult` to the student flow, `unknown` to the declaration question), and **calls `determine` again at submission** so the answer is evaluated as of the submission date (the monotone rule means a minor can never become an adult by waiting out the call).

## 6. Catalog and privileges
Level 11: the four public functions and the two helpers; the existing `intake_minor_determinations` table, triggers and policies unchanged. Body markers `nsi-body:m15` for the four public functions. The rollback drops the functions and restores the M14 `assert_catalog` and is **refused once any `birthday` or `declared` row exists**; its fingerprint is checked against the expected M14 value, and the harness includes the replay guard test (replaying M15 on a newer database must fail closed or be documented).

## 7. Tests (new suite, lifecycle harness, DEV-safe suite, concurrency)
- **Time zone and date (P1-1):** a studio in Los Angeles at 23:30 the day before a birthday (still a minor); `Pacific/Kiritimati`; null and invalid time zones fall back to `Etc/GMT+12`; the stored `evaluated_on` is the local date.
- **Age rule edges:** the day before and the day of the 18th birthday; 29 February birthdays in leap and non-leap years; thresholds 13, 18 and 21 (13 clamps to 18); future and 120-year-old birthdays; null birthday.
- **Birthday first (P1-2):** a declaration cannot override a trusted birthday-minor; probe removing the in-database birthday rule.
- **Provenance (P1-3):** audit row contents for `declared` and `declared_via_staff_link`; the staff read exposes the basis and never the birthday; O11 branch behavior.
- **Monotone (P1-4):** after a minor row, an automatic adult attempt returns `kept_minor` and writes nothing; only the staff override moves to adult.
- **Reference and state (P1-5):** automatic determinations refuse non-open requests with the explicit word; the submission-date re-evaluation.
- **Lock order (P1-6):** declare racing revoke, determine and staff override ends consistently; deterministic lock-order check; probe removing `lock_client`; session re-checks after the lock (a session revoked while waiting yields nothing).
- **No daily growth:** repeated calls on later dates write nothing when answer, source and threshold are unchanged.
- **Early returns:** Gate A closed, erasure barrier, drift, non-open request each give their explicit outcome.
- **Tenant scoping:** a client's birthday from another studio is never used.
- **Privileges:** service_role only; `anon` and `authenticated` refused; helpers not executable; the staff read rejects non-staff; no personal value in any return, audit row or error.
- **Mutation probes:** drop the monotone rule, drop the override check, drop the "no row exists" check on declare, drop the birthday-first rule, flip `<` to `<=`, drop the birthday sanity bounds, drop the time-zone fallback, drop `lock_client`.
- DEV-safe level-11 suite (no fixtures), rollback and replay-guard checks, full-chain replay after the slice.

## 8. Owner decisions (all pending; defaults above are drafts)
| # | Decision | Draft default |
|---|---|---|
| O5 | Age threshold, 29 February rule, "pending legal review" wording | 18, 1 March rule, keep the note |
| O5b | Whether a studio may set a threshold below 18 | clamp to 18 until counsel decides |
| O11 | A declared adult requires staff confirmation | yes (derived state, changeable) |
| O12 | An extra declaration class `under_13` | yes, routing only, no date collected |
| O4 | Guardian decline semantics (I3-2) | terminal |
