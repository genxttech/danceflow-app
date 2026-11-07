# D4-2 real Next.js browser acceptance run

- when 2026-11-07T03:27:05.929Z; branch claude/d4-2-price-next-e2e @ 8183ab2b; node v24.14.1; Chromium 151.0.7922.34
- stack: df-isoqa/base:20261119092100 + 59 repo migrations (last 20270210110000_twilio_price_monitor.sql), PostgREST, GoTrue, Kong (local, disposable); app: next build + next start (Turbopack) at http://localhost:3417
- **totals: 184 PASS, 0 FAIL, 1 BLOCKED**

| scenario | PASS | FAIL | BLOCKED |
|---|---|---|---|
| 1 | 11 | 0 | 1 |
| 2 | 19 | 0 | 0 |
| 3 | 33 | 0 | 0 |
| 4 | 13 | 0 | 0 |
| 5 | 15 | 0 | 0 |
| 6 | 8 | 0 | 0 |
| 7 | 10 | 0 | 0 |
| 8 | 16 | 0 | 0 |
| 9 | 6 | 0 | 0 |
| 10 | 22 | 0 | 0 |
| 11 | 16 | 0 | 0 |
| 12 | 4 | 0 | 0 |
| 13 | 6 | 0 | 0 |
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
- PASS [2] after the (database-clock) cooling-off the separate session gets the challenge with the exact summary from the database :: Scope: studio_sms_price_list; price: number; proposal version 1 Customer price: none to $4.25 DanceFlow provider cost: none to $1.15 Description: browser price one Fingerprint: a7f33484865c4091
- PASS [2] an authenticator holding ONLY the recovery key cannot sign a price (the recovery key is not offered) :: The authenticator did not sign (cancelled, not available or not allowed). Nothing changed.
- PASS [2] authorize with the primary key: the price is published :: Authorized. The new price is published.
- PASS [2] assertion profile (default virtual authenticator): UP and UV set, backup flags (BE/BS) clear :: flags=0x5
- PASS [2] REPLAY of the captured server-action request publishes nothing and applies once :: 200 0:{"a":"$@1","f":"","q":"","i":false,"b":"mqL3WL7trQMSV4pyqY6oE"} 1:{"ok":true,"data":{"status":"refused","reason":"this price proposal is already applied and c
- PASS [2] the price flash cookie (set by the propose action) is HttpOnly, SameSite=Strict, path /platform/sms, lives <= 60 s :: {"httpOnly":true,"sameSite":"Strict","path":"/platform/sms","secure":true,"ttl":35}
- PASS [2] second proposal recorded :: Proposal recorded. A different platform administrator must approve it within 24 hours; no price has changed.
- PASS [2] challenge issued for v1 of the second proposal :: Scope: studio_sms_price_list; price: number; proposal version 1 Customer price: $4.25 to $5.10 DanceFlow provider cost: $1.15 to $1.15 Description: browser price two Fingerprint: 3fceea32e6db9802
- PASS [2] the signed finish request was held in the browser (signature over v1 captured)
- PASS [2] revise through the UI voids v1 and creates v2 :: Revised (version 2). The earlier proposal and any signature over it are void and the 24-hour cooling-off starts again.
- PASS [2] v2 restarts the 24 h cooling-off and the old request is no longer pending :: invalidated|owner|v1|510 / pending|owner|v2|520
- PASS [2] the pre-revision signature is REFUSED by the database and publishes nothing :: The database refused the signature: this price proposal is already invalidated and cannot be authorized. Nothing changed.
- PASS [2] replaying the v1 signature again is also refused :: 0:{"a":"$@1","f":"","q":"","i":false,"b":"mqL3WL7trQMSV4pyqY6oE"} 1:{"ok":true,"data":{"status":"refused","reason":"this
- PASS [2] v2 cannot be authorized inside its restarted cooling-off :: The 24-hour cooling-off of this proposal has not ended yet. Nothing changed.
- PASS [2] after the new cooling-off v2 (5.20) is authorized and published :: Authorized. The new price is published.
- PASS [3] password-only login (aal1) succeeds
- PASS [3] an aal1 session is sent to the MFA challenge, not the pricing page :: http://localhost:3417/platform-mfa/challenge
- PASS [3] aal1: the credential-list server action returns no data (redirect to the challenge) :: 303 /platform-mfa/challenge?stepup=1&reason=aal1&next=%2Fplatform%2Fsms;push
- PASS [3] aal1: the authorize-begin server action returns no challenge :: 303 /platform-mfa/challenge?stepup=1&reason=aal1&next=%2Fplatform%2Fsms;push
- PASS [3] aal1: the propose form action creates nothing :: 303 /platform-mfa/challenge?stepup=1&reason=aal1&next=%2Fplatform%2Fsms;push
- PASS [3] revoked: full aal2 login first
- PASS [3] revoked: exactly one new GoTrue session :: 1
- PASS [3] revoked: before the change the same request is served :: 200
- PASS [3] revoked: the server action is refused afterwards (redirect, no data) :: 303 /login;push
- PASS [3] revoked: the page sends the browser to sign in :: http://localhost:3417/login
- PASS [3] expired: full aal2 login first
- PASS [3] expired: exactly one new GoTrue session :: 1
- PASS [3] expired: before the change the same request is served :: 200
- PASS [3] expired: an expired ACCESS TOKEN whose session is still valid is silently refreshed and the action is served (aal2 retained) :: 200 
- PASS [3] expired: the server action is refused afterwards (redirect, no data) :: 303 /login;push
- PASS [3] expired: the page sends the browser to sign in :: http://localhost:3417/login
- PASS [3] signed-out: full aal2 login first (second administrator)
- PASS [3] signed-out: before sign-out the raw access token is accepted by the database RPC (PostgREST) :: 200
- PASS [3] signed-out: before sign-out the server action is served
- PASS [3] signed-out: the Log Out button ends the session and lands on a public page :: http://localhost:3417/login
- PASS [3] signed-out: replaying the captured server action with the OLD cookies is refused (redirect, no data) :: 303 /login;push
- PASS [3] signed-out: the still-unexpired JWT is refused BY THE DATABASE (session ended, 42501) :: 403 {"code":"42501","details":null,"hint":null,"message":"this session has ended: sign in again"}
- PASS [3] production behaviour: public.tw4_local_qa_only is ABSENT in this database
- PASS [3] another user's real GoTrue session exists for the forgery :: 200
- PASS [3] forged token (another user's real session id re-signed into the caller's token): refused by the database through PostgREST :: 403 {"code":"42501","details":null,"hint":null,"message":"this session belongs to another user"}
- PASS [3] forged token (another user's real session id re-signed into the caller's token): the real Next server action returns no data :: 200 0:{"a":"$@1","f":"","q":"","i":false,"b":"mqL3WL7trQMSV4pyqY6oE"} 1:{"ok":false,"message":"Not allowed. Price 
- PASS [3] forged token (a random (non-existent) session id): refused by the database through PostgREST :: 403 {"code":"42501","details":null,"hint":null,"message":"this session has ended: sign in again"}
- PASS [3] forged token (a random (non-existent) session id): the real Next server action returns no data :: 303 /login;push
- PASS [3] forged token (no session_id claim at all): refused by the database through PostgREST :: 403 {"code":"42501","details":null,"hint":null,"message":"a session id (uuid) is required"}
- PASS [3] forged token (no session_id claim at all): the real Next server action returns no data :: 200 0:{"a":"$@1","f":"","q":"","i":false,"b":"mqL3WL7trQMSV4pyqY6oE"} 1:{"ok":false,"message":"Not allowed. Price 
- PASS [3] forged token (a non-uuid session_id claim): refused by the database through PostgREST :: 403 {"code":"42501","details":null,"hint":null,"message":"a session id (uuid) is required"}
- PASS [3] forged token (a non-uuid session_id claim): the real Next server action returns no data :: 303 /login;push
- PASS [3] the owner of the session-actor function can read auth.sessions (local role; hosted must be confirmed separately) :: postgres super=false sees_auth.sessions=true
- PASS [4] policy: the PRIMARY key cannot retire the spare (a key retires only itself) :: The authenticator did not sign or the request failed. Nothing changed.
- PASS [4] revoke through the UI is immediate and final :: Revoked. This takes effect immediately and cannot be undone: a mistaken revocation is repaired only by enrolling a new key.
- PASS [4] no cancel / undo control exists for a revoked key (no row, no pending change, no Cancel button)
- PASS [4] the database exposes no cancel / undo / reinstate function for a revocation
- PASS [4] second spare enrolled through the UI :: Done: applied.
- PASS [4] an ordinary (primary) key is NOT offered for retiring the recovery key: only the recovery key can retire itself :: The authenticator did not sign or the request failed. Nothing changed.
- PASS [4] the recovery key retires itself through the UI (immediate, final) :: Revoked. This takes effect immediately and cannot be undone: a mistaken revocation is repaired only by enrolling a new key.
- PASS [4] a new key is requested with the SPARE key's signature (pending) :: Requested. The new key becomes usable only after the delay; you can cancel it until then.
- PASS [4] challenge issued while spare two is still active (it is offered) :: Scope: studio_sms_price_list; price: number; proposal version 1 Customer price: $5.20 to $6.00 DanceFlow provider cost: $1.15 to $1.15 Description: revoked signer price Fingerprint: 8a1d2fb1fbfa13dd
- PASS [4] spare two revoked via the UI between the challenge and the signature :: Revoked. This takes effect immediately and cannot be undone: a mistaken revocation is repaired only by enrolling a new key.
- PASS [4] the revoked key's REAL signature on the already-issued challenge is rejected, nothing published :: The database refused the signature: unknown or revoked credential. Nothing changed.
- PASS [4] the pending enrolment authorized by the now-revoked key is dead (voided, or Apply refused); the key never becomes active :: change status before apply: cancelled; apply: NO ROW (TimeoutError: locator.click: Timeout 300)
- PASS [4] a fresh recovery key is enrolled again for the following scenarios :: primary:primary,recovery two:recovery
- PASS [7] login in a backup-eligible authenticator profile session
- PASS [7] default allow_backup_eligible=false: a backup-eligible (BE/BS) key is refused at enrolment, nothing pending :: The database refused: a backup-eligible (synced) credential is not accepted. Nothing changed.
- PASS [7] allow_backup_eligible=true: the BE key is accepted (pending then applied) :: Requested. The new key becomes usable only after the delay; you can cancel it until then. / Done: applied.
- PASS [7] the BE profile really produces BE+BS flags in the assertion (0x18) :: flags=0x1d
- PASS [7] flag true: an assertion from the BE key is accepted and publishes :: Authorized. The new price is published.
- PASS [7] flag back to false: the same BE key's assertion is REFUSED (backup-eligible) and nothing publishes :: The database refused the signature: a backup-eligible (synced) credential is not accepted. Nothing changed.
- PASS [7] the non-backup-eligible primary still authorizes under the default :: Authorized. The new price is published.
- PASS [7] login in a profile whose authenticator is NOT user-verified
- PASS [7] an authenticator that does not verify the user cannot authorize (userVerification: required) :: The authenticator did not sign (cancelled, not available or not allowed). Nothing changed.
- PASS [7] BE test key revoked again, set back to primary + recovery
- PASS [6] race fixture active
- PASS [6] two sessions revoke the same key at once: exactly one revocation is recorded :: Revoked. This takes effect immediately and cannot be undone: || The database refused: unknown or already revoked credential.
- PASS [6] the primary and recovery keys are untouched by the race
- PASS [6] two sessions apply the same pending key at once: one active row, one apply recorded :: This is not allowed in the proposal's current stat || Done: applied.
- PASS [6] race fixture: [primary, race b] active :: primary:primary,race b:spare
- PASS [6] enrol signed by key B races B's revocation: B ends revoked and the key it authorized never becomes active :: enrol: Requested. The new key becomes usable only after the delay; you can ca | revoke: Revoked. This takes effect immediately a | apply: 
- PASS [6] two competing proposals for one price: exactly one stays open :: This is not allowed in the proposal's current state (another || Proposal recorded. A different platform administrator must a
- PASS [6] stored sign counters are non-negative and the key set is [primary, recovery] :: primary:primary,recovery three:recovery
- PASS [8] control: monitoring expected AND available -> a proposal is accepted :: Proposal recorded. A different platform administrator must approve it within 24 hours; no price has changed.
- PASS [8] [table] monitoring table is unavailable
- PASS [8] [table] propose is refused :: The action failed. Nothing changed; reload and check the current state before trying again.
- PASS [8] [table] enrol request is refused (no pending row) :: The action failed. Nothing changed; reload and check the current state before trying again.
- PASS [8] [table] revoke is refused (the key stays active) :: The action failed. Nothing changed; reload and check the current state before trying again.
- PASS [8] [table] apply is refused (change stays pending) :: The action failed. Nothing changed; reload and check the current state before trying again.
- PASS [8] [table] FREEZE still works from the UI (safe direction) :: Price publication is suspended. It publishes nothing; lifting the suspension needs the hardware key.
- PASS [8] [table] thaw (safe direction) result is recorded :: Publication resumed.
- PASS [8] [table+emitter] monitoring table is unavailable
- PASS [8] [table+emitter] propose is refused :: The action failed. Nothing changed; reload and check the current state before trying again.
- PASS [8] [table+emitter] enrol request is refused (no pending row) :: The action failed. Nothing changed; reload and check the current state before trying again.
- PASS [8] [table+emitter] revoke is refused (the key stays active) :: The action failed. Nothing changed; reload and check the current state before trying again.
- PASS [8] [table+emitter] apply is refused (change stays pending) :: The action failed. Nothing changed; reload and check the current state before trying again.
- PASS [8] [table+emitter] FREEZE still works from the UI (safe direction) :: Price publication is suspended. It publishes nothing; lifting the suspension needs the hardware key.
- PASS [8] [table+emitter] thaw (safe direction) result is recorded :: Publication resumed.
- PASS [8] after the table is back the pending change applies :: Done: applied.
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
- PASS [10] fixture: [primary, recovery] active (recovery installed owner-level) :: recovered two:primary,recovery five:recovery
- PASS [10] the attacker holds the account (a separate session) and the ordinary keys
- PASS [10] attacker: the UI offers no recovery role :: spare,primary
- PASS [10] attacker: the server action with role=recovery returns no challenge :: 200 0:{"a":"$@1","f":"","q":"","i":false,"b":"mqL3WL7trQMSV4pyqY6oE"} 1:{"ok":false,"message":"The database refused the input (check the kind, t
- PASS [10] attacker: calling the database directly with the session token for role=recovery is refused :: 400 {"code":"22023","details":null,"hint":null,"message":"a recovery credential is never enrolled through an ordinary ceremony: it is installed 
- PASS [10] attacker: no recovery credential was added
- PASS [10] attacker with the primary key cannot retire the spare (a key retires only itself) :: The authenticator did not sign or the request failed. Nothing changed.
- PASS [10] attacker with the primary key cannot evict it either (needs the recovery key) :: The authenticator did not sign or the request failed. Nothing changed.
- PASS [10] owner evicts the stolen spare with the RECOVERY key through the UI (immediate) :: Revoked. This takes effect immediately and cannot be undone: a mistaken revocation is repaired only by enrolling a new key.
- PASS [10] attacker: the evicted spare cannot authorize the pending proposal :: The authenticator did not sign (cancelled, not available or not allowed). Nothing changed.
- PASS [10] owner freezes through the UI
- PASS [10] an ordinary key may lift an ordinary freeze (documented design) - outcome consistent with the DB :: Publication resumed.
- PASS [10] owner freezes with the RECOVERY key (hold) :: Publication is suspended.
- PASS [10] attacker with the ordinary keys cannot lift the recovery freeze :: Not allowed. Price changes need a registered administrator in a second-factor session; publication also needs a different session and the hardware key, and is refused while prices are suspended. Only an active platform administrator can do this, and a price change can never be approved by the admini
- PASS [10] attacker cannot retire the recovery key (not offered) :: The authenticator did not sign or the request failed. Nothing changed.
- PASS [10] attacker: a spare requested during the hold never becomes active :: request: Not allowed. Price changes need a registered administrator in a second | apply: NO ROW (TimeoutError: locator.click: Timeout 300)
- PASS [10] monitoring is expected AND unavailable
- PASS [10] owner starts the recovery with the recovery key during the outage (tolerant emit) :: Recovery requested. It completes only after the long delay, raises high-severity alerts, and only the recovery key can cancel it.
- PASS [10] owner completes the recovery during the outage; the whole ordinary set (attacker's keys) is replaced :: Done: applied. / owner recovered:primary
- PASS [10] attacker's old primary is dead after the recovery (not offered) :: The authenticator did not sign or the request failed. Nothing changed.
- PASS [10] owner lifts the suspension with the recovered primary (monitoring back) :: Publication resumed.
- PASS [10] the recovered owner proposes and authorizes a price again (monitoring expected and present) :: Authorized. The new price is published.
- PASS [11] login with a fresh TOTP (the session starts fresh)
- PASS [11] fresh session: the database accepts the credential-list RPC :: 200
- PASS [11] a TOTP verification 11 minutes old: the DATABASE refuses the authorize ceremony for freshness (a fresh token is refused for another reason) :: stale: 403 {"code":"42501","details":null,"hint":null,"message":"a fresh authenticator code is requir | fresh: 200 {"code": "22023", "reason": "unknown price proposal", "statu
- PASS [11] stale: a credential ceremony (thaw challenge) is refused for freshness too :: 403 {"code":"42501","details":null,"hint":null,"message":"a fresh authenticator code is required (the la
- PASS [11] stale: propose is refused by the database :: 403 {"code":"42501","details":null,"hint":null,"message":"a fresh authenticator code is required (the last one is too old or
- PASS [11] stale: the authorize-begin server action bounces the browser to the step-up page (reason=stale) :: 303 /platform-mfa/challenge?stepup=1&reason=stale&next=%2Fplatform%2Fsms;push
- PASS [11] stale: the plain-aal2 credential READ (panel list) is still served :: 200 
- PASS [11] stale: the propose form action is bounced to the step-up page and creates nothing :: 303 /platform-mfa/challenge?stepup=1&reason=stale&next=%2Fplatform%2Fsms;push
- PASS [11] stale (11 min old TOTP): the REAL freeze form action is not bounced to the step-up page and freezes publication (plain aal2) :: 303 /platform/sms?price=1#price-changes;push frozen=true
- PASS [11] stale: FREEZE still works (plain aal2, safe direction) :: 200 {"status": "frozen", "replayed": true}
- PASS [11] stale: report-compromise works (plain aal2) :: 200 {"status": "frozen", "rate_limited": false}
- PASS [11] step-up through /platform-mfa/challenge?stepup=1 with a new code succeeds :: http://localhost:3417/platform/sms
- PASS [11] after the step-up the same server action is served :: 200 
- PASS [11] after the step-up the database accepts the ceremony read again :: 200
- PASS [11] thaw (fresh tier) with the ordinary key after the step-up lifts the suspension :: Publication resumed.
- PASS [11] propose succeeds again after the step-up :: Proposal recorded. A different platform administrator must approve it within 24 hours; no price has changed.
- PASS [12] fixture: exactly one active signing credential :: owner recovered:primary
- PASS [12] UI: the last active signing credential cannot retire itself (nothing changes) :: The database refused the input (check the kind, the amounts, the lengths, and that the proposal differs from the active price). Nothing changed.
- PASS [12] a replacement is enrolled through the UI and applied after the delay :: Done: applied.
- PASS [12] once a replacement is active the old key retires itself through the UI :: Revoked. This takes effect immediately and cannot be undone: a mistaken revocation is repaired only by enrolling a new key.
- PASS [13] 13 compromise reports through the real form: every call is accepted and publication is frozen :: accepted=13
- PASS [13] exactly ONE freeze (one non-repeat freeze_set row); the 12 repeats add a bounded number of audited rows (at most 12 new rows) :: new rows=11, first-freeze rows=1
- PASS [13] repeat rows are capped at 10 per administrator and hour, and ONE audited rate-limited row records the dropped reports :: repeat/h=10 limited/h=1
- PASS [13] thaw after the report storm (fresh MFA, ordinary key) :: Publication resumed.
- PASS [13] a freeze right after the thaw is IMMEDIATE (never limited: a new plain freeze_set row, frozen) :: Price publication is suspended. It publishes nothing; liftin newRows=1
- PASS [13] left unfrozen
- PASS [9] built client output (.next/static, 111 files, 2.4 MB) contains none of the run's secrets :: {}
- PASS [9] security headers on the pricing page (CSP, nosniff, frame, referrer) :: x-content-type-options,referrer-policy,x-frame-options,content-security-policy
- PASS [9] CSP forbids framing, plugins and foreign form posts :: default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'self'; form-action 'self' https://checkout.stri
- PASS [9] Supabase session cookies are SameSite=Lax/Strict and path=/ (httpOnly is not set by @supabase/ssr by design; recorded) :: sb-127-auth-token:http=false,secure=false,ss=Lax
- PASS [9] no Content-Security-Policy violation in any browser console during the run
- PASS [9] all 129 user-visible messages are plain sentences (no SQLSTATE, token, stack or SQL text)
