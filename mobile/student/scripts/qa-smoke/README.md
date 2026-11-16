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
