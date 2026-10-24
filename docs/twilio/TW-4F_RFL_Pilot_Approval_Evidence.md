# TW-4F: pilot approval evidence (U-4) and approval-reference length consistency

Status: Git-only, dark. Migration `20261229090000_twilio_rfl_pilot_evidence.sql` (rollback in `rollback/`) is **not applied to any shared environment**.
Slot `20261228` belongs to another session (`tw4_prov_observe`) and is not touched.

> **PILOT-ACTIVATION BLOCKER under owner decision U-4 (still open).** This change gives only `tw4_rfl_pilot_cover` (the per-period approval) structured evidence. `tw4_spend_authorize(..., 'pilot', ...)`
> and the pilot reservation paths that call it (and `tw4_pilot_exception_create`) still accept a bare approval reference of 10+ characters with no dated evidence. Until they carry the same evidence, or
> are proven unreachable for the pilot, a pilot approval can be created without the U-4 evidence by a platform administrator calling those paths. No code change is made here; the completion tracker should list it.

Validation state (real database, dedicated container, fresh scratch DB per suite, serial; migration chain 1208..1227 then 1229): on the review-hardened code (head 0aa88bd6) the new suite `localStack.tw4rflevid` passed 60/60 (including the apply-precondition and rollback-fingerprint scenarios and the stricter document/date refusals);
`tw4rflops` 64/64, `tw4rfld5` 21/21, `r2brfl` 28/28, `f4recovery` 26/26 passed; `tw4rfl` 86/87, `j4activation` 9/10, `f1funding` 24/25. Fingerprint chain: before 1229 = after rollback (4-argument body md5
`00e9bff4d2ce4e0cca135317216541fb`); after apply the 11-argument body md5 is `deffc1b878778dced134334260d62512`; re-apply identical. Manual rollback refusals verified: evidence present, a reference over 120 present, a redefined 11-argument body.
The three failures also occur on plain main without 1229: in the `tw4rfl` rollback test the schema-only copy keeps `public.tw4_rfl_cancel_target(p_operation_id uuid, p_actor uuid)` (created by 20261224090000, which the test does not roll back);
`get_studio_sms_texting_status` from 20261222 in `j4activation` 3c; and the known F1 "old act_* order deadlocks" case. None is attributable to this change.

## 1. Approval reference length: one limit, 10 to 200, in every layer

The problem: the pilot form and `rflPilotCoverAction` accepted 10 to 200 characters, but `tw4_rfl_pilot_cover` registers the reference through `tw4_spend_authorize`, which inserts it
into `studio_sms_spend_events.approval_ref`, whose column check (`20261121090000`) was `char_length(btrim(approval_ref)) between 3 and 120`. A 121 to 200 character reference therefore
failed with a raw check violation. The other approval tables already use 10 to 200 (`20261122` pilot exceptions, `20261128`, `20261208`); `studio_sms_approval_refs` allows a normalized
reference of 3 to 2000 characters, so it is not a constraint.

Decision: **widen the table check's upper bound to 200 and keep its floor at 3**, and enforce the 10 character minimum in the RPC, the server action and the form.

* Widening only the upper bound can never invalidate an existing row (every row that satisfied 3..120 satisfies 3..200), so the migration needs no data precheck and cannot fail on any database.
* Keeping the floor at 3 avoids a narrowing at the table (raising it to 10 would need a "no row shorter than 10" precheck and could refuse to apply on a database that has such a row).
  The 10 character minimum is already enforced where it matters: `tw4_spend_authorize` refuses a pilot-funded authorization under 10 characters, and the new function refuses it first.
* Narrowing the form and action to 120 was rejected: it contradicts the 10 to 200 convention of the other approval tables and would silently shorten a legitimate reference.
* Dependencies on the 3..120 bound were checked: the unique index `studio_sms_spend_events_one_approval` (`lower(btrim(approval_ref))`), the append-only guard on spend events, the approval-reference
  registry (`_tw4fi_register`, `ref_norm` 3..2000) and `tw4_approval_ref_trace` do not depend on the upper bound. No function or trigger reads the number 120.
* Mechanics: the live constraint is discovered by its definition (never guessed), required to be exactly the 3..120 shape (or already wider), a new named check
  `studio_sms_spend_events_approval_ref_len` (3..200) is added, then the old one is dropped. The rollback re-adds the original 3..120 check and **refuses** while a reference longer than 120 exists.
