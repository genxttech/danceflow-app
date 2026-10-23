# TW-4F RFL: D5 pilot-reservation cover month rule and supersede path

Migration `20261225090000_twilio_rfl_d5_cover.sql` (rollback in `rollback/`). Git-only: not applied to any hosted database, no Twilio / Stripe / SMS.
Requires 20261209 .. 20261217. Decision D5 (see `TW-4F_R2b_RFL_Integration.md` section 5): a resource's own pilot reservation is the REGISTRATION period's cover
only while it is reserved/captured AND made in the registration month; otherwise the resource registers with no cover and the period needs its own written approval.

## Problems fixed

1. `_tw4rfl_register_core` bound `p_initial_reservation` with no month check, so the administrator path could bind a cross-month reservation.
2. `tw4_rfl_pilot_cover` raised TW043 whenever any cover row existed for (resource, period), so a period whose bound reservation no longer counted could never
   receive its written approval (unique `studio_sms_provider_cover_period`).
3. `_tw4rfl_cover` (and so `tw4_rfl_studio_ready`, the gate, the scan, the exposure report) still treated such a row as coverage.

## What changed

| Function | Change |
|---|---|
| `_tw4rfl_register_core` | A reservation whose month (`_tw4ml_month_key(entity, cr.created_at)`) differs from the registration month is NOT bound. The resource still registers (refusing would leave a provider resource out of the inventory). Audit rows: `rfl_registered` (`initial_cover=false`) and `rfl_initial_cover_skipped` (period, reason, reservation). The result gains `initial_cover_skipped: month_mismatch` only in that case. All earlier refusals (TW040 ownership/fee/status, pilot only) are unchanged. |
| `tw4_rfl_pilot_cover` | The live cover for (resource, period) is looked up (`superseded_at is null`). A replay by the same approval and actor still replays. An `initial_reservation` cover whose reservation is not reserved/captured, or whose month differs from the period, is SUPERSEDED by the written approval; any other existing cover (a counting reservation cover, any `pilot_approval`) still raises TW043. The supersede mark is written only after every funding check (hold/negative TW007, price TW008, ceiling TW007, single-use approval reference) has passed, in the same transaction as the new approval, so a refusal leaves the old row untouched. Admin-only, current/next period only, `tw4.rfl_write` pattern and the lock order (`_tw4c_admin`, `_tw4rfl_lock` business then credit account, resource `for update`) are unchanged. |
| `_tw4rfl_cover` | Counts a cover only when it is live (not superseded), its reservation is reserved/captured and, for `initial_reservation`, its reservation month equals the cover's period. The returned `covered:<basis>` label reads the live row only. |
| `_tw4rfl_guard` (the 20261211 body) | Cover rows stay permanent; the one allowed UPDATE is the one-time supersede mark on an `initial_reservation` row, under `tw4.rfl_write`, changing nothing else (compared as jsonb minus the four supersede columns). DELETE is still refused. |

Schema (additive): `superseded_at`, `superseded_by`, `superseded_reason` (`reservation_month_differs` | `reservation_not_counting`), `superseded_by_cover_id` on
`studio_sms_provider_cover`; an all-or-none check (and only `initial_reservation` rows may be marked); the table constraint `studio_sms_provider_cover_period` is replaced by
the partial unique index `studio_sms_provider_cover_period_live (resource_id, period_key) where superseded_at is null`. `studio_sms_provider_cover_reservation` (one reservation
covers one resource once) is untouched, so the old row keeps its reservation and history. Grants are unchanged (`create or replace` keeps them; the migration issues none).

## Readers of cover rows reviewed

`studio_sms_provider_cover` is read by: `_tw4rfl_cover` (changed), `tw4_rfl_pilot_cover` (changed), `_tw4rfl_register_core` (changed, insert only). Everything else
(`tw4_rfl_studio_ready`, `rfl_ready` in the R2b readiness list, `_tw4rfl_gate_suspended`, `_tw4rc_service_state`, `tw4_rfl_scan_entity`, `tw4_rfl_exposure_dispose`,
`tw4_rfl_exposure_report` / admin overview / owner overview) reads cover only through `_tw4rfl_cover` or not at all (grep of the migration chain: no other function touches the table), so they follow the new rule without being edited. Exposure for a non-counting
period opens as before after the grace; the written approval closes it (`covered_by_pilot_approval`).

## Month key: `cr.created_at` everywhere (R2b's `started_at` helper)

The RFL rule keys on the reservation's own `cr.created_at`, the same predicate F1 (`_tw4act_pilot_funding`, PR 280) and F4 use:
`pc.basis = 'pilot_approval' or month_key(entity, cr.created_at) = pc.period_key`. R2b's `_tw4num_ledger_reservation` is NOT edited; it keys the month on the purchase
operation's `started_at` and only decides which reservation the ledger path PASSES to registration. The two are consistent because the RFL core then applies its own
check, so the ledger helper can only narrow, never widen:

* operation `started_at` in the current month, reservation `created_at` in another month (a straddle): the ledger helper returns the reservation, the core sees the
  month mismatch and registers WITHOUT cover (audited); the period needs a written approval. Covered by a real-schema test.
* operation from an earlier month: the ledger helper returns null, nothing is passed, nothing binds (same outcome).
* in the normal flow the reservation is created with the operation, so the two timestamps are within moments of each other and agree except exactly at a month boundary,
  where the reservation's own timestamp (the money's month) is the authoritative one.

An old-rule row that already binds a cross-month reservation (none are known on any hosted database: nothing is applied there) simply stops counting and is
superseded by the written approval.

## Residual notes

* The superseded cross-month reservation can still be `captured`: its money stays held and counts toward the cumulative $150 ceiling (never replenished automatically); the new approval needs ceiling headroom (TW007 otherwise). This is the intended D4 behaviour.
* F1 (`_tw4act_pilot_funding`) reads cover rows directly with the same month predicate and does not filter `superseded_at`; a superseded row is by definition non-counting under that same predicate (released or cross-month), so F1's verdict is identical. A later F1 edit may add `superseded_at is null` for clarity.
* The rollback refuses while any superseded row exists (permanent evidence; the restored constraint could not hold both rows) and restores the four bodies byte for byte (fingerprint-verified); registrations made without cover while the migration was live stay valid rows.

## Verification status

Static shape test (`src/lib/sms/__tests__/rflD5CoverMigrationShape.tw4rfld5.test.ts`) runs without a database. The real-schema suite
`localStack.tw4rfld5.test.ts`, the unchanged `localStack.tw4rfl.test.ts` (87), `localStack.tw4rflops.test.ts` (64), `localStack.r2brfl.test.ts`, the migration apply /
rollback / re-apply fingerprint check and the F1 `f1funding` scenario were authored or planned but NOT RUN: they wait for a database slot.
