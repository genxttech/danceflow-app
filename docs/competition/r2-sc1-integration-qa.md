# R2 x SC1 integration QA (W1, 2026-10-24)

Reference branch `competition-int-r2-sc1` = PR #292 (R2 refunds) + PR #306 (SC1 scratch), both merged with origin/main d535720d. Throwaway: no PR, for W3/W5 reference only. Nothing hosted was touched: no DEV/PROD database, no deploy, no Stripe call.

## Databases used (every result below names one)

| Label | What it is |
|---|---|
| **CLI-crlf** | Supabase CLI stack `int-qa` (ports 565xx, real Auth + Storage schemas, image 17.6.1.106 with `supautils.hint_roles` emptied). Loaded with the July-2026 production schema dump, then **266 repo migrations in version order** (0103 then 0108 last), with one test-environment correction: `20260831090000` replayed with CRLF line endings (see below). The three seeded `competition_configuration_templates` rows (a data table the schema-only dump lacks) were loaded from the local data backup, and trigger `trg_reward_paid_payment` was disabled (see below). 259 migrations apply, 7 do not. |
| **plain-strict** | Plain Postgres 17.6 container `int-r2sc1-db`, same dump + same migrations, **no** corrections. |

### Migration-build findings (not R2/SC1 defects)

- **The LAUNCH-SEC-1C-0 -> 10C chain does not replay on a bare Postgres (plain-strict).** 23 migrations fail. First failure of the chain: `20261007090000_launchsec1c0_emergency_auth_closure.sql` ("user_has_client_portal_access is not the reviewed definition"), pinned `md5(prosrc) = c0b5901eaad8130f2b6ee6d983687483`. **Root cause:** that pin is the md5 of the function body **with CRLF line endings** (verified: LF body = `5192dabd...`, CRLF body = `c0b5901e...`); PROD applied `20260831090000_user_has_client_portal_access_helper.sql` from a CRLF file. Everything downstream (1C-0-R, 1C-A, 1C-B, 2B, GC-3.5-2, REFUND-RECON-1/2, 9A-9C, 10C ... 10C.5) then fails on its own preflight. R2 itself also fails there ("sync_event_payment_accounting_entry is not the reviewed definition"). Other plain-strict failures: `storage.buckets` missing (3 migrations), `auth.users.deleted_at` missing (1C-A).
- **CLI-crlf (replaying 20260831 with CRLF on a real Supabase stack) removes 16 of the 23 failures.** Remaining 7, none touches R2/SC1: `20260918030000` (Slice 5A prod-row guard), `20261005090000` / `20261006090000` (storage bucket seed rows), `20261011090000` (2B appointments pin), `20261102090000` / `03` / `04` (Phase 9A-9C payroll pins).
- **Pre-existing, unrelated to R2/SC1:** trigger `trg_reward_paid_payment` (`20260731000200`) compares `coalesce(new.status, '')` of enum `payments.status` to text and raises `invalid input value for enum payment_status: ""` on any `payments` insert with a client. It aborts the REFUND-RECON suites' fixtures here and on the older clone. It was disabled on CLI-crlf only to let those suites run. **Worth a separate look in prod** (a payment insert with a `client_id` would hit it if prod's column is the same enum).
- **PostgreSQL signal 11** (supautils hint, `docs/twilio/TW-4F_Isolated_QA.md`): the first suite run on the unmitigated CLI stack crashed the backend once; mitigated with `alter system set supautils.hint_roles = ''`.

## Results

