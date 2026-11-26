# Pulse O4: which role sees which card (recommendation only)

Status: a written recommendation for the owner. Nothing here changes behaviour. The matrix in force is `pulseCardAccess` in `src/lib/staff/pulseCards.ts` (server-side; the app only draws what the server returns).

## What ships today

| Card | Owner / admin | Front desk | Instructor | Independent instructor, organizer roles, platform admin |
|---|---|---|---|---|
| Lesson requests | all, with names | all, with names | only requests assigned to them, no names | refused (403) |
| New leads | yes | yes | no | refused |
| ARIA suggestions | yes | **no** | no | refused |
| Worth a look (cancellations; packages running low) | all | all | own cancellations only, no package count | refused |
| Studio health | studio | studio | own sessions | refused |

The last column is refused in two layers: the route and the staff auth guard stop those roles first (platform admin in `requireStaffApi`: `platform_admin_unsupported` / `not_a_member`; independent instructor and the organizer roles in the route's `canViewStudioSchedule` check, 403), and `pulseCardAccess` returning all-null for any unlisted role is the second, fail-closed layer.

## How it compares with the web app (the source of truth for what a role may already see)
- **Leads:** the web Leads page is gated by `canViewClients`, with a comment that leads are CRM data, not teaching data, so an instructor must not see them. Pulse matches: no leads for instructors.
- **ARIA:** the web ARIA page is gated by `canViewReports`, which **includes front desk** (and platform admin, organizer owner/admin, none of which can reach the Pulse route, so front desk is the only real difference). Pulse is stricter: front desk gets no ARIA card. This is the one place Pulse and the web differ on purpose; it is the actual O4 question.
- **Packages running low:** package balances are client commercial data; the web shows them to front desk. Instructors do not get the count in Pulse; the web shows an instructor their own client's package on the client screen only.

## Recommendation
1. **Keep the matrix as shipped for the first release (front desk without ARIA).** Reasons: the card lists ARIA suggestions that are written to be sent to clients (outreach wording, discounts, follow-ups); a front-desk user cannot approve them from the app anyway (approvals are not in the app), so the card would show items the person cannot act on and invite "why can't I?" questions; and it can be widened later by changing one function with no migration, but cannot be narrowed after staff have seen it without a visible loss.
2. **Revisit when ARIA actions arrive (Phase D).** At that point decide per action whether front desk may approve; the card should then follow the action permission, not the page permission.
3. **Make the difference explicit in the product copy**: the owner should know the app is intentionally one step narrower than the web for front desk. If the owner prefers parity with the web instead, the change is `aria: true` for `front_desk` in `pulseCardAccess` plus its tests (the front-desk case in `pulseCards.test.ts` and `staffApiPulseCards.test.ts`) and the contract's role table.
4. **Statuses**: Pulse counts only `pending` booking requests; the web dashboard also counts `new` and `in_review`. The schema's check constraint only allows pending, approved, declined and cancelled, so the extra values never occur today; if a studio's data ever holds them, Pulse would undercount. Instructor public-booking requests show as counts and timestamps without names (a per-row view the web does not give instructors, acceptable and stricter).
5. **Instructor scope**: keep own-scope requests/health and no client names. One known limit worth accepting: an instructor's own cancel requests are not shown when the cancellation row carries no `instructor_id` (only book/reschedule requests carry it).
6. **No new roles are served by default**: any role not listed (including roles added later) gets all-null cards. Keep that fail-closed behaviour.

## Decision needed from the owner
Front desk and ARIA: keep hidden (recommended for now) or match the web page gate.
