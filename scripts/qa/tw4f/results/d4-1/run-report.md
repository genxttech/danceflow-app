### D4-1 local QA (disposable Docker databases only; runner scripts/qa/tw4f/run-chain.mjs)
Flags: `--base 23ffbc43 --extra-branch claude/d4-1-price-dual-control --tests-ref claude/d4-1-price-dual-control --image df-isoqa/base:20261119092100 --cutoff 20261119092100 --until 20270204090000 --marker --env TW4RFL_DB=postgres` (plus `--env TW4F4_DB=postgres --env TW4A9_DB=postgres` for f4recovery / tw4a9).

**Chain**: apply (47 main + 20270204090000), rollback of the extra == main-only catalog, re-apply == first apply, rollback of all (48 rollbacks, reverse order) == baseline catalog, re-apply == first apply, second cycle == first apply: all PASS (0/0 catalog diff).

**Suites** (each on a fresh clone of the applied chain), final result per suite:
- New: localStack.pricedual 23/23, localStack.pricedualactions 11/11 (app layer, real actions + real step-up logic).
- WP-D4: localStack.wpd4dual 29/29 (the 12 PRICE-* cells moved to pricedual; ABS/CAN/PRIV cells unchanged), localStack.wpd4actions 9/9.
- Fixtures converted to the two-administrator workflow, all PASS: aal2 4/4, tw4f3bpay 18/18, tw4f3bui 7/7, tw4recexec 20/20, tw4recurring 30/30, f3recon 11/11, tw4inbound 28/28, tw4recon 37/37, tw4rv 28/28, tw4sender 18/18, tw4usage 26/26, j2owner 12/12, j3owner 11/11, r2ci1 10/10, r2ci2 15/15, dryRun.tw4r1 15/15, feeres 46/46, tw4f3a 16/16, tw4f3b0 18/18, tw4fi 25/25, tw4fj1 11/11, tw4r1 11/11, f1funding 25/25, f4recovery 31/31, f5canceltarget 8/8, j4activation 11/11, r2brfl 28/28, tw4a9 9/9, tw4pilothard 25/25, tw4rfl 87/87, tw4rfld5 21/21, tw4rflevid 60/60, tw4rflops 64/64, tw4rflspend 76/76.
- r2a 29/30 (+1 skipped by the suite itself: "R2a-only stack" test; runner class BLOCKED, no failure).
- KNOWN (unchanged from main, documented in known-failures.json): tw4payhardening 14/15, tw4a 14/15, tw4f1b 18/19.
- FAIL, identical on the WP-D0 baseline without D4-1 (verified): tw4monthly 27/28 (a calendar-month test that depends on today's date; 2026-10-31).
- BLOCKED by environment, not run: isolatedQa.canary (5 skipped), r2bp2.rfl (needs TW4A_RFL_DB_CONTAINER); r2b refuses the merged chain by design (0/53).
- Unit/app tests (no database): src/app/platform/sms, src/lib/sms: 81 files / 1545 tests passed (+ 35 database-gated files skipped without a database), tsc clean, eslint 0 errors.

### Review-fix re-run (same flags, TW4RFL_DB=postgres; plus TW4F4_DB / TW4A9_DB for f4recovery)
- Chain (apply, rollback extra == main-only, re-apply, reverse rollback == baseline, re-apply, second cycle): all PASS.
- pricedual 26/26, pricedualactions 11/11, wpd4dual 29/29, wpd4actions 9/9.
- 24 fixture suites PASS: tw4recexec 20, tw4recurring 30, f3recon 11, tw4inbound 28, tw4recon 37, tw4rv 28, tw4sender 18, tw4usage 26, j3owner 11, f1funding 25, f4recovery 31, feeres 46, j4activation 11, r2brfl 28, tw4f3a 16, tw4f3b0 18, tw4fi 25, tw4fj1 11, tw4pilothard 25, tw4rfl 87, tw4rfld5 21, tw4rflevid 60, tw4rflops 64, tw4rflspend 76 (all N/N).
- r2a 29/30 (+1 self-skip, class BLOCKED); tw4monthly 27/28 FAIL (identical on the WP-D0 baseline, date-dependent); r2b 0/53 (refuses the merged chain by design). No saturation-triggered failure in this run.

### Delta re-review hardening run (head after f60f9c50; flags as above, `--residue` for the chain, `--auth` for the real-token suite)
- Chain (apply, rollback of the extra layer, re-apply, reverse rollback of all 48, re-apply, second cycle): all PASS. Accepted fail-closed rollback residue, exactly: after the extra layer's rollback `tw4_price_set` (privileges), `_tw4price_activation_guard`, `_tw4price_truncate_guard` and the two price-list triggers `_00_activation` / `_00_truncate`; after the full reverse chain only the two guard functions. Re-apply stages are compared exactly (no residue accepted).
- pricedual 35/35 (F1 replica regressions PD-02b/02c, registry PD-24, session-bound entry points PD-25/26, verifier PD-27, limits PD-28, rollback with evidence / without / replaced-by-later-slice PD-23/23b/23c, plus the earlier cells), pricedualactions 11/11, wpd4dual 29/29, wpd4actions 9/9.
- REAL GoTrue tokens (`--auth`): pricedual.realtokens 8/8 (aal1 refused, stale TOTP refused for propose/approve and accepted for reject, forged/swapped/expired JWT refused, service_role refused with and without a chosen actor, requester cannot approve own, unregistered and non-admin refused).
- Fixture suites PASS: tw4recexec 20, tw4recurring 30, f3recon 11, tw4inbound 28, tw4recon 37, tw4rv 28, tw4sender 18, tw4usage 26, j3owner 11, f1funding 25, f4recovery 31, feeres 46, j4activation 11, r2brfl 28 (rerun), tw4f3a 16, tw4f3b0 18, tw4fi 25, tw4fj1 11, tw4pilothard 25, tw4rfl 87, tw4rfld5 21, tw4rflevid 60, tw4rflops 64 (rerun after a load timeout), tw4rflspend 76 (rerun after a load timeout).
- r2a 29/30 (+1 self-skip; class BLOCKED); tw4monthly 27/28 (the date-dependent timezone test; identical on the WP-D0 baseline); r2b 0/53 refuses the merged chain by design.
- Host saturation: the full pass ran with the host heavily shared; tw4rflops (ETIMEDOUT, 0/0), tw4rflspend (a 120 s test timeout) and r2brfl (a 4.5 s timing assertion) were load failures and passed on rerun with identical code.
- Unit tests 1869 pass (107 files; 42 database-gated files skipped); tsc clean; eslint 0 errors.