* RPC refusal: `tw4_rfl_pilot_cover` refuses a trimmed reference shorter than 10 or longer than 200 with errcode `22023` and the message "the written approval reference must be 10 to 200 characters",
  before any lock or write. The server action refuses the same range before any client or RPC. The shared TS constants are `APPROVAL_REF_MIN` and `APPROVAL_REF_MAX` in
  `src/lib/sms/pilotApprovalEvidence.ts`, used by the form (`minLength`/`maxLength`), the action and the tests. Length is counted in characters (code points), as `char_length` does.

## 2. U-4: structured evidence recorded with the cover

Owner decision: an approval reference points to a dated, explicit written owner authorization. The reference alone is not authorization.

`tw4_rfl_pilot_cover` now takes eleven arguments: the original four plus the date of the authorization (`p_authorized_on date`), the authorizing role (`p_authorized_by_role`), the scope
(`p_scope`), the amount in cents (`p_amount_cents`), the authorized period (`p_evidence_period_key`), a document reference (`p_document_ref`) and the sha256 of the retained text
(`p_document_sha256`). None has a default, so none can be omitted.

| Field | Rule (database; the action repeats the shape rules) |
| --- | --- |
| date | present, **not later than the UTC date**, not older than **400 days** before the UTC date. (An earlier draft allowed one extra day for a business ahead of UTC; the pilot business is behind UTC so its local date never exceeds the UTC date, and a business ahead of UTC dates the authorization by the UTC date.) |
| role | `founder_written` or `owner_written` (the vocabulary of the cancel path) |
| scope | `pilot_period_cover` (the table check allows only this value today; a new scope needs a migration) |
| amount | must EQUAL the active published price of the fee being covered (the lookup the function already used); otherwise `TW008` |
| period | must equal the period being covered |
| document reference | an opaque id (6 to 120 of letters, digits and `. _ / # + -`; no `:` and no `=`, so a `javascript:`-style string cannot pass) or a plain `https://` link whose host/path use only letters, digits and `. _ ~ ! $ ' ( ) * + , : @ / -` (no query string, fragment, credentials, `;`, `&`, `=` or `%`); at most 500 characters. The link is stored **permanently**: it must not be a share or access link and must not contain a person's name; prefer an internal document id. |
| sha256 | 64 hex characters: the SHA-256 of the **exact bytes of the retained file**. The action lower-cases the input (PowerShell `Get-FileHash` prints upper case) before validating; the database stores and checks lower case. |

The 400 day bound is a sanity bound, not a policy: it stops a years-old document from being presented as the authorization for this month, while still allowing an owner letter to cover several
upcoming periods. It is one constant in SQL (`v_today - 400`) and in TS (`EVIDENCE_MAX_AGE_DAYS`).

**Hash and reference, never the text.** The retained authorization text may hold personal data (names, contact details, studio finances). Storing a sha256 plus a document id/link makes the cover
auditable (an auditor with the retained document can recompute the hash and match it to the evidence row) without DanceFlow becoming a second copy of the text. Links with query strings or
credentials are refused because they could carry a token. The form says so, and the table has no free-text column (the suite lists its exact columns).

Storage: new table `studio_sms_provider_cover_evidence`, `cover_id` unique (1:1 with the cover) plus resource, business, location and period, `recorded_by`, `recorded_at`. RLS on, all privileges revoked
from every API role including `service_role` (the security-definer function is the only writer). It has its **own** append-only trigger (`_tw4rfl_evid_guard`): update and delete are always refused, truncate
is refused (`_tw4c_truncate_guard`), and an insert is accepted only under the `tw4.rflevid_write` flag, only for a `pilot_approval` cover, and only if resource, business, location, period and recorder match
that cover. The shared `_tw4rfl_guard` body is **not replaced** (attaching evidence to its `else` branch would have been wrong, and replacing it needs a new fingerprint chain).
Audit: the existing `rfl_cover_recorded` audit row now names the evidence id, role, authorization date and the first 12 hex of the hash (the audit action vocabulary is unchanged).

