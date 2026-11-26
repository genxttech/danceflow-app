# DanceFlow Student: internal tester message and smoke

2026-11-20. For the owner to forward as-is (part 1), plus the engineering watch list (part 2) and housekeeping (part 3). Version under test: DanceFlow (Student) 0.1.0, version code 1, Play internal testing.

## 1. For testers (forward this)

**Message**

> Hi! Thank you for helping test the new DanceFlow app for dancers. It takes about 10 minutes.
> 1. Open this link on your Android phone and tap "Become a tester", then "Download it on Google Play": **[opt-in link from Play Console]**
> 2. Install the app and go through the 8 steps below.
> 3. Reply to me with the answers listed at the end. Even "everything worked" helps.
> Nothing you do in the app charges you anything during this test. If something looks wrong, a screenshot is the most useful thing you can send.

**The 8 steps** (write down "worked" or "didn't work" for each)

1. **Install.** Install from the link above and open DanceFlow. Does it open to a sign-in screen?
2. **Sign in.** Enter your email and ask for a sign-in link. Open the email on the same phone and tap the link. Does the app open and sign you in? (If the email is slow, wait a minute and tap "Try again" in the app.)
3. **Wallet.** Open Wallet. Do you see your tickets and registrations (or a clear message that you have none)?
4. **Ticket.** Open a ticket. Does a QR code show, and is it easy to read at full brightness?
5. **Event spots.** Open an event and look at the ticket choices. Does each ticket say how many spots are left, or "Sold out"? Does the wording make sense?
6. **No connection.** Turn on airplane mode, then open the app or pull down to refresh. Do you see a friendly message such as "You're offline" with a way to try again, and no strange or technical text? Turn airplane mode off and tap "Try again": does it recover?
7. **Settings.** Open Settings and tap each link: Terms, Privacy Policy, Help, Security, and "Delete my account". Does each open a web page? (The delete-account page may not be live yet; if you see "page not found" there, just tell me. That one is expected.)
8. **Sign out and back in.** Sign out, then sign in again. Do you see your own tickets again, and nothing from anyone else?

**What to send me**

- Your phone model (for example "Pixel 7") and Android version (Settings > About phone).
- The app version: Settings in the app, or Play Store > DanceFlow. It should say **0.1.0**.
- For each step: worked / didn't work.
- For anything that didn't work: a screenshot, and what you tapped just before.

## 2. What engineering watches after testers open the app

Engineering has no log access: the owner runs the log queries or shares screenshots. Nothing here changes data. Tester reports and Play vitals are the only crash signal (the app ships no crash SDK).

| Signal | Where | What a result means |
|---|---|---|
| **View reads** (the Gate 2 precondition): requests to `/rest/v1/my_event_registrations*` from `supabase-js-react-native` | Supabase Logs Explorer on `edge_logs` (owner-assisted), or `view_reads.calls` in `gate2_prereq_evidence.sql` (`docs/events/event-registration-claim-release-package.md`, P3(c)); the PROD baseline before any Student build was `view_reads.calls = 0` (2026-11-19) | Above 0 from the Student client: the build reads the views, so the Gate 2 precondition is met. Still 0 after testers opened Wallet: the build is not reading the views (or the testers did not reach Wallet); do not proceed to Gate 2, ask a tester to confirm step 3 |
| **Availability route status mix**: `/api/student/events/*/availability` | Web logs (Vercel). Note: `/api/staff` and other newer routes can 404 on the live line until the web release | Mostly 200: step 5 works. A few 429 or 401: normal (rate limit, signed out). Many 404 or 500: testers see no spot counts or an error on event pages; the web release behind it is not live or is failing |
| **Claim RPC**: `claim_my_event_registrations` answering 42501 | Supabase API logs | Expected, **not a defect**, until Gate 2 activation: the function is not executable by any client, and the app treats any error as "claimed nothing" with no message. A count of 0 means the app has not reached the claim yet, or the activation has already happened. Any other error code is unexpected: report it |
| Unexpected 4xx/5xx on `/rest/v1/event_registration*` | Supabase API logs | Should be rare. A cluster means a policy or view problem; correlate with tester reports of an empty Tickets screen, which is a Gate 2 **stop** signal |
| Crashes and ANRs | Play Console > Android vitals for the internal track; the pre-launch report if generated | Any crash on 0.1.0 (version code 1) is a defect to fix with version code 2 |
| `/api/student/profile`, `/api/student/studio-links` | Web logs | Same reading as the availability route |

An empty Tickets screen reported by a tester who has tickets, or `view_reads.calls` staying at 0, is a stop signal for Gate 2.

## 3. Housekeeping

- **Keep** (outside the repo): `C:\dfr-out\release\student-f5f31103.aab`, plus a record of its SHA-256 `f67a39a52d15f503b79f62a408746da4f8592e6566320a3830a2bee31b8fbda7`, commit `f5f31103f2ed` and version code 1 (also recorded in `Student_Release_Package_Internal_Testing.md` and `Google_Play_Internal_Testing.md` section 11). Play never deletes a version code; this AAB is the only copy of what testers have.
- **Delete later, not now:** `C:\dfr\rel-student` (about 5.8 GB worktree) and its private TEMP `C:\dfr\tmp-rel-student-f5f31103`, only after the owner confirms the hash and commit are recorded. They are not needed to keep the AAB.
- **Next upload needs version code 3** (version codes 1 and 2 are used; the repo is at 3 as of the bump PR, so a rebuild of an already uploaded code needs another bump). Any rebuild of the same commit also needs a higher version code; `versionCode` is set in two places, `mobile/student/app.json` and `mobile/student/android/app/build.gradle`, so raising it is a repo change that goes through a PR first.
- The upload-key pin matched: the Console's upload-key SHA-256 equals `12:E5:24:0E:...:A1:EE:AF` (`docs/mobile/tools/upload-cert.json`).
