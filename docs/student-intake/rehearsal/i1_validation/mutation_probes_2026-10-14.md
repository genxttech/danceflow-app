# NSI I1 remediation — mutation probes (2026-10-14, local disposable stack only)

Each probe prepends one reverted fix (CREATE OR REPLACE of the function with the fix removed) to
`test_T_nsi_i1_local.sql`, inside the suite's single rolled-back transaction. A probe passes when the suite FAILS
on the checks that guard that fix.

| Probe | Reverted fix | Suite result (failing checks) |
|---|---|---|
| a | `assert_staff`: front desk granted `minor_override` (P1-1) | FAIL: P11a |
| c | `assurance_rank` returns 3 for every level (P1-2 / P2-3) | FAIL: P23a, then dependent guardian-path checks |
| d | `drift_detected` no longer writes the security event (P2-1) | FAIL: A07b, A07c |
| e | `intake_submit_response` status check removed (P1-3) | FAIL: P13b, P13f |
| f | `intake_save_draft` revision compare back to `<>` (P2-2) | FAIL: P22b, then O07c |
| g | `intake_save_draft` accepts caller `assurance` / `auth_user_id` (P1-2) | FAIL: R05, R05b, then O07a |

All six reverted fixes were detected. Unmodified suite: 268/268 PASS (see full_run_2026-10-14.log).