Everything else in the 20261225 body is kept: current or next period only (`TW042`), no retroactive approval, platform administrator only (`42501`), hold or negative balance (`TW007`), the $150
cumulative ceiling (`TW007`), one reference per use (`TW019`), D5 supersede semantics (`TW043`), the `tw4.rfl_write` flag pattern and the lock order (`_tw4rfl_lock`: legal business row, then credit
account, then the resource row, then `tw4_spend_authorize`). The function did not take the location-link `_tw4sr_lock` before this change either, so none was added. No two-admin control was added.
A replay (same reference, same actor, same evidence) returns the same cover and evidence; the same reference with different evidence is refused with `TW019`.

### Refusal codes

`22023` invalid input or a reference outside 10 to 200; `TW052` (new) approval evidence missing, malformed or inconsistent (date, role, scope, amount absent, period, document, sha256);
`TW008` the amount differs from the published price (existing code: "the amount must equal the published price"); `TW019` reference reused or replayed with different evidence; `TW007` ceiling, hold or
negative balance; `TW041` resource not a live fee resource; `TW042` not the pilot business or period outside current/next; `TW043` period already covered; `42501` not a platform administrator.
`TW052` is the only new code (the highest in use was `TW051`). The action maps it to a fixed sentence and never echoes database text.

### Replaced and dropped functions

* `public.tw4_rfl_pilot_cover(uuid,text,text,uuid)`: fingerprint-prechecked (md5 `00e9bff4d2ce4e0cca135317216541fb`, the 20261225 body, the latest definition on main) and **dropped** in this migration, so no evidence-free overload is callable.
* `public.tw4_rfl_pilot_cover(uuid,text,text,uuid,date,text,text,integer,text,text,text)`: the new function above. Grants: revoked from public, anon, authenticated; executable by `service_role` only (same as the original).
* `public._tw4rfl_evid_guard()`: new, private (no role can execute it).
* Rollback: refuses while any evidence row exists (evidence is permanent), while any reference longer than 120 exists, or when the live eleven-argument body is not exactly the one 20261229 created
  (md5 `deffc1b878778dced134334260d62512`: a later migration that redefined it must be rolled back first); otherwise drops the new function and table, restores the 3..120 check and recreates the
  20261225 four-argument function byte for byte, then re-checks the fingerprint.
* Apply precondition (review P2-1): the migration **refuses to apply** while a live `pilot_approval` cover (not superseded) exists, because such a cover was recorded through the four-argument function,
  has no evidence row and would keep counting as funding without it. The message tells the operator to handle those covers first (the supersede path only applies to `initial_reservation` covers, so a
  live approval cannot be superseded by this migration) or to apply 20261229 before any pilot use. The cover table is locked (share row exclusive) for the check, so none can appear in between.
  The cover table is not applied on hosted DEV or PROD yet (2026-10-24 probe: PROD at or below 20261119, DEV about 20261122), so this is a guard, not an expected stop. Apply in a quiet window and retry if the lock
  times out: the migration takes the cover table lock first and later needs `spend_events`, so a concurrent four-argument cover call could deadlock with it; either the deadlock detector or the 5-second lock
  timeout aborts the whole transaction safely.

### Other pilot spend approvals (follow-up, not done)

`tw4_pilot_exception_create` (the $150 exception itself) and the other pilot-funded authorizations go through `tw4_spend_authorize` directly, not through `tw4_rfl_pilot_cover`. Sharing the evidence there is not
trivial (different amounts, no period, a different table), so it is a follow-up. The reusable parts are the evidence table shape and the shared TS validator.

## 3. Callers of `tw4_rfl_pilot_cover` and of `tw4_spend_authorize` for pilot covers (on main fc507ee1)

| Caller | Action |
| --- | --- |
| `src/app/platform/sms/recurringFeeActions.ts` (`rflPilotCoverAction`) | updated: validates, then calls the store with evidence |
| `src/lib/sms/providerFeeLifecycle.ts` (`pilotCover`) | updated: eleven-argument call |
| `src/app/platform/sms/RecurringFeesPilot.tsx` | updated: form collects the evidence |
| `src/app/platform/sms/__tests__/recurringFeeActions.tw4rflui.test.ts` | call sites and the one exact-args assertion updated (every other assertion kept) |
| `localStack.tw4rfl.test.ts`, `tw4rfld5`, `tw4rflops`, `f1funding`, `f4recovery`, `j4activation` (real-schema suites) | call sites go through `rflEvidenceHelper.pilotCoverArgs` (valid evidence built per resource; falls back to the four-argument form on a database without 20261229); signature-sensitive privilege lists and the `tw4rflops` body-fingerprint check made aware of the new body; no assertion removed |
| `20261225090000_twilio_rfl_d5_cover.sql` and its rollback | historical; the rollback of this migration restores the exact 20261225 body |
| `20261219`, `20261221`, `20261226` (F1 `_tw4act_*`, admin recovery, console gates) | comments only; none calls the function (verified by grep) |
| `20261209` | original definition; replaced by 20261225 and now by 20261229 |
| docs (`TW-4F_Recurring_Fee_Lifecycle_*`, `TW-4F_RFL_D5_Cover_Fix.md`, `TW-4F_Hosted_Apply_Manifest.md`, `TW-4F_Completion_Tracker.md`) | name the function in prose; not edited here (the manifest needs a row for 20261229 when this merges) |

