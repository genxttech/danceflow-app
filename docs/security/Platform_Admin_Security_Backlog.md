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
