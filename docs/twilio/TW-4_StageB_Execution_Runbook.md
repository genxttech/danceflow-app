# TW-4 Stage B execution runbook (legacy parent-account harness; preparation record)

> **STATUS 2026-10-24 (supersedes the status line below): this runbook describes the LEGACY parent-account validation harness.** Owner decision D2 (revised 2026-10-18) puts every studio legal business in **its own Twilio subaccount**, starting with ConfiDance Unlimited, LLC; the parent-account pilot exception is removed. Twilio confirmed (ticket #29647095, 2026-10-19) that the parent's Primary Customer Profile can be assigned into a Secondary profile in a subaccount of the same organization. `TW-4F_Production_Onboarding_Plan.md` (section 4 and section 13) records that the Stage B draft for ConfiDance was already created in the parent account; it is historical evidence only, is **not adopted**, and is cleaned up under D1/U-10. **Do not run this harness again for a new studio, and do not fill in a business file for the ISV (GenX TotalTech LLC) or reuse its EIN.** Section 0 below says what replaces it. Sections 1-10 are kept as the record of the harness and the safeguards it proved.
>
> Nothing in this update contacts Twilio, creates a resource, or touches DEV/PROD. Stage C, any fee and any irreversible submission remain unauthorized.

## 0. Procedure under the subaccount architecture

The harness (`run-stage-b.ps1`, `stage-bc.ts`) authenticates with ONE Account SID plus a Standard API key and writes to **that** account. It also does a preflight read of the Primary profile with the same credentials. Under D2 that is the wrong account for a studio: Trust Hub and Messaging A2P resources must be created with the **subaccount's own credentials** (the parent's credentials do not reach other subdomains; plan section 13), while the Primary profile is read through the parent (GET only). The production runner already works this way (`SubaccountTokenProvider`, scoped adapters, `needs_subaccount` / `account_mismatch` stops), so the harness is retired for real runs. What replaces Stage B for ConfiDance:

| Step | Who | Twilio effect | Gate |
|---|---|---|---|
| 1. Confirm ConfiDance is a distinct legal entity with its own EIN (`TW-4_StageB_Studio_Identity.md` section 5a) | Owner | none | owner evidence |
| 2. ConfiDance's owner completes the wizard in production (EIN typed once, encrypted app-side; DanceFlow staff never type it) | Owner | none | G0, G1 |
| 3. Cleanup decision for the parent-account Stage B draft (delete first, never adopt; Console deletion needs its own authorization; the duplicate-entity risk Q-dup is unresolved) | Owner | deletes drafts | separate authorization |
| 4. Set the entity spend cap, then create the subaccount `df:{env}:{legal_entity_id}` (its own confirmed run) | Platform admin | creates a persistent account; closing it is permanent | G-SUB |
| 5. Runner S1-S10 inside the subaccount: draft Secondary profile, EndUsers, Address, document, assignments (the Primary is read via the parent and assigned across), evaluation only. First live proof of the cross-account assignment, supervised, no fee | Runner | persistent drafts, EIN inside the business EndUser | G0 + runner window |
| 6. S11 submit, T1-T6, brand, campaign, number | Runner | irreversible / fees | G2, G3, G4, G5 (each separately authorized; the $150 pilot ceiling is not permission to spend) |

Safeguards from this harness that carry over unchanged in purpose: no secrets or EINs in files or chat; owner-filled identity files stay outside the repository; the evaluation never submits (S10 stop, no `Status` field before the submit gate); a human-typed phrase for every irreversible or persistent step; loopback-only databases for local rehearsals; evidence by SID only. The ISV-identity refusals in the checker and launcher are an accidental-reuse safeguard only (`TW-4_StageB_Studio_Identity.md` section 5b); the production path additionally needs its own server-side check that a studio's EIN last four differs from the Primary's.

Adjustments to the old Stage B procedure: (a) the real-mode harness is parent-account-only and should be treated as retired; a launcher guard that refuses real mode unless an explicit legacy switch is passed is proposed but not built (it changes launcher behavior, so the 22-case matrix and the interactive suites would have to be re-run); (b) a business JSON is not needed for ConfiDance's real onboarding, because the wizard collects the same fields; (c) a `genx-business.json` file has no purpose and can be deleted by its owner (the tooling never read it).

Original status line (2026-10-17, historical):

Status: PREPARED, NOT AUTHORIZED. Stage B and Stage C remain unauthorized until the owner gives separate written authorization and personally types the `authorize-b` phrase at run time. Production stays on the currently promoted deployment (`dpl_9JYuwjxf9ikjac3VtS8PSWhEZD2x`); the merged main build (`419e5b5f`) is not promoted.

