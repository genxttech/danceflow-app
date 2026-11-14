# TW-4F: Twilio message fixtures (documented now, captured at activation)

Status 2026-11-14: **documented shapes in Git; no captured sample exists.** This document covers what is checked in, what it proves, what it cannot prove, and how real samples are captured and redacted when live validation is authorized. Capturing a sample needs a real message, so it waits for that authorization (no send, spend or hosted change is authorized by this document).

## 1. What is in Git

`src/lib/sms/__tests__/fixtures/twilio/documentedShapes.json` holds Twilio's documented response and request shapes, taken from the public reference on 2026-11-14 (Message resource fetch, list and create; the incoming-message webhook parameters; the status callback guide; Advanced Opt-Out `OptOutType`). Each object carries the full documented field set, including the fields DanceFlow ignores (`uri`, `subresource_uris`, `api_version`, the geo fields, `SmsSid` and `SmsMessageSid`, `RawDlrDoneDate`). Nulls, types and formats are as documented:

- dates are RFC 2822 (`Sat, 14 Nov 2026 15:00:00 +0000`);
- `price` is a negative decimal string, or `null` until Twilio posts it;
- `error_code` is an integer;
- `num_segments` is a string;
- paging uses `next_page_uri` with encoded filters and a `PageToken`.

Every SID, number and body in the file is synthetic: numbers are in the 555-01xx fiction range, and SIDs are repeated hex. The file is labelled `DOCUMENTED SHAPE, NOT CAPTURED TRAFFIC`.

Tests that use it:

| Test | Proves |
|---|---|
| `src/lib/sms/__tests__/twilioDocumentedShapes.test.ts` | The real adapter (`RealBilledSmsProvider`) turns each documented Message into the evidence the database parses: ISO instants, segment and price text, identity, and no body. The inbound list follows Twilio's own `next_page_uri` on api.twilio.com, keeps only `inbound`, and skips Advanced Opt-Out's `outbound-reply` confirmation. A next page for another account is refused. Recovered bodies classify fail-safe. Consent order uses Twilio's times. Every documented status has exactly one outcome in `tw4_usage_settle` (charge, release or wait); inbound-only and deprecated statuses go to review. |
| `src/app/api/sms/twilio/__tests__/subaccountWebhooks.tw4f.test.ts` (block "documented Twilio webhook requests") | The documented inbound and status parameter sets, signed with the subaccount token, go through the real routes. An Advanced Opt-Out STOP or START is applied silently, and START records its signal by MessageSid. An MMS with no text changes no consent. Callbacks out of order never move a log back. `30034` reaches the billing recorder. A suppressed log is never changed. |

When `fixtures/twilio/capturedShapes.json` exists (same keys), the adapter and list cases also run against it automatically.

## 2. Defect found and fixed with these shapes

Twilio documents that status callbacks are not guaranteed to arrive in order. Before this change, the status route applied any callback, so a late `sent`, `sending` or `accepted` after `delivered` moved the message log back to `sent` or `queued`, and `delivered_at` stayed set. Billing was not affected: `tw4_usage_record_callback` already ranks statuses, and settlement reads the Message resource. Nothing re-sends from `sms_message_logs`: the dispatcher's `queued` queries are on `outbound_deliveries`.

The route now refuses to move a log backwards (`smsLogStatusesReplaceableBy`), and the same condition is repeated in the update to cover races:

- a final status (delivered or failed) is replaced only by another final status;
- `sent` is never replaced by `queued`;
- suppressed and inbound logs are never changed by a callback.

`canceled` now maps to `failed`, and `read` to `delivered`, matching the database table. App-only, no SQL.

## 3. What documented shapes cannot prove (still open before activation)

1. **The exact bytes a real subaccount returns:** field order, extra undocumented fields, and whether `num_segments` is `"0"` or `"1"` on an `accepted` Messaging Service send.
2. **How `DateSent>` / `DateSent<` treat a full timestamp.** The documented form is `YYYY-MM-DD`; DanceFlow sends `YYYY-MM-DDThh:mm:ssZ`, which is the form Twilio's helper libraries send. If Twilio only honours the date, the listing is wider (harmless: every caller filters exactly again). If Twilio rejects it, recovery fails closed (`usage_evidence_http_400`, checkpoint unchanged). A captured list request settles which.
3. **Price posting delay.** How long `price` stays `null` after `delivered`. Settlement charges by segments, not price, so this affects only the price sanity check.
4. **Advanced Opt-Out custom keywords:** that a custom opt-in keyword really arrives with `OptOutType=START` (the START signal from 20270218 depends on it).
5. **Production signature URL.** That the URL Twilio signs for a subaccount webhook equals `resolveTwilioSignedUrl` behind Vercel (www host, no redirect).

## 4. Capture procedure (only inside an authorized live validation)

Prerequisites, each of which needs its own owner authorization: hosted SQL for the TW-4F chain, a real subaccount and number, and a validation send. Capture during that validation. **Never capture production customer traffic.**

1. **Message resource:** a read-only `GET /2010-04-01/Accounts/{sub}/Messages/{sid}.json` as the subaccount for the validation text, captured once while `accepted` or `queued`, once at `sent`, and once at `delivered` or `undelivered`. Reads are free and need no send authorization beyond the validation text itself.
2. **List page:** one `GET …/Messages.json?To={sender}&DateSent>={t}&DateSent<={t}&PageSize=2` with a full timestamp. Save page 0 and the page its `next_page_uri` returns.
3. **Webhook requests:** the form parameters of one inbound STOP, one START, one HELP and one status callback per status, from the Twilio Console message log or request inspector, where the Console shows them. DanceFlow's routes do not log parameters, and no capture logging is to be added to production routes.
4. **Redact before anything is saved in the repo:**
   - Replace every phone number with a 555-01xx number, used consistently (the same real number always becomes the same fiction number).
   - Replace every SID with a synthetic one of the same prefix and length, used consistently, so identity checks still hold.
   - Replace each body with text of the same keyword class, encoding and length (a GSM-7 STOP stays a GSM-7 STOP).
   - Drop `MediaUrl*` values.
   - Remove any token, signature, cookie or header.
   - Keep every field name, null, type and date format exactly as captured.
5. **Save** as `src/lib/sms/__tests__/fixtures/twilio/capturedShapes.json`, with the keys of `documentedShapes.json` and `_provenance.kind = "CAPTURED, REDACTED"` plus the capture date. Run the two test files above, then record any difference from the documented shapes in this document before activation.
