# Student signed-in smoke run (QA only, Windows)

One command: disposable local stack, QA release build, emulator, magic-link sign-in, core screens at font 1.0 and 2.0 in light and dark, then teardown. Nothing is committed to shipping config: the QA build (cleartext HTTP to the local stack, a throwaway signing key, the placeholder Firebase file) happens in a separate git worktree and is reverted afterwards.

```bash
node mobile/student/scripts/qa-smoke/run.mjs
```

Takes about 20 minutes (stack ~5, build ~10, run ~5). Output (default `..\qa-smoke-out`, or `--out <dir>`): one screenshot per screen/size/theme, `gradle.log`, and `results.json`. Exit code 1 if anything failed.

## What it checks

| Check | Pass condition |
|---|---|
| sign-in via magic link | the app lands on a signed-in screen after the `danceflow://auth/callback` link |
| `settings`, `payment-requests`, `wallet` at 1.0 and 2.0, light and dark (12 rows) | expected text is on screen (`$40` for the seeded open request) and there is no crash or "isn't responding" dialog |

It is a smoke test: layout clipping still needs a look at the screenshots (the jest source scans in `src/components/__tests__` guard the code-level causes).

## Flags

- `--name <n>` stack name (default `stusmoke`); `--build-dir <path>` short real path for the build worktree (default `C:\dq`, not a `subst` drive); `--ref <ref>` what to build (default `origin/main`); `--avd <name>` (default `df-api35`).
- `--apk <path> --skip-build` reuse an earlier QA APK (it must point at `http://10.0.2.2:56600`).
- `--force` ignore a running java process or emulator. `--keep` skip teardown (debugging).

## Rules it enforces

It refuses to start if another `df-isoqa-*` stack, a java/Gradle process or an emulator is already running (this PC is shared: one stack, one build, one emulator at a time; never `gradlew --stop`). It uses `--no-daemon`, an empty TEMP (so Metro never reuses a stale cache), a throwaway keystore deleted afterwards, and always tears down (uninstall, font scale, night mode, error dialogs, emulator kill, stack down, mock stop, `.env` and manifest revert, build worktree removal if it created it).

## Files

- `run.mjs` the orchestrator. `seed.sql` the studio, client, linked account and two open payment requests (uses `session_replication_role = replica` because the baseline reward trigger breaks plain payment inserts). `mock-web.mjs` a stand-in for the few web API routes the signed-in screens call; wallet, schedule and profile reads go straight to Supabase.

## Not covered (still BLOCKED)

Event/Ticket (needs a seeded event and the real web API), partner photo upload, real push delivery, real payments, Android 12 and older, iOS. Manual steps and context: `docs/mobile/Student_Device_QA_R7.md`.

## Screen-reader tree audit

`run.mjs` also saves each screen's accessibility tree (`*.xml`, plus the signed-out `signin-screen.xml`) next to the screenshots. `node mobile/student/scripts/qa-smoke/a11y-audit.mjs <out-dir>` reports clickable nodes with no name (TalkBack would announce them as nothing), touch targets under 44dp and repeated labels, and writes the reading order of the main screens to `a11y-report.md`. It fails (exit 1) on an unnamed control. Findings and method: `docs/mobile/Student_TalkBack_Audit.md`.

## Event detail and Wallet ticket (`--events`)

`node mobile/student/scripts/qa-smoke/run.mjs --events` also applies `seed-event.sql` (a public event of the seeded studio, one ticket type, one confirmed and paid registration with ticket code `QA-DANA-0001`) and adds the `event-detail` and `event-ticket` screens to the matrix, so `a11y-audit.mjs` covers them too. Both screens read Supabase directly; the only web call is the ticket QR image, which `mock-web.mjs` answers with a 1x1 PNG. The seed's columns come from the live schema; the first `--events` run is what proves it. Running the real web app instead (`next build && next start` against the same stack, then `EXPO_PUBLIC_DANCEFLOW_WEB_URL` at it) is only needed for checkout, Pay Now and Stripe flows (BLOCKED without a Stripe TEST key).

## Verified-email claim QA (`--claim`)

`node mobile/student/scripts/qa-smoke/run.mjs --claim --name stuclaim --out <dir>` applies the claim migrations from git on the disposable stack only (`20270221090000` function, `20270222090000` exclusion, then from the PR 647 ref `20270222091000` plain index, which replaces the retired CONCURRENTLY file `20270221091000`, and `20270222092000` dancer views; `--cutover` also applies `20270222093000`, `--views-ref <ref>` names the ref that has them), creates a second dancer (Evan, `evan.other@example.test`), applies `seed-event.sql` and `seed-claim.sql`, and runs the claim scenario instead of the screen matrix: Dana signs in, opens Wallet and the tickets screen; Evan; Dana again after a cold restart (idempotence); offline; and finally the function dropped (missing-function case). Each step records the ticket codes seen, who owns each seeded registration, row counts of the must-not-change tables, and the claim calls seen in the stack logs. Plan and expected results: `docs/mobile/Student_Claim_Flow_QA_Plan.md`. Build the app from a ref that contains the claim call (`--ref origin/main` once PR 603 is merged). Hosted databases are never touched.

### Claim call counter and the font 2.0 / dark pass

`claim-call-counter.sql` is applied on the disposable stack by `--claim`: it renames the real function and puts a same-signature wrapper in front that inserts one row into `public.qa_claim_calls` (caller = auth.uid()) before running the real body unchanged. Cases 6 and 9b read that table. Never apply it to a hosted database.

`--claim-visual` (implies `--claim`) runs the claim flow (Create-password routing for an unbound user, Wallet, tickets) at font 1.0 and 2.0 in light and dark; see `docs/mobile/Student_Claim_Flow_QA_Plan.md`.

