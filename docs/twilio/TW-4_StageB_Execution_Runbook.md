# TW-4 Stage B execution runbook (preparation record)

Status: PREPARED, NOT AUTHORIZED. Stage B and Stage C remain unauthorized until the owner gives separate written authorization and personally types the `authorize-b` phrase at run time. Production stays on the currently promoted deployment (`dpl_9JYuwjxf9ikjac3VtS8PSWhEZD2x`); the merged main build (`419e5b5f`) is not promoted.

No step in this document contacts Twilio, creates a resource, or touches DEV/PROD. Nothing here needs a Twilio credential.

## 1. What Stage B is

Stage B runs the real ISV adapter against Twilio for steps **S1–S10 only**, with the GenX TotalTech LLC test entity under the approved Primary (ISV) profile, in an isolated local database. It creates **draft** Trust Hub resources and asks Twilio to **evaluate** them. It never submits anything for review (S11 and later belong to Stage C, which is mock-brand only and separately authorized). Purpose: prove that key-signed writes, the payload shapes and the evaluation response work against the real service before any real studio is onboarded.

## 2. Owner-filled business file

1. Create a private copy outside the repository (restricted to your Windows user; refuses to overwrite):
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tw4-validation\new-business-file.ps1`
   Default location: `%LOCALAPPDATA%\tw4-validation\private\genx-business.json`.
2. Edit it and replace every `<placeholder>`.
3. Check it (local only; prints field names and rules, never values, so the output is safe to paste into a chat):
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tw4-validation\check-business-file.ps1`
4. The launcher re-validates the same rules and refuses a file located inside the repository, a file holding a placeholder, an unknown field, or an `ein` field.

### Fields and rules (same code as the onboarding wizard: `validateDraftFields`)

| Field | Rule |
|---|---|
| `legal_name` | 2–200 chars, exactly as on the IRS letter |
| `entity_type` | `llc`, `corporation`, `partnership`, `non_profit`, `cooperative` |
| `industry` | `EDUCATION` or `CONSUMER` |
| `website_choice` | `danceflow` or `own`; `own` requires `website_url` (https, ≤300 chars) |
| `website_url` | optional unless `own` |
| `address_line1` | 3–200 chars (a PO box only warns) |
| `address_line2` | optional |
| `city` | 2–100 chars |
| `region` | valid 2-letter US state code |
| `postal_code` | `12345` or `12345-6789` |
| `rep_first_name`, `rep_last_name` | required, ≤100 chars |
| `rep_title` | 2–100 chars |
| `rep_position` | `ceo`, `director`, `gm`, `vp`, `cfo`, `general_counsel`, `other` |
| `rep_email` | valid email (free-mail address warns) |
| `rep_phone` | valid US mobile number |
| `preferred_area_code` | 3 digits, first digit 2–9 |

The EIN is **not** a field. It is typed into a hidden prompt (9 digits, `12-3456789`) and held in memory only.

## 3. What can be verified from the approved Primary profile vs. what must be supplied

The read-only Stage A probe confirmed the Primary profile is `twilio-approved` under the ISV policy, so it can verify (as readable facts, not values to copy blindly):

| Verifiable from the Primary profile | Supplied independently by the owner |
|---|---|
| Profile exists, status `twilio-approved`, correct policy | Exact legal name as on the IRS letter (Twilio shows "Genx TotalTech LLC"; capitalization may differ from the IRS letter) |
| Name shown at Twilio (compared by Stage A `-CompareLegal` without printing) | EIN (the probe can only report match / no match, never the number) |
| Business type "Limited Liability Corporation" and industry TECHNOLOGY on the profile | Physical street address, city, state, ZIP |
| | Authorized representative: name, title, position, business email, US mobile |
| | Website choice and URL |
| | Preferred area code |
| | Industry for the wizard (EDUCATION or CONSUMER; Primary says TECHNOLOGY) |
| | Confirmation that `compliance@idanceflow.com` exists and is monitored (decision D3) |

## 4. Handling sensitive values locally

