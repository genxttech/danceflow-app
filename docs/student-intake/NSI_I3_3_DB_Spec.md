# NSI I3-3 (M15) database specification: minor determination service path (revision 1, for review before any migration)

Status: **specification only. Renumbered from M14 to M15: the new M14 is the hold-semantics and purge-liveness fix (`NSI_M14_Hold_Semantics_Spec.md`), a safety item scheduled before this slice.** No SQL, code, flag, env or email is authorized by this document. Gate A stays closed; no billing gating (pilot grants, staff roles and Gate A only). It follows `NSI_I3_2_I3_3_Design.md` §2 and builds on M12/M13 (invitations, sessions, purge hardening).

**Owner-decision labels.** Everything marked **[recommended, pending owner decision]** uses my recommendation as a DRAFT default (O4 decline, O5 minor threshold and wording). The behavior is kept **flag-free and changeable**: the threshold lives in `intake_settings.minor_age_threshold` (already a studio setting), the age rule is isolated in one helper function, and nothing here is activated. The owner's silence is not approval.

## 1. Scope change from the earlier design (stated plainly)
The earlier design put **guardian decline** (A6) in I3-3. Decline is a guardian-session action and guardian sessions do not exist yet (M12 is student audience only). A terminal `declined` status with no writer would be dead code and widening the request-status CHECK now would touch every status list (guard transitions, `link_valid`, the evaluator, `fulfillment_state`). **Decline moves to I3-2**, together with the guardian audience. I3-3 is therefore only:
1. the **minor determination service path** (A5), and
2. a small **session-facing read** so the app can tell a student session whether a determination exists.
N1 outcome alignment (A9) also moves to I3-2, when there is a guardian path to align with.

## 2. Principles
1. The database reads the client's birthday itself (`clients.birthday`, a date). **No birthday or other personal value is passed in or returned**; callers get only an outcome word.
2. Determinations are **append-only** (table already immutable); the latest row governs (as today). Automatic paths never overrule a staff decision: a `staff_override` row blocks every later automatic insert.
3. **A declaration through a link session is not authenticated evidence** (P1-A rule): `declared` is the lowest-ranked source, is recorded as `declared`, and is never promoted. If a birthday is known it is used instead.
4. Lock order: client lock first, then the request row, then inserts (same as every M12/M13 writer). Every new function gets a deterministic lock-order check.
5. Nothing writes to appointments, clients or `client_account_links`. The age rule is one helper so changing it (O5) needs one function replaced, not a redesign.

## 3. Age rule [recommended, pending owner decision O5]
`intake_private.age_in_years(p_birthday date, p_on date)` = completed years using PostgreSQL `age()` semantics. A person is a **minor** when `age_in_years(birthday, current_date) < intake_settings.minor_age_threshold` (default 18, studio-configurable 13 to 21 as today). Edge rules written down and tested:
- The day of the 18th birthday: adult. The day before: minor.
- 29 February birthdays: PostgreSQL treats the birthday in a non-leap year as 1 March (the person turns 18 on 1 March), so they stay a minor one day longer. Recorded as an explicit rule, flagged for legal review with the rest of O5.
- A birthday in the future, or older than 120 years, is **not trusted**: the function returns `no_birthday` (treated as unknown), never an adult or minor answer.
The "pending legal review" note stays attached in the staff UI until the owner clears it (spec 14.9).

## 4. Functions (level 11; all `SECURITY DEFINER`, pinned search path)

| Function | Callers | Behavior |
|---|---|---|
| `intake_determine_minor_from_birthday(p_studio_id, p_request_id)` returns text | `service_role` | Client lock, request row. Refuses an unknown request (22023). Outcomes: `staff_override_exists` (nothing written), `no_birthday` (nothing written), `already_current` (the latest row is a `birthday` determination made today with the same answer: nothing written), `determined_minor` / `determined_adult` (one `birthday` row; `threshold` and `evaluated_on` recorded; audit `minor_determination_recorded` with metadata `basis` only). Idempotent and safe to call on every issue and on every day |
| `intake_declare_minor_status(p_session_hash, p_is_minor)` returns text | `service_role` | Resolves the session through the shared validity check (the M12 `link_valid`; an invalid session returns nothing). Writes one `declared` row **only when no determination of any kind exists** (a birthday or staff override always outranks it); outcome `recorded`, `already_determined` or nothing. The declaration class stored is `under_threshold` or `at_or_over` (no age or date) |
| `intake_session_minor_state(p_session_hash)` returns text | `service_role` | Returns `unknown`, `minor`, `adult` for the session's request (latest row), or nothing for an invalid session. Lets the app choose the student-only or the minor flow before the form opens. Never returns a source, a date or a threshold |
| `intake_private.age_in_years(date, date)` | none (internal, immutable) | The age rule of section 3 |

The existing staff function `intake_record_minor_determination` (owner/admin, mandatory reason, source `staff_override`) is unchanged. A staff override remains the way to correct a wrong birthday or to decide a client with no birthday; it needs a reason and is audited.

## 3a. What the student path does with it (I3-4, not here)
Student submit is already refused until a determination exists (M5, P2-4). I3-4 calls `intake_determine_minor_from_birthday` when the invitation is issued and `intake_session_minor_state` when a session opens: `minor` leads to the guardian flow (I3-2), `adult` to the student flow, `unknown` to the declaration question (which calls `intake_declare_minor_status`) with staff notified that the status is self-declared.

## 5. Catalog and privileges
Level 11 functions: the three public functions (service_role execute only; anon, authenticated and PUBLIC none) and `age_in_years` (no API grants). No table, trigger or policy changes; no change to `intake_minor_determinations`. `assert_catalog` loop runs 1..11. Body markers (`nsi-body:m14`) for the three public functions. Rollback drops the four functions and restores the M13 `assert_catalog`; it is refused once any `birthday` or `declared` determination row exists (forward-fix only).

## 6. Tests (new suite, lifecycle harness, DEV-safe suite, concurrency)
- **Role matrix and privileges:** service_role only; `anon`/`authenticated` refused; no table grants; the catalog check.
- **Age rule:** the day before and the day of the 18th birthday; 29 February birthdays in leap and non-leap years; a studio threshold of 16 and 21; future and 120-year-old birthdays return `no_birthday`; null birthday.
- **Precedence:** a `staff_override` blocks later birthday and declared rows; a birthday blocks a later declaration; a declaration is never inserted when any row exists; the latest row governs `fulfillment_state` and `intake_session_minor_state`.
- **Idempotence and concurrency:** parallel `determine` calls end with one row; `determine` racing a staff override ends with the override governing; lock-order check (the function waits on a held client lock and does not hold the request row).
- **Session read:** invalid, expired, revoked, submitted and gate-closed sessions return nothing; a valid one returns the state and nothing else.
- **Privacy:** no birthday, age or threshold appears in any return value, audit metadata or error text.
- **Mutation probes:** drop the override check, drop the "no determination exists" check on declare, flip the comparison (`<` to `<=`), drop the sanity bounds on the birthday, drop `lock_client`.
- **DEV-safe level-11 suite** (no fixtures; callable checks refuse or return nothing while Gate A is closed), rollback checks, full-chain replay after the slice.

## 7. Open points
1. O5: threshold default, the 29 February rule, the "pending legal review" wording [recommended: 18, 1 March rule, keep the note].
2. Whether a birthday-less client may reach the declaration question at all, or staff must determine first [recommended: allow the declaration, flag it to staff, never treat it as verified].
3. Decline and N1 alignment move to I3-2 (O4 decline semantics [recommended: terminal, pending owner decision]).