| # | Check | DB | Result |
|---|---|---|---|
| 1 | Apply order 0103 -> 0108 (forward) | CLI-crlf | PASS (both apply clean, post-build) |
| 2 | R2 SQL suite | CLI-crlf, forward | **PASS (123 checks)** |
| 3 | SC1 SQL suite | CLI-crlf, forward | **PASS (78 checks)** |
| 4 | 10A / 10B / 10C / 10C.4 / 10C.5 / 10D / 10D.1 | CLI-crlf, forward | **PASS** 109 / 130 / 177 / 55 / 220 / 79 / 22 |
| 5 | PAY-WH-1 / PAY-WH-1A / 10C pricing parity | CLI-crlf, forward | **PASS** 114 / 66 / 45 scenarios |
| 6 | REFUND-RECON-1 / 2 | CLI-crlf (rewards trigger disabled), forward | **PASS** 54/54 and 35 ALL_PASS |
| 7 | Reverse apply order (0108 then 0103), after a clean combined rollback | CLI-crlf | **PASS**: applies; catalog fingerprint (functions + bodies + ACLs, triggers, policies, columns, table ACLs) **identical** to forward; R2 123, SC1 78, 10A-10D.1, PAY-WH-1/1A and pricing parity pass again in reverse state (REFUND-RECON not re-checked in reverse; its result column was blank in that run) |
| 8 | Clean combined rollback (SC1 then R2), no evidence | CLI-crlf | **PASS**: SC1 full rollback; guard md5 `7997313d`; R2 rollback restores `fabd4052 / 7dc2d16f / 5bb0940b / d0b30516`; R2 tables gone |
| 9 | R2 rollback attempted while SC1 live | CLI-crlf | **PASS** (refused, review P2-1) |
| 10 | SC1 two-session concurrency (`sc1_concurrency.sh`): scratch vs scratch (different ids), same request id twice, scratch vs heat lock (both directions), scratch vs placement write | CLI-crlf | **PASS (25 incl. soft rollback)**, no deadlock |
| 11 | SC1 soft rollback with scratch history (in the same script) | CLI-crlf | **PASS**: tables + history kept, entries stay scratched, RPCs dropped, guard `7997313d`, lifecycle ACL restored, history still append-only, re-apply refused |
| 12 | Scratch vs R2 refund request, scratch vs observe(withdraw) both ways (`int_r2_sc1_concurrency.sh race`) | CLI-crlf | **PASS** after the R2 fix below; the request on the **same** entry waits for the scratch (FK key share vs entry `FOR UPDATE`), commits after it, never deadlocks |
| 13 | Combined rollback with evidence (`... rollback`): SC1 soft, R2 refuses | CLI-crlf | **PASS** (8 checks): R2 bodies still the R2 pins, ledger intact |
| 14 | No scratch path writes refunds / allocations / scopes / accounting, reserves a cap, or touches order/payment/registration (`test_T_competition_sc1_no_money.sql`, real paid order, money signature over 10 tables) | CLI-crlf | **PASS (20)** |
| 15 | Same suites on a local public-schema clone | public-schema clone | NOT RUN here (the CLI-crlf build is the migration-built database; the clone method was R2's/SC1's earlier evidence) |
| 16 | Plain-strict database | plain-strict | R2 and the 10C chain **do not apply** (documented above); suites NOT RUN |
| 17 | End-to-end Stripe test-mode flows against the combined app | - | NOT RUN (local app, keys and `stripe listen` not started; R2's E2E results stay valid for R2 alone) |
| 18 | Network-error injection | - | BLOCKED (as before) |
| 19 | `tsc --noEmit` | combined branch | see PR bodies |

## Integration defects found and fixed

1. **R2 scope gate unreachable after SC1 (P1 integration).** `resolve_competition_refund_scope('withdrawn_after_unlock')` required `status = 'withdrawn'`, but SC1 revokes the lifecycle RPC from API roles, so the only way left to take an entry out of a locked heat is a scratch (`status = 'scratched'`). Gate now accepts `withdrawn` or `scratched`. R2's suite used the retired lifecycle RPC in three places; it now uses the SC1 scratch RPC when the lifecycle RPC is no longer executable.
2. **Refund allocation mislabelled after a concurrent scratch (P2).** `_r2_apply_participation` set the allocation outcome `withdrawn` even when `_r2_withdraw_entry` returned false because a concurrent SC1 scratch had already taken the entry. Now `not_applicable`. Found by the two-session race, proven fixed by it.
3. **Independent review (no P0/P1) P2s fixed:** R2 rollback now refuses while the SC1 scratch RPC is live (an R2-first rollback would re-open the 10A cascade that overwrites `scratched` with `withdrawn`); a reversal no longer raises a competitive scope for an entry already withdrawn/scratched, and scratched placements no longer hold a heat in the class and scope selection; **`disqualified` placements now count as danced in R2** (same rule as SC1).
4. **New R2 pin:** `sync_competition_entries_from_registration` = `3a19d4b4` (was `95e9cd2a`; the cascade's danced rule gained `disqualified`). The other three R2 pins are unchanged (`4577dc12`, `5469516f`, `dd85d688`); the SC1 guard pin `7997313d` is unchanged. The R2 rollback preflight pins the new value.

## Not fixed (reviewer P3, documented)

Registration cascade takes no heat lock (a webhook retry heals it); concurrent placement insert vs scratch can leave a scheduled placement on a scratched entry (pre-existing 10D.1 design, same as withdraw); rollbacks check-then-drop without a table lock and the SC1 rollback has no live-body pin; `service_role` direct writes bypass the SC1 guard; `authenticated` can still edit `scratched_at` / `scratch_reason` directly.
