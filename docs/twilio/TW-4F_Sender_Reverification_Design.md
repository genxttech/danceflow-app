# TW-4F automated sender re-verification (design, 2026-10-21)

Owner handoff "DanceFlow TW-4F — Automated Sender Re-Verification" (2026-10-20). Every approved billed SMS sender is re-checked against Twilio at least once inside its 24-hour trust window. This uses the PR #249 readiness model (`studio_sms_billed_senders`, `studio_sms_sender_verifications`, `_tw4sr_judge`, `_tw4sr_ready`) and the PR #250 run lease. There is no second registry and no new readiness rule.

It is local and synthetic only: no hosted SQL, no registered cron, no Twilio write, no SMS. Migration `20261206090000_twilio_sender_reverification.sql` (after `20261205090000`), rollback in `rollback/`.

## 1. Trust and expiry (unchanged, fail closed)

- A sender can send only while `_tw4sr_ready` answers it. That requires:
  - the latest row is `approved`;
  - the latest *decisive* verification is `verified` for exactly its identifiers;
  - that verification is **no older than 24 hours**;
  - the account is the business's active subaccount;
  - the verified campaign use case matches the location's current path.
- Nothing in this slice writes or extends that window. A failed, delayed or stopped scheduler only lets it run out. `tw4_usage_begin` then refuses (`TW015`), and `tw4_usage_dispatching` releases any still-unmarked reservation (`sender_not_ready`: definitively never sent). A marked or uncertain attempt is never released (PR #250 reconciliation handles it).

## 2. What is re-checked, and how

The work list (`tw4_sender_due_reverify`) holds approved current senders whose last decisive success is older than 20 hours, oldest (and expired) first. A sender whose latest decisive verification **failed** is not on it. The scheduler never restores a failed sender: only a platform admin's verification can.

For each one the server makes read-only GETs **with the subaccount's own token**: the existing `messagingTokenProvider`, which re-reads on 401 rotation and never falls back to parent credentials. The identifiers always come from the database's sender row, never from a tenant. The reads cover:

| Check | Read |
|---|---|
| Subaccount ownership and active status | Account (`status = active`) and the business's active subaccount in the DB |
| Messaging Service exists on that subaccount, A2P registered, inbound routed to DanceFlow | Messaging Service |
| Campaign identity, `VERIFIED`, not mock, use case = location path; brand approved and the business's own | Campaign, Brand, runner's B1 step |
| Number owned by the subaccount, SMS-capable, in use, correct E.164 | IncomingPhoneNumber |
| Number is a member of the Messaging Service | Service PhoneNumber |
| Legal business, studio and location | DB: sender row ↔ entity_studios ↔ active subaccount |
| Revocation, suspension, reassignment | any of the above no longer matching → failed |
| Advanced Opt-Out | Console-only setting, so the platform admin attests it at verification; the scheduler carries the attestation over from the last admin verification. Inbound routing (`inbound_route_ok`) is verified from Twilio. |

The database judges the normalized evidence (`_tw4sr_judge`). The caller's opinion is never used.

## 3. Outcomes

| Evidence | Outcome | Effect |
|---|---|---|
| Everything matches | `verified` | A new `approved` row carries the new verification; trust restarts for 24 h |
| Definitive mismatch: campaign not VERIFIED (rejected, suspended), number not in the service, number on another account or with another E.164, service on another account, brand not the business's, mock, use case, subaccount not active, 404/403/unreadable | `failed` | **Not ready at once**; new reservations refused; listed for an admin; never restored automatically |
| Transient: timeout, network, 5xx, 429 rate limit, subaccount token unavailable | `inconclusive` | Last success kept (not revoked); recorded; **trust not extended**; retried with backoff 5 min × 2^(n−1), at most 30 min |
| A 30034 delivery callback (PR #249) | `failed` (`callback:30034`) | Not ready at once; restored only by an admin |

Contradictory or unknown evidence fails closed: any read error that is not transient fails the verification.

## 4. Runs, concurrency, audit

- `/api/cron/sms-sender-reverify` returns 404 unless `SMS_SENDER_REVERIFY=on`, then requires `CRON_SECRET`.
- It takes the shared lease `studio_sms_reconcile_runs` (job `sender_reverify`, 120 s, independent of `usage_reconcile`). An overlapping call is `busy`.
- Each run covers at most 50 senders within 45 s. Every write goes through `tw4_sender_reverify_run`, which is fenced: a lost lease gives `TW023` and the run stops. A crashed run is closed as failed by the next begin.
- Duplicate attempts for one sender serialize on the studio lock; the second is `skipped`, because the sender row has moved on.
- Audit:
  - every attempt is an append-only `studio_sms_sender_verifications` row;
  - `studio_sms_onboarding_audit` records `sender_verified`, `sender_verify_failed` and (new) `sender_reverify_inconclusive`;
  - every run is recorded with counts only.
- The PR #249 `tw4_sender_reverify` keeps its service-role grant. It is idempotent, serialized by the studio lock and never restores a failed sender, and the scheduler uses only the fenced entry point. Revoking it was tried: a call through PostgREST then crashed the local Postgres backend (signal 11), so it was not shipped. See §7.

## 5. Platform-admin visibility

`tw4_sender_health(actor)` returns, per linked studio:

- state: `ready`, `expiring` (< 4 h left), `expired`, `failed`, `blocked`, `pending`, `revoked`, `released` or `none`;
- `blocked` (true for anything but ready or expiring);
- last success, trusted-until and next scheduled check;
- the decisive and last-attempt outcomes and codes;
- retries since the last success.

It also returns the scheduler's last completed run, its runs, counts, and a **stale** alert (an approved sender exists and no run has completed in 2 hours).

The sender-identity block on the subaccount panel shows the state badge (green only for ready or expiring, never when health is unavailable), one guidance line with the next action (verify, wait, provider action or investigate), timing details behind a disclosure, and the existing Verify form ("Re-check now" for an approved sender: the safe manual re-verification, platform admin, rate limited, attestation required).

## 6. Rollback

`rollback/20261206090000_…` restores the 20261204 work list and the audit vocabulary, and drops the fenced entry point and the health read. It **refuses** once any `sender_reverify` run or inconclusive audit row exists. Readiness is untouched in both directions.

## 7. Notes and limitations

- The scheduler re-checks only approved senders. Pending senders need an admin verification with the attestation.
- An expired sender (trust lapsed during an outage) is restored by the next successful scheduled check. Expiry is not a revocation. A failed one is not.
- Twilio cannot report the Advanced Opt-Out Console setting. The attestation is a human statement and the end-to-end STOP/START/HELP check remains an activation step.
- **Local QA database incident (2026-10-21, 01:09–01:21 UTC).** The local Postgres backend segfaulted 7 times when the service role called a function whose EXECUTE had just been revoked. It recovered automatically each time. The revoke was removed. Before any hosted change that revokes a function an API role calls, confirm in a disposable environment that "permission denied" is returned rather than a crash.

## 8. Independent Opus security review (2026-10-21): what changed

The review found no P0. These changes are authoritative where they differ from §2–§7.

- **P1, starvation.** The work list puts senders that are still trusted first, nearest deadline first. Expired senders come after them, fewest retries first, so a few unreachable expired senders can no longer use up every run while healthy ones lapse.
  - Expired senders back off 30 min × 2^(n−1), at most 6 h (trusted ones: 5 min × 2^(n−1), at most 30 min).
  - The recommended schedule is **every 15 minutes**: "*/15 * * * *".
- **P1, a transient read hiding a definitive failure.** `_tw4sr_judge` was replaced: first any definitive read error (404, 403, unreadable), then every check on the resources that **were** read. Only then does a transient read error give `inconclusive`. A resource that was not read (JSON null) counts as absent, so it is not judged.
- **P2, a scheduler that checks nothing looked healthy.** A run with no read provider, no inbound URL or a failing work list is recorded as **failed** (route 500). The stale alert then fires.
- **P2, guidance.** "Credentials unavailable" says investigate, not wait. Failing re-checks show in the headline while the sender is still trusted.
- **P2, restore after expiry.**
  - Trust that lapsed more than **72 hours** after its last success (48 h after expiry) is never restored by the scheduler: it is off the work list, and the fenced entry point answers `skipped / lapsed_needs_admin`. A person verifies, with the attestation.
  - A restore after a shorter lapse is audited separately (`sender_reverify_restored`).
- **P3, direct calls.**
  - `tw4_sender_reverify` (replaced) refuses outside a scheduler run: it needs the per-transaction flag that only `tw4_sender_reverify_run` sets (42501). Its grant is unchanged, because a revoke crashed the local backend (§7).
  - The health read shows a run as running only while its lease is live. The "blocked" guidance covers every cause.
- **Accepted:** the time budget is checked between senders, so a run can overrun by up to one sender's reads. That is harmless: the lease is closed by the next run.