## Network preflight and baked-config check (RC4 finding)

RC4's Student smoke failed once at sign-in ("could not reach DanceFlow") and passed on retry: the emulator's Wi-Fi joins tens of seconds after boot and can flap for a few minutes. After install and before any sign-in, `run.mjs` now (1) waits for a `wlan0` address (up to 2 min), then (2) waits for a STEADY HTTP answer, confirmed by a second answer 15 s later (up to 8 min), from inside the emulator to the stack (`10.0.2.2:56600/auth/v1/health`) and to the mock web API (`10.0.2.2:8791/`), and fails with a named reason (`the emulator cannot reach the stack API at 10.0.2.2:56600`, with the last probe output) instead of as a sign-in failure. Before the emulator is touched it reads the Hermes string table of the APK's JS bundle and requires this run's stack URL and mock web URL (a stale port fails the run; a differing anon key is only a recorded warning, because it is sent as the `apikey` header and magic-link sign-in works with another stack's key). The helpers are the Business smoke's (`mobile/business/scripts/device-smoke-lib.js`), loaded by `scripts/qa-smoke/reachability.js`, not copied; the wait loops are unit-tested in `src/lib/__tests__/qaReachability.test.ts`.

The mock web API also answers `GET /api/student/events/{id}/availability` (the PR 650 shape: one limited ticket, 3 of 10 admissions left), and the `--events` matrix has an `event-availability` screen that expects "3 admission spots left" (event detail now takes its count from the web API, not from counting the dancer's registrations).

## Emulator System UI ANR, host memory, and more modes (2026-11-19)

- **System UI ANR.** RC5's smokes were lost to "System UI isn't responding" (package `android`) on the harness-booted emulator while another build was starving the PC of RAM (4.4 GB free). The harness now waits after boot for the guest's load average to settle (never fails the run), and when the dialog still appears it saves `systemui-anr-N-diag.txt` (load, memory, `top`, ApplicationExitInfo of `com.android.systemui`, ActivityManager warnings) BEFORE tapping "Wait", counts it, and records it in `results.json`. It is never hidden. It also writes `host-memory-before-boot/after-settle/end.txt` (free RAM and the biggest process groups) so an ANR can be classified as environmental or harness-fixable. A clean run on 2026-11-19 had 3 to 5 GB free and no ANR.
- **`--claim-withheld`**: Gate 1 as on PROD (`20270222090500` revokes execute). The claim RPC must answer 403 / 42501 over HTTP, and the app must stay silent (no error wording, no crash, nothing claimed).
- **`--real-web`** (with `--events`): serves the repo's REAL Next.js routes (`next dev` on the mock port, pointed at the stack) instead of `mock-web.mjs`; gives the ticket type capacity 4 so the real availability route must answer remaining 3. QA only; `next dev`, not a production build.
- `density.txt` was never written (a regex lost its backslashes); fixed.

## Past-events regression smoke (`--past-events`)

`node mobile/student/scripts/qa-smoke/run.mjs --past-events --name stup --out <dir>` (applies the dancer views too). After sign-in it seeds `seed-past-events.sql` (9 events relative to the stack's clock, each in its own time zone) and reads the live screens: Events list (Upcoming default), home and Saved (saved ended event absent), studio Events, the Past segment (ended only, newest first), an ended event by direct link and its register link ("This event has ended", no checkout), history (wallet ticket `QA-PAST-0001`, Tickets & registrations still show the ended event), and the zero-upcoming empty state ("No upcoming events" + hint).
The Pacific/Auckland (UTC+13) and Pacific/Honolulu (UTC-10) rows that end 25 minutes ahead / 30-60 minutes ago are the on-device check that Hermes/Android `Intl` honours the event's time zone: a reader that ignores the zone gets at least one wrong. Fixed-date New York rows cover the DST edges (2026-11-01 01:30 ambiguous, ended; 2027-03-14 02:30 missing, upcoming until then; the expectation flips after that date). Receipts/orders for an ended event are NOT seeded and are recorded as BLOCKED, not passed. A deliberate DST *transition* against the live clock cannot be exercised on the emulator (the stack's tokens need the real clock); the DST rules are proven by the Node parity test (`eventTimingParity.test.ts`) only.

## Session-restore diagnostic (`--session-diag`)

`node mobile/student/scripts/qa-smoke/run.mjs --session-diag --name stus --ref <ref> --out <dir>`: signs in, then kills the app five ways and checks whether Today still shows after relaunch: (1) the harness's `am force-stop`, (2) a user's swipe-away in Recents, (3) Home then `am kill` (the system's background kill), (4) an emulator reboot with the app launched as soon as boot completes (records wlan0 at launch), (5) an offline start (airplane mode), then network back and another start. Each step records the process id before/after (proof the kill happened), the relaunch logcat, and, only when the emulator image is rootable, the NAMES of the secure-storage keys holding the session (never values; otherwise UNVERIFIED).

## Past registrations (`--past-registrations`)

`node mobile/student/scripts/qa-smoke/run.mjs --past-registrations --name stur --out <dir>`: seeds `seed-past-registrations.sql` (ended registrations: with a ticket, WITHOUT a ticket, cancelled + refunded, 13 more so there are 16 > 12, one upcoming, and a PRIVATE ended event as a probe) and reads Tickets & registrations through the real dancer views and events embed: Upcoming unchanged, Past events below, 12 then "Show more (N more)", status wording (`refunded`, `Registration`), tap-through to the ended event ("This event has ended", no register action), Wallet event tickets unchanged, then font 2.0 + dark with the Show more touch target. Because the registrations and the events embed are read from the real stack database, a PASS here is also the real-DB proof that no SQL is needed for the event's end date/time/zone.
