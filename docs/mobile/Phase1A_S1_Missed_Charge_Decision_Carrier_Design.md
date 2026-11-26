# Missed-charge decision carrier for private-lesson no-shows (migration design, NOT applied)

Status: design only. No migration file, no hosted SQL. Applying it is an owner gate (`sb.sh dev-apply` for DEV, `prod-apply` only with the owner's explicit approval of the file's SHA-256). Context: PR #728 stores the "charge decision" of a no-show in the single activity note (text), which is mutable and invisible to instructors. This note designs the safer carrier.

## The problem to solve

A no-show on a private lesson records a status (`no_show`) and a charge decision (none / package credit / membership benefit). The status is a column; the decision is not. Today the lib recovers it from (a) the deduction marker (`lesson_transactions`) or membership usage row when a charge was applied, and (b) the note text when it was not. That text:
- can be rewritten by any active studio role through a direct API call (UPDATE policy on `client_activity_notes`), not by the web UI and not deleted by staff;
- cannot be written or read by instructors (their `clients` visibility is hidden by RLS, so the insert policy's client check fails);
- needs a "no note = allowed" exception for the crash window between the status UPDATE and the note INSERT.

## Option A (recommended): `appointments.missed_charge_decision`

```sql
alter table public.appointments
  add column missed_charge_decision text
  check (missed_charge_decision in ('none', 'package', 'membership'));
```

- **Written in the same UPDATE as `status = 'no_show'`** (the lib already does one UPDATE with `.select("id")`; it adds the column to the payload). No crash window: the decision exists exactly when the status does.
- **Meaning:** the decision the staff member REQUESTED. Whether it was applied is still the deduction marker / usage row (single source of truth for money). So `package` + no marker = requested, not applied (retryable); `none` = decided no charge.
- **Immutability trigger** (`BEFORE UPDATE`, security definer not needed): once set, the value may change only if (1) old value is `package` or `membership` and (2) no deduction marker (`lesson_transactions` for the appointment with a deduction type) and no `client_membership_usage` row exists for it; otherwise raise. `none` is final. It may never be set while status is not `no_show`, and is not cleared when status stays `no_show`. This reproduces the rules agreed in #728: only a change away from an applied decision conflicts; a failed charge can be retried or changed.
- **Visibility:** the column is on the appointment row, which the assigned instructor can already read and update. No dependence on `clients` or notes, so instructors get the same retry/conflict behaviour as front desk and the `notesVisible` special case is deleted.
- **Tamper:** staff can still UPDATE `appointments` through RLS, but the trigger refuses every change that would move away from `none` or an applied charge, and a rewrite of a failed request is no escalation (they can request the charge anyway). The note becomes audit text only; nothing reads it.

### Lib changes (after the migration is applied everywhere)
- `markNoShow`: payload `{ status: "no_show", missed_charge_decision: kind, updated_at }`; replay reads `missed_charge_decision` (already in the row it loads) instead of the note: applied marker → only that kind repeats; `none` → a charge is `outcome_conflict`; `package|membership` with no marker → retry or change; **null on a `no_show` row (legacy / backfill gap) → fail safe: a charge is `outcome_conflict`**, `none` is a no-op.
- The note is still written (audit trail) but is no longer consulted; `noShowNote`, `NOT_APPLIED_TEXT` parsing and `notesVisible` are removed.
- Web: no UI change. The two web actions call the same lib, so the web no-show also records the decision (today the web action's charge choice lives only in the note text).
- Deploy order: **SQL before app** (the lib selects the column; an app without the column would fail the appointment read). Until applied everywhere, #728's note logic stays.

### Backfill of already-recorded no-shows
Derive only what is provable, never guess a "none":
```sql
update public.appointments a set missed_charge_decision = 'package'
 where a.status = 'no_show' and a.missed_charge_decision is null
   and exists (select 1 from public.lesson_transactions t where t.appointment_id = a.id
               and t.transaction_type::text in ('lesson_deduction','appointment_attendance'));
update public.appointments a set missed_charge_decision = 'membership'
 where a.status = 'no_show' and a.missed_charge_decision is null
   and exists (select 1 from public.client_membership_usage u where u.reference_type = 'appointment' and u.reference_id = a.id);
```
All other historical no-shows stay NULL (unknown), which the lib treats as fail-safe (a charge on them is refused; they can still be charged through the existing web tools). Run the backfill before the immutability trigger is created, or with the trigger disabled for the statement, and report counts (set / left null) in the preflight.

### Rollback
`drop trigger ... ; drop function ...; alter table public.appointments drop column missed_charge_decision;` The app falls back to the #728 note logic only if redeployed; roll the app back first, then the SQL (the lib selects the column).

### SQL tests (to write with the migration; `sql-tests/`)
1. column accepts only none/package/membership; null allowed; set on a `no_show` row.
2. immutability: `none` -> anything raises; `package` -> `none`/`membership` allowed with no marker; `package` -> anything raises once a deduction marker exists; membership likewise with a usage row.
3. cannot be set to a non-null value while status is not `no_show`; changing status away from `no_show` is already blocked by P6e for private lessons.
4. backfill derivation: marker -> package, usage row -> membership, otherwise null; counts reported.
5. instructor session can read and (via the lib's UPDATE) write the column on their own appointment and not on a colleague's.
6. no-regression: P6e lifecycle trigger and the deduct trigger unchanged.
7. concurrency: two concurrent no-show UPDATEs with different decisions: one wins, the other raises or sees the winner (the lib re-reads).

## Option B: zero-delta ledger row

Insert a `lesson_transactions` row (`lessons_delta = 0`) per decision. Pros: ledger rows are not editable by the studio UI and already sit next to the deduction marker. Cons: `transaction_type` is an enum, so a new value (`missed_charge_decision`) needs `ALTER TYPE ... ADD VALUE` (not usable in the same transaction, awkward rollback: values cannot be dropped); the table is package-scoped (`client_package_id`, `client_package_item_id`), so `none` and `membership` decisions have no package to hang on; every ledger reader (statements, reconciliations, refund reconciliation, reports) would have to learn to ignore zero-delta rows; an INSERT policy already lets studio staff insert ledger rows, so it is no more tamper-proof than a column with a trigger. Rejected.

## Comparison

| | A: column + trigger | B: zero-delta ledger | Today: note text |
| --- | --- | --- | --- |
| Written atomically with the status | yes (same UPDATE) | no (second insert) | no (second insert) |
| Instructor can read/write | yes | needs a package | no |
| Tamper path | trigger blocks unsafe moves | insert policy open | UPDATE open |
| Migration cost | 1 column + 1 trigger, trivial rollback | enum value (irreversible) + readers | none |
| Parsing | none | none | text match |
| Fail-safe for unknown | NULL = conflict | absent = ? | absent = allowed |

## Decisions for the owner
1. Approve Option A (separate migration PR with rollback and the SQL tests above; DEV apply first, PROD only on explicit approval of the file hash).
2. Confirm "NULL on a historical no-show = a charge is refused" (they stay chargeable through the existing web balance tools).
3. Confirm the web no-show should record the decision too (same lib), which changes nothing visible.

## Revision after owner decision P8 (2026-11-26): an immutable decision RECORD (recommended over the column; NOT applied)

P8 asks for an immutable charge-decision record, that unknown historical no-shows are never presumed chargeable, and equal web behaviour. The column of Option A can be rewritten (the trigger only limits how). An append-only table keeps every decision and cannot be rewritten at all.

```sql
create table public.appointment_charge_decisions (
  id             bigint generated always as identity primary key,
  studio_id      uuid not null references public.studios(id),
  appointment_id uuid not null references public.appointments(id),
  decision       text not null check (decision in ('none', 'package', 'membership')),
  decided_by     uuid not null default auth.uid(),
  decided_at     timestamptz not null default now()
);
create index on public.appointment_charge_decisions (appointment_id, id desc);
alter table public.appointment_charge_decisions enable row level security;
revoke all on public.appointment_charge_decisions from public, anon, authenticated, service_role;
grant select on public.appointment_charge_decisions to authenticated;
```

- **Writes only through one function** `record_no_show_decision(p_appointment_id uuid, p_decision text)` (`security definer`, `search_path` pinned, execute granted to `authenticated` only). In one transaction it locks the appointment row (`for update`), checks the caller's authority (broad studio staff, or the assigned instructor), sets `status = 'no_show'` if still open, and inserts the record. It refuses: a second decision after `none`; any decision once a deduction marker or usage row exists unless it repeats the applied kind; and **any charge decision for a lesson that is already `no_show` without a record** (unknown stays unknown). No `update` or `delete` privilege exists for any application role, and a trigger raises on `update`/`delete` so a later grant mistake cannot silently open it.
- **Reading:** `select` policy for active members of the studio, so the assigned instructor sees the record too (no dependence on `clients` or notes).
- **Latest record wins**; the money truth stays the deduction marker / usage row.
- **No backfill of decisions.** Historical no-shows get no record: they are unknown and never chargeable through the app or the web no-show action; the web balance tools remain for a deliberate manual charge.
- **Web parity:** the two web actions call the same lib, which calls the same function.
- **Rollback:** drop the function, trigger and table (app first: it calls the function). The note text stays as the audit trail throughout.
- **SQL tests:** insert-only grants (anon, authenticated, service_role cannot insert/update/delete directly); every refusal above; instructor own/colleague; tenancy; two concurrent decisions serialise on the row lock; unknown historical no-show refuses both charges; `none` is final.
- **Order:** SQL before app. Until applied, the app-level rule shipped with this revision (no recorded decision = no charge) enforces the same policy from the note.