- **EIN**: hidden prompt only. Never in the JSON file, chat, command line, environment file, log or commit. After pasting it, clear the clipboard and Windows clipboard history (Win+V). The runner decrypts it at S2 only, to send it to Twilio inside the draft business EndUser.
- **API key secret**: hidden prompt only, never a file or argument. Use a Standard API key (decision D1). There is **no automatic Auth Token fallback**; any Auth Token use needs separate authorization. Delete the key in the Twilio Console when Stage B is finished.
- **Business file**: lives outside the repository; `.gitignore` also excludes `genx-business*.json`, `*.private.json`, `scripts/tw4-validation/private/` and evidence/report filenames.
- **Evidence and reports** contain resource SIDs and counts, not the EIN or the key; keep them outside the repository anyway.
- Never paste the contents of the business file, the key secret, the EIN or the authorization phrase into a chat. Pasting the output of `check-business-file.ps1` is safe.

## 5. No real key until the execution date

Everything above (template, checker, launcher dry run, harness tests) runs without any Twilio credential. A Standard API key and the Account SID are needed only on the execution date. At that point, optionally re-run Stage A with `-CompareLegal` for a read-only name/EIN match flag before authorizing Stage B.

## 6. Launcher authorization gates (re-verified)

`run-stage-b.ps1` enforces, and the local test suites cover, the following:

- **Explicit authorization**: an HMAC token bound to studio, expiry, mock mode, Primary SID, mailbox and key SID, issued only after the owner types the `authorize-b` phrase at a human console (not piped), then a typed `RUN`.
- **S10 boundary**: positional stop after S10 at the runner, the stage wrapper and the network fence; the Stage B fence allows only GETs and draft POSTs and never a request containing a `Status` field (so submit-for-review is impossible).
- **Stage C separation**: the Stage C token is a different, separately issued token bound to Stage B's SIDs; Stage B cannot run S11 onward.
- **Local isolation**: loopback database only, containers pinned to `supabase_db_danceflow-e2e-qa` / `supabase_auth_danceflow-e2e-qa`, `DOCKER_HOST` refused, mailbox must be typed `CONFIRMED`.
- **Cleanup** requires an evidence file whenever any ledger row exists.

Re-run `tests\launcher-b-matrix.ps1` and `tests\harness-exit.ps1` after any launcher edit.

## 7. Expected Stage B activity at Twilio

Account-level, under the parent account, all in draft state, friendly names `df:production:<studio>:S<n>:<seq>`:

| Step | Call | Creates |
|---|---|---|
| preflight | GET Primary customer profile | nothing (requires `twilio-approved` and the expected policy) |
| S1 | POST CustomerProfiles | draft Secondary Customer Profile (Email = compliance mailbox) |
| S2 | POST EndUsers | business information EndUser (**contains the EIN**) |
| S3 | POST EndUsers | authorized representative EndUser |
| S4 | POST Addresses (api.twilio.com) | account-level Address |
| S5 | POST SupportingDocuments | customer_profile_address document |
| S6–S8 | POST EntityAssignments | business EndUser, representative EndUser, document assigned to the Secondary profile |
| S9 | POST EntityAssignments | Primary profile assigned to the Secondary profile |
| S10 | POST Evaluations | an evaluation result (compliant, or `noncompliant` with field names to fix) |

About 10 POSTs plus lookup GETs. A `noncompliant` evaluation is a valid Stage B outcome (the runner records `needs_info`); it is not a submission and not an error of the harness. A 4xx on the first write (S1) aborts the run and is the live proof that key-signed writes are or are not accepted.

## 8. Persistence and cleanup limits

- The adapter has **no delete**. The local cleanup removes only the throwaway local database rows; it does **not** touch Twilio.
- Drafts persist at Twilio after the run, including the EIN inside the draft business EndUser. Deleting drafts through the Console is unverified; assume they may remain. They are not submitted, no fee is expected for drafts (confirm in the Console billing if in doubt), and they do not affect the approved Primary profile, but the same-EIN test entity means they sit beside the real GenX records.
- The evidence file lists the SIDs created; keep it so any draft can be located or removed later.
- A re-run creates new drafts (new sequence number); it does not reuse the previous ones.

## 9. Known unrelated blocker (not part of this workstream)

`next build` fails the type-check on `src/app/(auth)/callback/route.ts` (it exports `resolveEmailBindingDestination`, a non-route export, introduced in PR #127). Reproduced on pristine main `2cc05d9e`; Vercel builds pass. It is independent of TW-4 and is not being fixed here.

## 10. Stop points

The preparation ends here. Nothing is executed until the owner provides the information in the readiness checklist, creates a Standard API key on the execution date, gives written authorization, and personally types the `authorize-b` phrase.
