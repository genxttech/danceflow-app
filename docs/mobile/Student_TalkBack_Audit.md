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
| Event detail (event-detail, 1.0/2.0, light/dark; run `--events`, 2026-11-16, `C:dfr-outwallet-ticket2`) | 0 unlabelled in all 4 trees. Harness: 3 of 4 renders PASS; **event-detail-1.0-light FAIL**: the first screen opened after sign-in showed "Event unavailable / This event could not be loaded" with Try again (named, retry works as designed). Intermittent, cause not proven (suspected first deep-link open racing the fresh session); not re-run |
| Wallet ticket screen (event-ticket, 1.0/2.0, light/dark, same run) | PASS 4/4: ticket rendered for the `user_id`-owned registration, 0 unlabelled controls, 0 small targets. Reading order of the ticket card not reviewed by TalkBack gestures (BLOCKED); jest `eventTicketScreen.test.tsx` covers one named stop per ticket |
| Discover | Not in this run (the harness covers Settings, Payment Requests and Wallet); covered by the source scan in `accessibilityAudit.test.ts` |
| One harness check, Payment Requests 1.0 dark, missed the `$40` text in the dump (timing); the same screen passed at 2.0 dark and in light, so treated as a flake | noted |

## Re-check of the notification switches on device (2026-11-16, build with #560)

The row-level nodes are named and report state in the real tree ("Push notifications", "Schedule updates", ... as `android.widget.Switch` with `content-desc`, correct `checked`, `enabled` false until push is on). The inner native Switch still appears in the uiautomator dump as an unnamed `NAF` node because uiautomator also lists views hidden from screen readers; it is marked `importantForAccessibility="no"`. `a11y-audit.mjs` now reports an unnamed control inside a named control as "nested", not as a failure. Whether TalkBack skips it is a gesture check, still BLOCKED.

## Ticket finding (row-level security)

The first `--events` run showed "No event tickets yet". Cause, proved on a throwaway stack: a buyer can read an `event_registrations` row only when `user_id = auth.uid()` (`event_registrations_self_select`), and its `event_registration_attendees` only when the registration's `user_id` or `portal_user_id` is theirs (`..._self_select`). There is no policy by `attendee_email` or by the client link, so the app's lookups by email and `client_id` return only rows RLS already allows. The seed left `user_id` null; with `user_id` set the dancer sees 1 registration and 1 attendee. The seed is fixed (`seed-event.sql` takes the account id). **Open question for web/G-02:** a registration with no `user_id` (studio-created, guest checkout before the account exists, spectator or vendor ticket bought as a guest) will not show in the Student app; confirm `user_id` is set at purchase or backfilled when the account is created or verified.

## Fix

`NotificationPreferencesCard`: each preference row is now one `switch` element named by its title, with the detail as the hint and `checked`/`disabled` state; the native Switch inside is hidden from accessibility so it is not a second, unnamed stop. The master "Push notifications" row is the same. Jest: `notificationCard.test.tsx` (names every switch, reports state, no unnamed duplicate; 7 switches = master plus six categories).

## Notes

- The tab icons render a glyph with no text of their own; the tab buttons carry the label, so TalkBack reads the label.
- iOS: see `Student_iOS_Readiness.md`; live-region announcements are handled by the `Announce` component (#557).
