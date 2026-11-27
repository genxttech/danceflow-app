# Platform-admin security backlog (from the 2026-11-07 PROD preflight)

Counts on PROD at that time: 170 RLS policies across 81 tables and 37 authenticated-callable functions check platform authority without aal2. None is remediated by H1
or by the AAL2 migration `20261231090000` (which covers only the SMS onboarding helper and `studio_sms_registrations` policies).

Priority order (read from code and catalog; not live-tested):
1. Money/payroll SECURITY DEFINER functions that check role only: payroll approve / mark paid / export; void pending package payment; resolve payment settlement conflict;
   apply manual payment; create package sale; `record_competition_checkin_payment`.
2. Server actions guarded by `requirePlatformAdmin` alone: platform invites, workspace-active, portal repair, mobile-push test route.
3. Wave posting entitlement, broadcast alerts, expenses and similar.
4. Hygiene: `anon` has TRUNCATE on `profiles` and `user_studio_roles` on PROD (not reachable through PostgREST).
5. A CI registry classifying every `requirePlatformAdmin` action by required tier.
Escalate any independently verified critical exploit immediately.

## Deferred, noncritical findings from the H1 production closeout (2026-11-08)

Owner decision 2026-11-08: stop peripheral cleanup; none of the items below is a confirmed, material risk and none blocks TW-4F. No credential was rotated or revoked.

1. **Unused Vercel project `danceflow-app`.** The Production Stripe secret, Stripe webhook secret and Resend key variables were removed from the project, and its production deployment was rebuilt without them. Older deployments of that project (before the trim) still hold the old values baked in; their URLs redirect to Vercel sign-in and the team has one member. Optional later cleanup: delete those old deployments or the project. Removing a variable from Vercel does not revoke the credential at its provider.
2. **`createDeployments: disabled` does not stop Git builds** (it only controls GitHub Deployment records). The unused project now uses an ignore-build command (`exit 0`). Any other project that relied on that setting is not protected by it.
3. **Resend keys (3).** The production app sends with the sending-only key "Supabase SMTP Production". "DanceFlow" (full access, all domains; also used by local development) and "DanceFlow Prod" (full access, all domains, no recorded use) are broader than needed. Optional later cleanup: create a sending-only key for local development, then revoke "DanceFlow"; reduce or revoke "DanceFlow Prod". The unused project held "DanceFlow" or a since-deleted key, never production's current key. Resend retains about 15 days of logs, so earlier use cannot be reviewed.
4. **Stripe keys that were on the unused project** have the same history (removed from Vercel, not revoked). The publishable key is test mode, so these are probably test keys; not confirmed.
