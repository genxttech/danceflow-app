# TW-4F: minimal real-Twilio fixture validation (proposal)

Status 2026-11-14: **proposal only. Nothing has been created, bought, sent or spent.** This needs one owner authorization (§7) covering the provider operations and the spend cap below. It is separate from, and does not depend on, the hosted SQL package (`TW-4F_0217_0218_Apply_Package.md`).

## 1. Goal and scope

Replace the documented shapes (`fixtures/twilio/documentedShapes.json`) with real, redacted samples where a test number can produce them, and settle the open questions in `TW-4F_Twilio_Fixture_Capture.md` §3.

| §3 item | Closed by this validation? |
|---|---|
| 1. Exact bytes of a real subaccount's Message JSON (fields, nulls, `num_segments` on `accepted`) | **Yes**: inbound messages, and one outbound attempt. |
| 2. `DateSent>` / `DateSent<` with a full timestamp | **Yes**: one list read. A 200 settles it (twilio-node already sends this form). |
| 3. Price posting delay | **Partly**: inbound prices. |
| 4. A custom Advanced Opt-Out opt-in keyword arrives with `OptOutType=START` | **Yes**: one custom keyword is configured and texted. |
| 5. Production signature URL behind Vercel | **No**: that needs a DanceFlow-registered subaccount hitting the production route; it stays a separate activation check. |
| Delivered outbound sample | **No**: an unregistered 10DLC number cannot deliver (Twilio 30034). The documented shape stays. |

## 2. Consent safeguards

- **Phones:** the only phone involved is one the owner personally controls ("the owner phone"). No studio, client, contact or customer number, ever.
- **Who texts first:** the owner phone texts the test number first. The one outbound attempt goes only to the owner phone and says what it is: `DanceFlow fixture test. Reply STOP to opt out.`
- **No DanceFlow systems:** the test subaccount is **not** recorded in any DanceFlow database, and none of its webhooks point at a DanceFlow URL. Its inbound and status URLs are a TwiML Bin inside the same subaccount that returns `<Response></Response>`. No DanceFlow route, table or consent record is touched, so DEV and PROD consent state cannot change.
- **Twilio's own handling:** Twilio Advanced Opt-Out stays at its defaults on the test Messaging Service, so STOP, START and HELP are handled by Twilio exactly as for a real studio.
- **End state:** STOP is followed by a START keyword in the same session. Then the subaccount is closed (§6), so no opt-out or opt-in state outlives the test.

## 3. Provider operations

The **owner** performs these in the Twilio Console. Claude never uses the owner's credentials. Each step is listed with its cost.

| # | Operation | Cost |
|---|---|---|
| P1 | Create a subaccount "DanceFlow fixture capture (test)" under the parent account. | free |
| P2 | In it, create a TwiML Bin returning `<Response></Response>`. | free |
| P3 | Create a Messaging Service with the Bin as its incoming URL and status callback. Keep Advanced Opt-Out at default and add the custom opt-in keyword `RESUME`. | free |
| P4 | Buy **one** US local number in the subaccount and add it to the service. No A2P brand or campaign. | **$1.15** (one month) |
| P5 | From the owner phone, text the number in this order, about a minute apart: `see you thursday then` · `STOP` · `RESUME` · `HELP` · one photo with no text · `UNSTOP`. | 5 SMS + 1 MMS inbound, about **$0.09** |
| P6 | Send one message from the service to the owner phone (Console "Try it" / Messaging send), body as in §2. Expected: `undelivered`/`failed` with 30034 (unregistered). | at most about **$0.02** |
| P7 | Twilio Advanced Opt-Out confirmations (STOP, START, HELP replies). They may be blocked as unregistered; per Twilio support they are not billed. | $0 to $0.05 |

**Expected total: about $1.30. Hard cap: $5.00.** Stop at once if the Console shows anything above $5 or any charge type not listed here (for example a brand or campaign fee). No brand, campaign, toll-free verification, port or second number is part of this.

## 4. Capture (read-only, redacted before it is written)

1. **Message JSON and list pages.** The owner runs, in their own terminal, with the **test subaccount's** SID and Auth Token set only in that shell:

   ```
   TWILIO_CAPTURE_ACCOUNT_SID=AC… TWILIO_CAPTURE_AUTH_TOKEN=… npx tsx scripts/qa/tw4f/capture-twilio-fixtures.mts \
     --message inbound_ordinary=SM… --message inbound_stop=SM… --message inbound_custom_start=SM… --message inbound_mms=MM… \
     --message outbound_undelivered_30034=SM… --list-to +1<test number> --since <P5 start> --until <P6 end> \
     --webhooks <local pasted-webhooks.json> --out src/lib/sms/__tests__/fixtures/twilio/capturedShapes.json
   ```

   The SIDs come from the Console's message log. The script:
   - makes GET requests only, refuses any path outside that subaccount, and never prints a response;
   - redacts in memory (`src/lib/sms/twilioFixtureRedaction.ts`): consistent synthetic SIDs with the same prefix, 555-01xx numbers, bodies replaced except bare keywords, geo, media links and page tokens replaced;
   - refuses to write if anything identifying is left.
2. **Webhook parameters.** If the Console's message log shows the request Twilio sent to the Bin (Request Inspector), the owner copies each parameter set into a local JSON file outside the repo, keyed like `documentedShapes.json` `webhooks` (`inbound_stop_advanced_opt_out`, `inbound_start_custom_keyword`, `inbound_mms_no_body`, `status_undelivered_30034`), and passes it with `--webhooks`. It is redacted the same way. If the Console does not show parameters for a Bin target, this part is skipped and the documented webhook shapes remain. No DanceFlow route gains parameter logging.
3. **Review and merge.** Only the redacted `capturedShapes.json` is shared with Claude, which reviews it, runs the contract tests (they pick it up automatically) and opens a PR. Differences from the documented shapes are recorded in the capture document.

The Auth Token stays in the owner's shell. Closing the subaccount (§6) invalidates it.

## 5. Already built and tested (no provider calls)

- **The redactor** `src/lib/sms/twilioFixtureRedaction.ts`, tested in `twilioFixtureRedaction.test.ts` (6 tests: consistent identities, keyword-class bodies, same-length and same-encoding filler, geo/media/page-token/non-US numbers, an unlinkable run key, a residual check).
- **The capture CLI** `scripts/qa/tw4f/capture-twilio-fixtures.mts`. Without credentials it refuses to run (exit 2); it never overwrites an existing file.
- **A dry run:** the documented shapes were put through the redactor as if captured, saved as `capturedShapes.json` and run through the contract tests: 33 passed, 1 documented-only case skipped. The file was then deleted.

## 6. Cleanup (part of the same authorization)

After the capture and the owner's check that the redacted file was written:

1. **Close the test subaccount** in the Console. This releases its one number, ends the $1.15 monthly fee, and invalidates its Auth Token. The number was never attached to a studio and no customer depends on it, so this is not the routine cost-control release your rule forbids. It is named here explicitly for your decision.
2. Delete the local pasted-webhooks file.
3. Confirm in the Console that the parent account shows no other new resource and no charge above the cap.

If you prefer to keep the number for a later validation, skip step 1 and accept $1.15 a month until a separate decision.

## 7. Authorization requested (when this gate is reached)

Approve P1–P7, capture §4 and cleanup §6, with a **$5.00 cap**, performed by the owner in the Twilio Console with the owner phone only. This authorizes no DanceFlow SMS activation, no studio sender, no price publication and no other Twilio spend.
