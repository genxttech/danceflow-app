# TW-4F controlled test credit: operator runbook

Status: procedure only. Migration `20270223091000_twilio_test_credit_grant.sql` is in Git and is **not applied to any hosted database**. Nothing in this document has been performed. Following any step against DEV or PROD needs its own owner approval (hosted SQL goes through the approved ops path only; PROD apply is an owner gate). No credit adjustment of any kind may be run against production as part of building or reviewing this mechanism.

## 1. What it is

The ConfiDance pilot ceiling (decision 10) only pays for pilot setup fees. It never pays for texting. To send billed **test** texts, the pilot business needs credit. Test credit is a separate, bounded and audited kind of credit for that one purpose.

| Property | How it is enforced |
| --- | --- |
| Only the pilot business | the legal business must hold the pilot exception (`studio_sms_pilot_exceptions`); otherwise `TW072`. Eligibility is exactly "holds the pilot exception". The exception exists at most once in the whole system, and only for the verified ConfiDance Unlimited, LLC legal business (`tw4_pilot_exception_create`). So no other business can ever receive test credit without a reviewed migration. |
| Platform administrator only | `_tw4c_admin`; otherwise `42501`. The five functions are `service_role` EXECUTE only. No UI, route or cron calls them. |
| Dark by default | database kill switch (`studio_sms_test_credit_switch_log`; no row = OFF), plus the app flag `TW4_TEST_CREDIT_ENABLED=1` for the TypeScript wrapper (`src/lib/sms/twilioIsv/testCreditStore.ts`). The flag only gates what can create credit (grant, budget, switch ON). Switch OFF and reversing unused credit always work. |
| Bounded | per-business TEST BUDGET, default 0. A grant over the remaining budget is refused (`TW071`). Reversals do not free budget. The budget is at most 50000 cents (the existing $500 balance ceiling). No amount is encoded anywhere. |
| Written authorization | every budget change and every grant records U-4 evidence: date (not in the future, at most 31 days old), role (`founder_written` / `owner_written`), scope (`test_credit_budget` / `test_credit_grant`), amount (must equal the amount recorded), period (the business's current billing month, `YYYY-MM`), document reference, sha256 of the retained text. Otherwise `TW052`. |
| One approval, one decision | the approval reference goes into the permanent shared registry `studio_sms_approval_refs`. A reused reference (also one used for a fee approval) is refused with `TW019`. Each retained document (sha256) authorizes one grant and one budget change. An identical retry returns `replayed: true` and changes nothing. |
| Texting only | its own ledger kinds `test_grant` / `test_grant_reversed`. A ledger trigger refuses any non-texting reservation (setup fees, recurring fees, recurring set-asides) that would need unused test credit (`TW007`). Texting uses test credit first. A usage refund of a test-paid charge comes back as test credit. |
| Never absorbs a debt | a refund or dispute of a purchase, a negative adjustment or a captured fee that takes the business's own money below zero forfeits all unused test credit in the same transaction. This is posted as `test_grant_reversed` with key `test_forfeit:<entry>`, and the status field `forfeited_cents` shows it. The balance ends where it would be without test credit. |
| Not purchasable, not refundable | no top-up, Stripe, refund or dispute path can create or pay out these kinds. Only the grant and reverse functions can post them, and the trigger refuses anything else, also in replica mode. |
| Pilot ceiling untouched | a grant creates no reservation, no spend event and nothing pilot-funded |
| STOP / START / HELP | never charged and never touched. The trigger never refuses a texting charge. |
| Studio view | `sms_credit_overview` adds `test_credit_cents` and `fee_available_cents`. The credit panel shows the test credit and what can pay fees, and the history labels both test kinds. The $500 purchase ceiling counts only the business's own credit. |

Refusal codes: `22023` invalid input, `42501` not a platform administrator or a direct write, `TW007` account on hold or negative, or a fee would need test credit, or money is held by an open reservation, `TW019` reference or document reused, `TW052` evidence, `TW070` switch off, `TW071` over budget, below what was granted, or more than the unused amount, `TW072` not the pilot business.

## 2. Preconditions for a real grant (all are owner gates)

1. The migration is applied to the target database with the owner's separate approval. Apply it together with its app build, or before it. The app does not call it.
2. The release gates in `docs/twilio/TW-4F_Financial_Safety_Gates_2026-11-23.md` (on main; not changed here) §2 for "Before the FIRST test message" are met. Test credit is only the "controlled test credit funded" row.
3. The pilot business's monthly spending limit is set. Texting is still subject to it.
4. **The owner's written authorization exists and is retained.** It names the legal business, the purpose (billed test texts, texting only), the exact amount in dollars and cents, the billing month, and who authorizes it, with a date. There is one document for the budget and one for each grant. Both can be the same email thread, but each needs its own retained file and therefore its own sha256.
5. Two people: the operator who runs the SQL and the owner who reads the read-back (§4). The database requires a platform administrator actor and the evidence. It does **not** require a second administrator: see open decision D1.

## 3. Procedure for an approved grant (do not run without approval)

Notation: `<entity>` is the pilot legal business id, `<admin>` is the operator's platform administrator user id, and amounts are integer cents.

### 3.1 Prepare the evidence

1. Save the written authorization as a file in the retained-evidence location. Record its opaque document id (for example `AUTH-DOC-...`) or a plain https link. The link must have no query string, fragment, credentials, `%`, `;`, `&` or `=`.
2. Compute the sha256 of the exact file bytes, in lowercase hex: `certutil -hashfile <file> SHA256` or `sha256sum <file>`.
3. Read the business's current billing month: `select public._tw4ml_month_key('<entity>', now());`
4. Choose an approval reference of 10 to 200 characters that has never been used anywhere, for example `Owner email 2027-02-20 test credit grant 1`.

### 3.2 Set the budget (once; with its own evidence)

```sql
select public.tw4_credit_test_budget_set('<entity>', <budget_cents>, '<budget approval ref>', '<admin>',
  '<authorized_on YYYY-MM-DD>', 'owner_written', 'test_credit_budget', <budget_cents>, '<YYYY-MM>', '<document ref>', '<sha256>');
```

The budget can be raised later with new evidence. It can be lowered to what was already granted, but not below that.

### 3.3 Turn the switch on (for the duration of the grant only)

```sql
select public.tw4_credit_test_set_switch(true, '<admin>', 'Owner-approved test credit grant <date>, ref <ref>');
```

### 3.4 Grant

```sql
select public.tw4_credit_test_grant('<entity>', <cents>, '<grant approval ref>', '<admin>',
  '<authorized_on>', 'owner_written', 'test_credit_grant', <cents>, '<YYYY-MM>', '<document ref>', '<sha256>');
```

Keep the returned `grant_id` and `entry_id`. If you re-run the identical call, it returns `replayed: true`. Do not "retry" with a different amount, reference or document.

### 3.5 Turn the switch off again

```sql
select public.tw4_credit_test_set_switch(false, '<admin>', 'Test credit grant <grant_id> done');
```

Existing test credit stays usable for texting. The switch only stops new grants.

**Limit: there is no freeze of existing unused credit.** Neither the switch nor the app flag stops a business from texting with test credit it already has. To stop that use immediately, either reverse the unused balance (§5) or put the credit account on hold with `tw4_credit_set_hold`. A hold blocks all paid texting for the business, purchased credit included. STOP/START/HELP keep working.

## 4. Verify (read-only)

```sql
select public.tw4_credit_test_status('<entity>');
select public.tw4_credit_verify('<entity>');
select kind, balance_delta_cents, idempotency_key, ref, actor, created_at from public.studio_sms_credit_ledger
 where legal_entity_id = '<entity>' and kind in ('test_grant', 'test_grant_reversed') order by seq;
select action, actor_user_id, note, created_at from public.studio_sms_onboarding_audit where action like 'credit_test_%' order by created_at;
select enabled, changed_by, reason, changed_at from public.studio_sms_test_credit_switch_log order by changed_at;
```

Expected results:
* `ok = true` in both functions.
* `granted_cents` is at most `budget_cents`.
* `unused_cents` equals the grant minus what texting consumed.
* `non_test_available_cents` has not gone up because of the grant: test credit never shows up as fee-paying credit.
* `switch_enabled = false` after step 3.5.
* Exactly one audit row per budget change, grant and reversal.

The owner reads this output back against the written authorization (amount, business, month).

## 5. Reverse the unused balance (end of the test, or on any doubt)

1. `select public.tw4_credit_test_status('<entity>');` and read `unused_cents` and `open_texting_holds_cents`.
2. Only FREE test credit can be reversed: `unused_cents - open_texting_holds_cents`, and never more than the available credit. Test credit backing a text in flight pays that text when it is charged. If any text is in flight, wait until its reservation settles, then reverse what remains. A larger amount is refused with `TW007`, and the message gives the free amount.
3. Run:

```sql
select public.tw4_credit_test_reverse('<entity>', <free_cents>, 'reverse-<grant_id>', 'Pilot test finished: unused test credit returned', '<admin>');
```

4. Verify again (§4): `unused_cents = 0`, `ok = true`. The reversal works whether the switch is on or off. Re-running it with the same key is a replay. The same key with another amount, another administrator or another reason is refused. A reversal does not free budget: a later grant needs a raised budget and new evidence.

## 6. Evidence to retain (permanently)

* The written authorization file for the budget and for each grant, unchanged. Its sha256 must match the recorded one.
* The approval references used, the returned `grant_id`, `change_id` and ledger `entry_id`.
* The §4 read-back output before the grant, after the grant and after the reversal, with UTC timestamps and who ran it.
* The switch log rows: when the switch was on, and who turned it on and off.
* The Twilio Console usage for the test window. The owner compares it with the consumed test credit during the regular invoice reconciliation.
* `tw4_credit_test_status` reports two figures for texting paid with test credit:
  * `test_paid_texting_cents`: the customer-price value of texts paid with test credit, net of usage refunds.
  * `test_paid_texting_provider_cost_estimate_cents`: DanceFlow's estimated provider cost for those texts, from the per-text price that is active **when you read it**. It is not the price at the time each text was sent: if the price changed during the test, use the per-text evidence or the Twilio Console figures instead.

  Both are DanceFlow's own cost of the pilot test, **not revenue**. Record both with the read-back.

**Known limitation (follow-up).** The usage reconciler and the monthly spending limit treat test-paid texts like any other texts. The usage charges are ordinary `usage_charge` entries, and the test-credit trigger only books which part was paid with test credit. So:
* The monthly limit also counts test texts. This is acceptable as a spend control.
* Any usage revenue figure built from `usage_charge` entries includes test-paid texts.

Separating them in those reports needs a reviewed change to the reconciler and the reports. It is not done here, because it is not cheap or safe to do inside this slice. Until then, subtract `test_paid_texting_cents` by hand. Tracked as a follow-up (TW-4F test credit F-1).

The database keeps hashes and references, never the authorization text. Every table here is append-only, the budget counters only grow, and the rollback refuses while any row exists.

### Policies and known limits

* **Texting uses test credit first, and refunds give it back first.** A texting charge is paid from test credit before the business's own money. A usage refund of a test-paid charge gives back test credit, up to what that charge took, before any own money. Nothing is split pro rata. Both orders are conservative for DanceFlow: test credit is used up first and never turns into the business's own refundable money.
* **A forfeit is permanent.** If a refund, dispute, negative adjustment or captured fee pushes own money below zero, the free test credit is forfeited (§1). If that debit is later undone (a dispute won, an adjustment corrected), the forfeited test credit is **not** given back, and it still counts against the test budget. Restoring it takes a new budget decision and a new grant, each with its own evidence.
* **Purchase ceiling, panel vs database.** The credit panel's pack check leaves out only the free test credit. The database's $500 checkout ceiling leaves out all unused test credit, including the part held for texts in flight. The panel can therefore hide a pack that the database would accept, never the reverse. This is cosmetic and safe.
* **Verifier coverage.** `tw4_credit_test_status` checks:
  * that the counters match the movement sums;
  * that the test kinds match the ledger;
  * the credit account's own verification;
  * the own-money rule.

  It does **not** check that each `consume` and `restore` movement matches the ledger row it names. Follow-up F-2: optional hardening that joins each movement to its ledger entry and compares amounts.
* **Deferred check after a release.** The check that forfeits test credit freed by a released texting hold runs at COMMIT, as a deferred constraint trigger. A session that runs `SET CONSTRAINTS ALL IMMEDIATE`, or names that trigger, after a release has the check run at once, before the text's charge in the same transaction. That can forfeit test credit that the charge would have used. Application code does not do this; operators must not either.
* **Replication and restores.** The test-credit triggers are ENABLE ALWAYS:
  * Logical replication applies the rows and fires the triggers again (a direct test-kind insert is refused).
  * `pg_restore` / data-only restores without `--disable-triggers` refuse test-credit rows.

  Restore these tables only through an owner-level procedure that disables the triggers for the restore and then runs `tw4_credit_test_status` and `tw4_credit_verify`.

## 7. Rollback

* Operational: switch OFF (§3.5) and reverse the unused balance (§5).
* Schema: `rollback/20270223091000_twilio_test_credit_grant_rollback.sql`. It only applies while no row of this migration exists, so it is for an environment where the mechanism was never used. Once used, the migration stays applied.

## 8. Open owner decisions

* **D1 (dual control).** The repo's dual control (two registered administrators in authenticated AAL2 sessions) exists only for price changes. The comparable money actions (pilot exception, pilot spend approvals, credit adjustment) use one platform administrator plus U-4 evidence, and this mechanism follows them. Should a test grant require a second, different administrator to approve?
* **D2.** Is the 31-day freshness window for the authorization right? The pilot spend approvals use 400 days.
* **D3.** Is the 50000-cent upper bound on the budget right? It is the existing balance ceiling. The proposed amount itself is not encoded.
* **D4.** Should inbound texts that are charged, rather than absorbed, be allowed to consume test credit? They currently are, because they are messaging usage.
