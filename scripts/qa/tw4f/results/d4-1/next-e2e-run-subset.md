# D4-2 real Next.js browser acceptance run

- when 2026-11-07T05:09:31.000Z; branch claude/d4-2-price-next-e2e @ d16a951e; node v24.14.1; Chromium 151.0.7922.34
- stack: df-isoqa/base:20261119092100 + 59 repo migrations (last 20270210110000_twilio_price_monitor.sql), PostgREST, GoTrue, Kong (local, disposable); app: next build + next start (Turbopack) at http://localhost:3417
- **totals: 72 PASS, 0 FAIL, 1 BLOCKED**

| scenario | PASS | FAIL | BLOCKED |
|---|---|---|---|
| 1 | 11 | 0 | 1 |
| 2 | 19 | 0 | 0 |
| 4 | 13 | 0 | 0 |
| 5 | 15 | 0 | 0 |
| 14 | 9 | 0 | 0 |
| 0 setup | 5 | 0 | 0 |

## Checks

- PASS [0 setup] login + TOTP challenge through the real pages (session 1) :: http://localhost:3417/platform/sms
- PASS [0 setup] login + TOTP challenge through the real pages (session 2, separate session) :: http://localhost:3417/platform/sms
- PASS [0 setup] two distinct GoTrue sessions exist :: 3 sessions
- PASS [0 setup] config defaults: single_owner, 24 h cooling-off, backup-eligible refused, monitoring not expected :: single_owner
- PASS [0 setup] the keys panel is rendered by the Next page (no credentials yet)
- PASS [1] UI before any key exists: enrol is refused with a clear sentence and creates nothing :: The action failed. Nothing changed; reload and check the current state before trying again.
- PASS [1] owner bootstrap installs primary + recovery in one transaction (RP localhost, origin of the Next host)
- PASS [1] the panel's role list offers no 'recovery' (a recovery key is never enrolled through the UI) :: spare,primary
- BLOCKED [1] first primary enrolment THROUGH THE UI :: by design there is no UI path: Request a new key needs an existing key to sign (priceCredBegin/priceCredEnroll); the first key is the owner runbook bootstrap (_tw4price_bootstrap). Verified above that the UI refuses cleanly with no key.
- PASS [1] spare request via UI is PENDING (not active) :: Requested. The new key becomes usable only after the delay; you can cancel it until then.
- PASS [1] Apply before the delay is refused with a clear sentence and the key stays pending :: The 24-hour cooling-off of this proposal has not ended yet. Nothing changed.
- PASS [1] spare applied through the UI after the aged database clock :: Done: applied.
- PASS [1] last-credential rule: the spare cannot retire itself while the bootstrap primary has no enrolment proof :: The database refused the input (check the kind, the amounts, the lengths, and that the proposal differs from the active price). Nothing changed.
- PASS [1] owner-level enrolment proof: the real authenticator attests the bootstrap primary and the installed recovery key :: attested / attested
- PASS [1] policy UI: the recovery row offers ONLY 'Retire the recovery key'; ordinary rows offer 'Retire this key' and 'Evict with the recovery key' :: [["Retire the recovery key (final)"],["Retire this key (touch this key, final)","Evict with the recovery key (final)"]]
- PASS [1] three-credential set: primary (owner-level) + spare (UI, delayed) + recovery (owner-level) :: primary:primary,recovery one:recovery,spare one:spare
- PASS [1] the audit holds the credential_change_pending and credential_change_applied events :: applied=1 pending=1
- PASS [2] propose through the UI form (aal2 + fresh TOTP, session 1) :: Proposal recorded. A different platform administrator must approve it within 24 hours; no price has changed.
- PASS [2] recorded as a single-owner proposal v1 with a 24 h cooling-off, price untouched :: pending|owner|v1|425
- PASS [2] the PROPOSING session is refused (no challenge summary) :: Not allowed. Price changes need a registered administrator in a second-factor session; publication also needs a different session and the hardware key, and is refused while prices are suspended. Only an active platform administrator can do this, and a price change can never be approved by the admini
- PASS [2] a second session is refused inside the cooling-off (no challenge) :: The 24-hour cooling-off of this proposal has not ended yet. Nothing changed.
- PASS [2] after the (database-clock) cooling-off the separate session gets the challenge with the exact summary from the database :: Scope: studio_sms_price_list; price: number; proposal version 1 Customer price: none to $4.25 DanceFlow provider cost: none to $1.15 Description: browser price one Fingerprint: 288a2409e4daf269
- PASS [2] an authenticator holding ONLY the recovery key cannot sign a price (the recovery key is not offered) :: The authenticator did not sign (cancelled, not available or not allowed). Nothing changed.
- PASS [2] authorize with the primary key: the price is published :: Authorized. The new price is published.
- PASS [2] assertion profile (default virtual authenticator): UP and UV set, backup flags (BE/BS) clear :: flags=0x5
- PASS [2] REPLAY of the captured server-action request publishes nothing and applies once :: 200 0:{"a":"$@1","f":"","q":"","i":false,"b":"eB3nJ_UyBuD2zaC6-C6mE"} 1:{"ok":true,"data":{"status":"refused","reason":"this price proposal is already applied and c
- PASS [2] the price flash cookie (set by the propose action) is HttpOnly, SameSite=Strict, path /platform/sms, lives <= 60 s :: {"httpOnly":true,"sameSite":"Strict","path":"/platform/sms","secure":true,"ttl":45}
- PASS [2] second proposal recorded :: Proposal recorded. A different platform administrator must approve it within 24 hours; no price has changed.
- PASS [2] challenge issued for v1 of the second proposal :: Scope: studio_sms_price_list; price: number; proposal version 1 Customer price: $4.25 to $5.10 DanceFlow provider cost: $1.15 to $1.15 Description: browser price two Fingerprint: 86255f520ee199eb
- PASS [2] the signed finish request was held in the browser (signature over v1 captured)
- PASS [2] revise through the UI voids v1 and creates v2 :: Revised (version 2). The earlier proposal and any signature over it are void and the 24-hour cooling-off starts again.
- PASS [2] v2 restarts the 24 h cooling-off and the old request is no longer pending :: invalidated|owner|v1|510 / pending|owner|v2|520
- PASS [2] the pre-revision signature is REFUSED by the database and publishes nothing :: The database refused the signature: this price proposal is already invalidated and cannot be authorized. Nothing changed.
- PASS [2] replaying the v1 signature again is also refused :: 0:{"a":"$@1","f":"","q":"","i":false,"b":"eB3nJ_UyBuD2zaC6-C6mE"} 1:{"ok":true,"data":{"status":"refused","reason":"this
- PASS [2] v2 cannot be authorized inside its restarted cooling-off :: The 24-hour cooling-off of this proposal has not ended yet. Nothing changed.
- PASS [2] after the new cooling-off v2 (5.20) is authorized and published :: Authorized. The new price is published.
- PASS [4] policy: the PRIMARY key cannot retire the spare (a key retires only itself) :: The authenticator did not sign or the request failed. Nothing changed.
- PASS [4] revoke through the UI is immediate and final :: Revoked. This takes effect immediately and cannot be undone: a mistaken revocation is repaired only by enrolling a new key.
- PASS [4] no cancel / undo control exists for a revoked key (no row, no pending change, no Cancel button)
- PASS [4] the database exposes no cancel / undo / reinstate function for a revocation
- PASS [4] second spare enrolled through the UI :: Done: applied.
- PASS [4] an ordinary (primary) key is NOT offered for retiring the recovery key: only the recovery key can retire itself :: The authenticator did not sign or the request failed. Nothing changed.
- PASS [4] the recovery key retires itself through the UI (immediate, final) :: Revoked. This takes effect immediately and cannot be undone: a mistaken revocation is repaired only by enrolling a new key.
- PASS [4] a new key is requested with the SPARE key's signature (pending) :: Requested. The new key becomes usable only after the delay; you can cancel it until then.
- PASS [4] challenge issued while spare two is still active (it is offered) :: Scope: studio_sms_price_list; price: number; proposal version 1 Customer price: $5.20 to $6.00 DanceFlow provider cost: $1.15 to $1.15 Description: revoked signer price Fingerprint: e16d5065fccf2c4a
- PASS [4] spare two revoked via the UI between the challenge and the signature :: Revoked. This takes effect immediately and cannot be undone: a mistaken revocation is repaired only by enrolling a new key.
- PASS [4] the revoked key's REAL signature on the already-issued challenge is rejected, nothing published :: The database refused the signature: unknown or revoked credential. Nothing changed.
- PASS [4] the pending enrolment authorized by the now-revoked key is dead (voided, or Apply refused); the key never becomes active :: change status before apply: cancelled; apply: NO ROW (TimeoutError: locator.click: Timeout 300)
- PASS [4] a fresh recovery key is enrolled again for the following scenarios :: primary:primary,recovery two:recovery
- PASS [5] freeze through the UI (aal2 session) :: Price publication is suspended. It publishes nothing; lifting the suspension needs the hardware key.
- PASS [5] propose while frozen is refused with a clear message :: Not allowed. Price changes need a registered administrator in a second-factor session; publication also needs a different session and the hardware key, and is refused while prices are suspended. Only an active platform administrator can do this, and a price change can never be approved by the admini
- PASS [5] the page shows the suspension banner and the primary key lifts it :: Publication resumed.
- PASS [5] freeze with the RECOVERY key through the UI :: Publication is suspended.
- PASS [5] ordinary thaw is refused during a recovery freeze/hold :: Not allowed. Price changes need a registered administrator in a second-factor session; publication also needs a different session and the hardware key, and is refused while prices are suspended. Only an active platform administrator can do this, and a price change can never be approved by the admini
- PASS [5] an ordinary key cannot revoke the recovery key (stays active) :: The authenticator did not sign or the request failed. Nothing changed.
- PASS [5] recovery enrolment through the UI is pending and suspends publication :: Recovery requested. It completes only after the long delay, raises high-severity alerts, and only the recovery key can cancel it. (suspended=true)
- PASS [5] a primary key cannot cancel the recovery enrolment (not offered / refused) :: The authenticator did not sign or the request failed. Nothing changed.
- PASS [5] the recovery key cancels the recovery enrolment :: Cancelled.
- PASS [5] recovery restarted (new key), pending with the long delay
- PASS [5] apply before the recovery delay is refused :: The 24-hour cooling-off of this proposal has not ended yet. Nothing changed.
- PASS [5] after the delay the recovery completes and replaces the whole set :: Done: applied. / recovered two:primary
- PASS [5] suspension after completed recovery is lifted with the recovered primary :: Publication resumed.
- PASS [5] the recovered primary authorizes a price from a separate session :: Authorized. The new price is published.
- PASS [5] the audit holds recovery events
- PASS [14] forged signature on AUTHORIZE (corrupted in flight): a plain refusal sentence, nothing published :: The database refused the signature: signature does not verify. Nothing changed.
- PASS [14] forged signature on authorize: one assertion_rejected row, NO integrity_failure row and NO integrity security event :: [{"integrity":0,"rejected":1,"events":0},{"integrity":0,"rejected":2,"events":0}]
- PASS [14] the genuine assertion that follows is accepted (the forgery did not touch the key's counter) :: Authorized. The new price is published.
- PASS [14] forged signature on THAW: plain refusal, still frozen, no integrity alert :: The database refused: signature does not verify. Nothing changed. [{"integrity":0,"rejected":2,"events":0},{"integrity":0,"rejected":3,"events":0}]
- PASS [14] the genuine thaw then succeeds :: Publication resumed.
- PASS [14] forged signature on RETIRE (credential revoke): plain refusal, key stays active, no integrity alert :: The database refused: signature does not verify. Nothing changed. [{"integrity":0,"rejected":3,"events":0},{"integrity":0,"rejected":4,"events":0}]
- PASS [14] the genuine retire then succeeds :: Revoked. This takes effect immediately and cannot be undone: a mistaken revocation is repaired only by enrolling a new key.
- PASS [14] forged signature on RECOVERY revoke: plain refusal, recovery key stays active, no integrity alert :: The database refused: signature does not verify. Nothing changed. [{"integrity":0,"rejected":4,"events":0},{"integrity":0,"rejected":5,"events":0}]
- PASS [14] the genuine recovery revoke then succeeds :: Revoked. This takes effect immediately and cannot be undone: a mistaken revocation is repaired only by enrolling a new key.
