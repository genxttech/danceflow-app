# D24 M2-B — authorized operator actions

Status: **merge candidate only, dark.** Migration `20270205090000_d24_operator_actions.sql` is **not applied** to any environment; server actions answer `disabled` unless `D24_OPERATOR_ACTIONS=enabled` (unset everywhere). No UI is wired. Every hosted step needs its own owner authorization.
Rollback: `rollback/20270205090000_d24_operator_actions_rollback.sql` (refuses while operator evidence exists). Local proof: `bash scripts/qa/d24-m2b-sql.sh` (disposable Postgres) and `src/lib/payments/hostedInvoice/__tests__/operator.d24m2b.test.ts`.

## What changed relative to M1
M1 left `d24_acknowledge_anomalies(invoice, codes, p_actor, reason)` trusting its `p_actor` argument. It is now revoked from `public, anon, authenticated, service_role` (nothing in the app ever called it). Replacement functions never accept an actor.

## Security model
| Property | How |
|---|---|
| Actor | `auth.uid()` read inside the function from the caller's own JWT. No actor / user / studio parameter exists (asserted in SQL tests and vitest). |
| Authentication | `service_role`, `anon` and token-less calls have no `auth.uid()` / `role = 'authenticated'` → refused (`d24_op_authentication_required`). Functions are also not executable by those roles. |
| AAL2 | `auth.jwt() ->> 'aal'` must equal `aal2` **in SQL**, for every operator function including reads. App side repeats it with verified `auth.getClaims()` + `evaluateAssurance(...,"aal2")` (TOTP in `amr`, same subject, unexpired). |
| Role / tenant | `profiles.platform_role = 'platform_admin'`, or an **active** `user_studio_roles` row with `studio_owner` / `studio_admin` for the invoice's studio. Cross-tenant and missing invoices both raise `d24_invoice_not_found` (no existence oracle). |
| Reason | Mandatory, trimmed, 10–1000 chars, enforced in SQL (and table CHECKs). |
| Evidence | Append-only, writer-flag-guarded: acknowledgements → `hosted_invoice_recon_audit`; dismissals → `hosted_invoice_dismissals` (+ audit row, new trigger kind `dismissal`); requeues → `hosted_invoice_deferred_requeues`. Nothing is deleted or edited; the invoice, its facts and its codes are never changed by dismissal. |
| Concurrency | Row `FOR UPDATE` on the invoice / deferred event; unique `(invoice_row_id, events_seen)` for dismissals. Replays return `already_*` and write no second evidence row. |
| Grants | New operator functions: `authenticated` only. Helpers `_d24_op_*`: nobody. New tables: RLS on, no policies, `service_role` SELECT only. Reads go through definer functions that scope the result to the caller. |
| Application | Server actions use the caller's user-scoped client (never the admin client); inputs allow-listed; DB errors mapped to stable codes, no text returned. |

## Capabilities (default policy, as implemented)
| Action | Who | Notes |
|---|---|---|
| Acknowledge anomalies | platform_admin: any code on any registered invoice. studio_owner/studio_admin: **only** `unverified_void_origin`, `unverified_uncollectible_origin`, only on own studio's invoices | Never attributes, never erases a code; unmatched invoices cannot be acknowledged. |
| Dismiss unmatched invoice | platform_admin only | Hides it from the default review list only. State stays `unmatched`. **A new event on the invoice makes the dismissal stale and the invoice resurfaces** (dismissal records events seen). Registry adoption still works afterwards. |
| Requeue rejected deferred event | platform_admin only | `rejected → pending`, once per call, max 3 per event. Snapshot is immutable, so this helps only events rejected for reasons outside the event (transient, ordering, since-fixed defect). Applied events cannot be requeued. The next `d24_drain_deferred` applies it. |
| Review | list/get invoices: platform_admin (all) or studio operators (own studio, registered only, no event snapshots); deferred list + outcome counts: platform_admin | Pagination capped at 200. |

## Not in this PR (by design)
No UI, no scheduled drain (M2-C), no registration call site (M2-A), no authorization workflow that would turn `hosted_invoice_status_transitions.origin_state` into `verified`, no reversal of a dismissal other than the automatic staleness on a new event.

## Open policy decisions (owner)
- **D-1 Platform ack of tenant invoices.** Implemented: platform_admin may acknowledge any code on any studio's invoice (support case). Alternative: studios only. Easy to change in one condition.
- **D-2 Which codes a studio may acknowledge.** Implemented conservatively: only the two unverified-origin codes. Everything cross-tenant/replay/conflict (`metadata_mismatch`, `account_scope_mismatch`, `subscription_registry_conflict`, `livemode_*`, `replay_payload_mismatch`, `*_conflict`, `void_invoice_has_payments`, `paid_and_void_observed`, `payments_exceed_invoice_total`) needs platform_admin. Widening this is a policy call; it is not enabled here.
- **D-3 Studio MFA.** SQL requires `aal2` for studio owners/admins too. Studio accounts without an enrolled TOTP factor cannot use the studio acknowledge path at all, and there is no studio-side MFA challenge flow in this PR. Decide: enforce (needs a studio MFA enrolment/challenge UX before any UI), or restrict M2-B to platform_admin only.
- **D-4 Requeue cap and recency.** Cap of 3 per event is a placeholder. The TW-4F "recent TOTP (≤15 min)" tier is **not** used here; AAL2 only. Decide whether requeue/dismiss warrant the `recent` tier (SQL cannot see `amr` timestamps from `auth.jwt()` reliably; the app-side check could enforce it).
- **D-5 Dismissal reversibility.** No explicit "undismiss"; staleness-on-new-event is the only automatic resurfacing. Add an explicit append-only `reopen` record if wanted.
- **D-6 Dismissal reason taxonomy.** Free text now; a coded reason list would make reporting easier.

## Known limitations
- Requeued events keep `attempts`; an event that already used 5 attempts is rejected again on its first failure (and is drained after fresher events, because the drain orders by attempts).
- `d24_op_list_invoices` computes dismissal staleness per row (index on `hosted_invoice_source_events(invoice_row_id)` exists); fine for review-queue volumes, revisit if the table grows into the millions.
- SQL tests stub `auth.uid()/auth.jwt()` the way Supabase defines them; they do not run against Supabase GoTrue/PostgREST (no hosted or local Supabase stack was used).

## Independent review (static) — outcome
No critical/high findings. Fixed from the review: authorization now happens **before** the row lock in acknowledge (an unauthorized caller can no longer block on, or stall, the webhook path); `d24_op_get_invoice` uses explicit column lists and gives studio operators no actor ids, reasons, internal refs or dismissals. Accepted/documented: SQL checks `aal2` only (TOTP method and recency are app-side; see D-4); a second admin's identical dismissal returns `already_dismissed` without a second record (L3); after first use the DB rollback is refused — roll back **app-only** (clear `D24_OPERATOR_ACTIONS`) and leave the migration in place.
