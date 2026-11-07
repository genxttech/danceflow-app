# H1 - Platform-admin studio-support context requires verified AAL2

Status: draft PR, not merged. No SQL, no migration, no deployment.

## Finding
`enterStudioContextAction` required only the `platform_admin` role, and `getCurrentStudioContext` / `getStudioContextForStudio` granted
`isPlatformAdmin: true` (studio-owner-equivalent authority over any studio, used by 280+ files: payroll, manual payments, refunds, exports) from the role plus a support
cookie alone. An aal1 platform-admin session therefore held cross-studio authority. The `/platform` layout redirects aal1 to MFA, but a layout does not protect a server
action or a route handler.

## Rule (one definition)
Platform-admin authority over a studio exists only when the caller's **verified** session is aal2 with a TOTP method (`auth.getClaims()`: signature verified, subject equals the
user, not expired). Otherwise the user is resolved as an **ordinary user**: only their own memberships apply and the support cookie is ignored.

## Where it is enforced
| Boundary | Behaviour |
|---|---|
| `getCurrentStudioContext`, `getStudioContextForStudio` (`src/lib/auth/studio.ts`) | the authoritative gate for every action, route and page; `hasVerifiedAal2Session` (`platform-assurance.ts`) fails closed |
| `enterStudioContextAction` | `requirePlatformStepUp("aal2")` first; audit row written before the cookie; audit failure = no context; cookie max-age 8 h |
| `clearStudioContextAction` | allowed at any assurance (it only reduces privilege); exit audited best-effort |
| `/app` layout banner | uses the resolved context, not a second role read |

Ordinary studio owners/staff never reach the claims read (tested). An admin who also holds a real membership keeps that membership at aal1.

## Audit
`workspace_access_logs` rows with `route` = `platform_support:enter`, `platform_support:switch:from=<previous studio id>`, `platform_support:exit` (no schema change).

## Not changed (separate backlog, see Platform_Admin_Security_Backlog.md)
Database paths: RLS policies and SECURITY DEFINER functions that check `platform_role` without `aal2` are reachable with an aal1 token via PostgREST. They are inventoried,
not rewritten here. Fresh-MFA or time-boxing for individual financial mutations inside a support session is a recommendation, not implemented.

## Review follow-ups (independent review, round 1)
- The support cookie is now a signed token `v1.<studio>.<issuedAt>.<hmac>` bound to the admin's user id and limited to 8 hours, so a hand-set, stale or other-admin cookie resolves to nothing and the audited enter action is the only way to obtain a context.
- **Limitation, stated plainly:** this PR secures the studio-support context only. It does NOT make every platform-admin capability aal2-only. Platform server actions guarded by `requirePlatformAdmin()` alone (create platform admin, workspace-active, credential approve/reject/reset, portal repair, mobile push test, invites, expenses, sales, wave/ops actions), `api/platform/billing/price-config`, and RLS/SECURITY DEFINER paths remain as in the backlog.
- Not done here: exit rows for sign-out and cookie expiry; user agent / IP in audit rows; a distinct refusal reason for transient claims failures; per-request memoisation of the claims read.

## Review follow-up 2 (targeted cookie review)

- P2 fixed: `getStudioContextForStudio` no longer grants platform authority from a caller-supplied studio id. It now requires the verified, user-bound support cookie to name that studio (so an audited entry exists); otherwise the admin is treated as an ordinary user and, without a membership, sent to `/platform/studios`.
- P3 accepted: a copied cookie stays valid until its 8h expiry after exit (needs the same admin aal2 session); no per-token revocation, key rotation is the global invalidation.
