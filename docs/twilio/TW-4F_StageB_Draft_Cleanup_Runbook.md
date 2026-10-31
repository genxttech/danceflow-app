# TW-4F U-10: obsolete Stage B draft, verification and cleanup runbook (docs only)

Prepared 2026-10-29. **Planning only.** Nothing here authorizes a Twilio call, a Console deletion, a credential use or any change; every action below is the owner's, and each destructive step needs its own explicit written authorization (owner decision U-10, 2026-10-24: "the Twilio Console deletion needs a separate explicit authorization"). I did not open the evidence file, any private business file, the Console or any Twilio endpoint.

Tracker: pilot-activation blocker 4 (`TW-4F_Completion_Tracker.md` section 0.1), decision U-10, plan decision D1 and open question Q-dup (`TW-4F_Production_Onboarding_Plan.md` sections 4, 11, 13).

## 1. What the draft is (from the record)

| Fact | Source |
|---|---|
| Created in the **parent** Twilio account by the legacy Stage B harness (S1-S10 only; evaluation compliant; never submitted) for ConfiDance's identity | Onboarding Plan section 4; Stage B Execution Runbook |
| Identified as `BU68e22e24...` plus 9 siblings: Secondary Customer Profile, business EndUser (**contains the EIN**), representative EndUser, address, address document, entity assignments (business, representative, document), evaluation | Onboarding Plan section 4; runbook step table S1-S10 |
| Named for a **throwaway local studio id** with the Stage B mock-switch context; the production runner finds resources by friendly name including the real studio id and sequence, so it can never find or adopt it | Onboarding Plan section 4 |
| The adapter has no delete; local cleanup removed only throwaway local database rows | Stage B Execution Runbook (end) |
| No fee expected for unsubmitted drafts (confirm in billing if in doubt) | Stage B Execution Runbook |
| The legacy real mode is retired (PR #313: launcher refuses any run without `-DryRun`) | Stage B Execution Runbook |
| Exact SIDs for the 9 siblings are in the Stage B **evidence file**, which lives outside the repository | Stage B Decision Memo / Execution Runbook |

Approved policy (U-10): delete before the real ConfiDance run, never adopt; conditional on **verifying the draft's identity and keeping the evidence**.

## 2. Why it must be handled before Stage C / the real run

1. It carries an EIN in a draft EndUser that Twilio retains (privacy and retention).
2. A second draft profile for the same legal entity may interfere with duplicate-entity checks when the entity is registered again inside its own subaccount (Q-dup, unresolved).
3. It sits in the wrong account for the approved architecture (one subaccount per legal business) and can confuse operators and reconciliation.

## 3. Hard safeguards (read first)

- **Never touch the approved ISV Primary profile.** The Primary Customer Profile (GenX TotalTech LLC, `BUed777b1ed81df271793fbd097324ec94`), its policy (`RN6433641899984f951173ef1738c3bdd0`) and the approved brand are DanceFlow's own and must not be modified. Every candidate SID must be checked against this list before any deletion.
- The only resources eligible are those listed in the Stage B evidence file **and** confirmed in the Console to match the draft (section 4).
- No deletion by the application, the adapter, an API key or a script is proposed. The record says the adapter has no delete and no write authorization is granted; the cleanup is a manual Console action by the owner, unless the owner separately authorizes something else.
- No resubmission, no new draft, no fee-bearing action and no use of the real ConfiDance identity is part of cleanup.

## 4. Step 1: verify the identity of the draft (read-only, owner)

Owner evidence checklist (do not paste the EIN or any secret anywhere):

| # | Check | Pass criterion |
|---|---|---|
| 1 | Locate the Stage B evidence file (outside the repository) and confirm it is the one produced by the Stage B run | file lists the SIDs and `df:` friendly names |
| 2 | In the Console, parent account only: list Customer Profiles and find the profile named in the evidence | SID in the evidence exists, status draft (not in-review, not approved) |
| 3 | Confirm it is **not** the Primary profile | SID differs from the Primary list in section 3 |
| 4 | Confirm each of the 9 siblings by SID and type | each SID exists and matches the type in the evidence |
| 5 | Confirm the friendly name carries the throwaway local studio id, not a production studio id | name matches `df:` pattern for the throwaway id |
| 6 | Confirm nothing was submitted and no brand or campaign hangs off it | no Trust Product / brand / campaign references |
| 7 | Confirm no fee was billed for these resources | Console billing shows no related charge |

Record the result (date, who, SIDs, pass/fail per row) in a dated note kept with the evidence file. **If any row fails, stop** and do not delete anything; report to the coordination session.

## 5. Step 2: preserve the evidence before deleting

1. Copy the evidence file to a second private location (still outside the repository) and note its hash.
2. Save the Console listing (screenshot or export) of the 10 resources before deletion.
3. Write the dated verification note from section 4.

## 6. Step 3: written deletion authorization (owner)

A dated, retained message naming: the exact SIDs; the action (delete in the Console, parent account); the reason (U-10 / D1); that the Primary profile and approved brand are excluded; and that no other Twilio action is authorized. Without this, nothing is deleted.

## 7. Step 4: deletion (owner, Console)

Order and method are **not verified**: the record states that Customer Profile and Address deletion are documented, while EndUser and SupportingDocument deletion is unconfirmed, and that entity assignments may need to be removed before the profile can be deleted. Treat the following as the plan to confirm in the Console, not as proven instructions:

1. Open the draft profile; remove or detach entity assignments if the Console requires it.
2. Delete the profile and the address; attempt EndUser and document deletion.
3. After each deletion, re-list and record what remains.

If the Console cannot delete EndUsers or documents, **stop and record them as retained**; do not use another route. The EIN-bearing business EndUser is the priority item; if it cannot be deleted, raise it on the existing Twilio ticket (#29647095) rather than attempting workarounds. Sending that message is a separate owner action.

## 8. Step 5: close-out evidence

| Outcome | Record | Effect |
|---|---|---|
| All 10 deleted | two listings at different times showing absence; note with hash of evidence file | U-10 closed; Q-dup noted as "draft removed" |
| Some resources undeletable | list of retained SIDs with reason; Twilio answer if asked | U-10 partially closed; Q-dup stays open; owner decides whether the retained items block the real run |
| Verification failed | no deletion | blocker stays open |

After deletion the tracker rows (blocker 4, U-10, Q-dup) should be updated by the tracker owner; this runbook does not edit the tracker.

## 9. Not authorized and not done

Any Twilio call or Console action; any credential use; reading the evidence or business files; Stage C; the real ConfiDance run; subaccount creation; fee-bearing operations; changes to the Primary profile. Nothing was executed in preparing this document.

## 10. Remaining approval gates

1. Owner performs step 1 and records pass/fail.
2. Owner issues the section 6 written authorization naming the SIDs.
3. Owner (or an explicitly authorized person) performs the Console deletion.
4. If EndUser or document deletion is impossible, a separate owner decision on contacting Twilio and on whether the retained items block the real run.