No step in this document contacts Twilio, creates a resource, or touches DEV/PROD. Nothing here needs a Twilio credential.

## 1. What Stage B is

Stage B runs the real ISV adapter against Twilio for steps **S1–S10 only**, for ONE studio's legal identity under the approved Primary (ISV) profile, in an isolated local database. **The subject is a studio, never the ISV** (correction 2026-10-17, see `TW-4_StageB_Studio_Identity.md`; the earlier GenX same-EIN plan is withdrawn and the tooling refuses the ISV's identity). It creates **draft** Trust Hub resources and asks Twilio to **evaluate** them. It never submits anything for review (S11 and later belong to Stage C, which is mock-brand only and separately authorized). Purpose: prove that key-signed writes, the payload shapes and the evaluation response work against the real service before any real studio is onboarded.

## 2. Owner-filled business file

1. Create a private copy outside the repository (restricted to your Windows user; refuses to overwrite):
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tw4-validation\new-business-file.ps1 -Studio <short-name>`
   Location: `%LOCALAPPDATA%\tw4-validation\private\<short-name>-business.json`. There is no default studio; `-Studio` is required and `genx`/`totaltech` are refused.
2. Edit it and replace every `<placeholder>`.
3. Check it (local only; prints field names and rules, never values, so the output is safe to paste into a chat):
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\tw4-validation\check-business-file.ps1 -Studio <short-name>`
4. The launcher re-validates the same rules and refuses a file located inside the repository, a file holding a placeholder, an unknown field, an `ein` field, the ISV's own legal name, or a `@idanceflow.com` representative email.

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
| Profile exists, status `twilio-approved`, correct policy | |
| The Primary profile is the ISV's OWN identity (GenX TotalTech LLC): it proves the ISV is approved, it is **not** a source for the studio's values and is never the subject | Exact legal name as on the studio's IRS letter, and its EIN (hidden prompt, never the ISV's) |
| | Physical street address, city, state, ZIP |
| | Authorized representative: name, title, position, business email, US mobile |
| | Website choice and URL |
| | Preferred area code |
| | Industry for the wizard (EDUCATION or CONSUMER) |
| | Confirmation that `compliance@idanceflow.com` exists and is monitored (decision D3) |

## 4. Handling sensitive values locally

- **EIN**: hidden prompt only. Never in the JSON file, chat, command line, environment file, log or commit. After pasting it, clear the clipboard and Windows clipboard history (Win+V). The runner decrypts it at S2 only, to send it to Twilio inside the draft business EndUser.
- **API key secret**: hidden prompt only, never a file or argument. Use a Standard API key (decision D1). There is **no automatic Auth Token fallback**; any Auth Token use needs separate authorization. Delete the key in the Twilio Console when Stage B is finished.
- **Business file**: lives outside the repository; `.gitignore` also excludes `*-business.json`, `genx-business*.json`, `*.private.json`, `scripts/tw4-validation/private/` and evidence/report filenames.
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

Legacy harness: account-level, under whichever account the harness credentials belong to (the parent account, which is why it is retired for studios); in the subaccount architecture the production runner creates the same set inside the studio's subaccount. All in draft state, friendly names `df:production:<studio>:S<n>:<seq>`:

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
- Drafts persist at Twilio after the run, including the EIN inside the draft business EndUser. Deleting drafts through the Console is unverified; assume they may remain. They are not submitted, no fee is expected for drafts (confirm in the Console billing if in doubt), and they do not affect the approved Primary profile, and they carry a real studio's identity: see `TW-4_StageB_Studio_Identity.md` §5 (the studio's written consent, and drafts named for the throwaway local studio are not the studio's later production onboarding).
- The evidence file lists the SIDs created; keep it so any draft can be located or removed later.
- A re-run creates new drafts (new sequence number); it does not reuse the previous ones.

## 9. Known unrelated blocker (not part of this workstream)

`src/app/(auth)/callback/route.ts` exports helper functions besides `GET` (`resolveEmailBindingDestination` since PR #127). Re-examined 2026-10-18 (`TW-4F_Production_Onboarding_Plan.md` section 12): not a Vercel blocker, because the default `next build` (Turbopack) succeeds and Vercel builds pass; only `next build --webpack` rejects it. Independent of TW-4 and not fixed here.

## 10. Stop points

The preparation ends here. Nothing is executed until the owner provides the information in the readiness checklist, creates a Standard API key on the execution date, gives written authorization, and personally types the `authorize-b` phrase.
