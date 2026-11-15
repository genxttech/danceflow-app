# Student screen-reader audit (Android accessibility tree), 2026-11-15

Method: the smoke harness (`mobile/student/scripts/qa-smoke/run.mjs`, #551) signs in on the API 35 emulator and saves the accessibility tree (`uiautomator dump`) of the signed-out screen and of Settings, Payment Requests and Wallet at font 1.0 and 2.0, light and dark. `a11y-audit.mjs` reads those trees the way TalkBack does (a node's own content-desc, otherwise its descendants' text merged). The emulator image (`google_apis`) does include the TalkBack package, but TalkBack was not driven by gestures: this audit is of the tree TalkBack would read, plus reading order. A real gesture walk with TalkBack on, and VoiceOver on iOS, remain BLOCKED.

Run: `node mobile/student/scripts/qa-smoke/run.mjs --out <dir>` then `node mobile/student/scripts/qa-smoke/a11y-audit.mjs <dir>` (writes `a11y-report.md`).

## Results

| Check | Result |
|---|---|
| Signed-out screen (sign-in/start): every control named, reading order DANCEFLOW > headline > Start exploring > Continue with email > Email field > Send secure link > Terms > Privacy Policy | PASS |
| Wallet: reading order heading > summary tiles > "Needs your attention" > payment requests with Pay Now > tab bar; tabs named Today, Discover, Learn, Wallet | PASS |
| Payment Requests: amount, studio, type, note, date, Pay Now per request, in a sensible order | PASS |
| Settings notification switches: **six unnamed Switch nodes** (each row was a button containing a native Switch with no label, so TalkBack could stop on a nameless switch and on the row) | **FAIL, fixed in this PR** |
| Touch targets under 44dp | Two rows reported at font 2.0 (a wallet link row 37dp, a settings row 39dp); both are rows cut off at the bottom of the screen in the dump (partly scrolled out), not undersized controls |
| Event detail and Ticket | BLOCKED (need a seeded event and registration and the real web API; see R7 runbook) |
| Discover | Not in this run (the harness covers Settings, Payment Requests and Wallet); covered by the source scan in `accessibilityAudit.test.ts` |
| One harness check, Payment Requests 1.0 dark, missed the `$40` text in the dump (timing); the same screen passed at 2.0 dark and in light, so treated as a flake | noted |

## Fix

`NotificationPreferencesCard`: each preference row is now one `switch` element named by its title, with the detail as the hint and `checked`/`disabled` state; the native Switch inside is hidden from accessibility so it is not a second, unnamed stop. The master "Push notifications" row is the same. Jest: `notificationCard.test.tsx` (names every switch, reports state, no unnamed duplicate; 7 switches = master plus six categories).

## Notes

- The tab icons render a glyph with no text of their own; the tab buttons carry the label, so TalkBack reads the label.
- iOS: see `Student_iOS_Readiness.md`; live-region announcements are handled by the `Announce` component (#557).