No caller was left calling the old shape. The `tw4_prov_observe` slice (`20261228`) was checked: no remote branch (`git for-each-ref refs/remotes/origin`) or local worktree under `C:\Dev` carries a `202612(28|29)` migration yet, so
whether that slice calls `tw4_rfl_pilot_cover` could not be determined from Git. The remote branches whose diff against main mentions the function are the older RFL/F1/F4/J4 source branches whose
call sites are already on main (listed above); I did not find an open PR for a KI-1 slice.

## 4. Tests

Non-database (run): `src/lib/sms/__tests__/pilotApprovalEvidence.rflevid.test.ts` (shared validator, date window, dollars to cents, document patterns),
`src/lib/sms/__tests__/rflPilotEvidenceMigrationShape.rflevid.test.ts` (single transaction, fingerprint precheck, old signature dropped, no API grants, shared guard untouched, rollback exact and refusing),
`src/app/platform/sms/__tests__/recurringFeeActions.rflevid.test.ts` (form min/max and fields, action refuses 9 and 201 before any RPC and accepts 10/120/121/200, every evidence refusal before any RPC,
a client amount is ignored, database refusal text is never echoed).

Real schema: `src/lib/sms/twilioIsv/__tests__/localStack.tw4rflevid.test.ts` (reference boundaries 9/10/120/121/200/201, every refusal, happy path with evidence row and audit,
replay, TW019, ceiling, current/next only, hold/negative, admin only, old signature gone, append-only evidence, no text stored, races, D5 supersede with evidence), plus the updated existing suites listed above.
Run serially against a dedicated Postgres with migrations through 20261229090000 and the local-QA marker table. Results of the last window are in the status block at the top. The hardening scenarios (the apply precondition on a schema-only scratch copy, the rollback-fingerprint refusal, and the stricter document-id/link and date refusals) are included in the 60/60
evidence-suite result on 0aa88bd6.

## 5. Residual risks and follow-ups

* The review-hardening changes (P2-1 precondition, rollback body fingerprint, document id/link and date tightening, upper-case sha input) were verified on a real database (evidence suite 60/60, the fingerprint/rollback chain and the other suites; see the status block at the top). Nothing from that list is outstanding.
* Possible later guard (review P3-4): the same `document_sha256` recorded with a different `authorized_on` or role is not refused today; a future constraint could require one document hash to carry one date and role.
* Files owned by others that need a follow-up for 20261229 (not edited here): `docs/twilio/TW-4F_Hosted_Apply_Manifest.md` (a row for 20261229090000: new table, replaced function `tw4_rfl_pilot_cover` with md5 prechecks `00e9bff4d2ce4e0cca135317216541fb` (predecessor) and `deffc1b878778dced134334260d62512` (new body), the widened spend-events check, the apply precondition and the rollback refusals), `docs/twilio/TW-4F_Completion_Tracker.md` (the U-4 pilot-activation blocker above), and the hosted probe scripts/queries (they should list the new table, the eleven-argument signature and the `studio_sms_spend_events_approval_ref_len` constraint).
* The form takes the amount in dollars and the action converts to cents; the operator can type a wrong amount and will be refused (`TW008`) with a generic sentence, because the overview does not carry the price.
  Showing the published price read-only needs a server read of the price list (follow-up).
* The evidence period in the action is the cover period; the database check against the cover's period is therefore a tautology for the UI but binding for any other caller.
* Pilot exception creation and other pilot approvals do not yet carry evidence (see above).
* Hosted manifest row for 20261229 is not added here.
