# R-16 publication visibility disclosure specification (text only)

Status: **SPECIFICATION ONLY.** No UI, export, email or API change is made or authorized by this document; implementation belongs to the relabelling workstream (`od19-relabel-custom`).
DanceFlow Studio/Custom policy (R-16, 2026-11-24); not a governing-body rule and not applied to future body profiles ([R-16-VERIFICATION.md](R-16-VERIFICATION.md) section 7).

## Where it appears

On the organizer publish control (`results/[roundId]/page.tsx`), next to the two visibility options and again in a confirm step before "Publish result" when `The public as well` is selected.

## Option help text (always visible under each radio)

**Entrants of this round only** (default)
> Only people entered in this round can see it. Each entrant sees their own name and result, plus every couple's entry number, placement, tie status, advanced flag and rating band. Other couples' names are hidden (if you later choose the public option, entrants will see the names too).

**The public as well**
> If the event itself is published and public, anyone with the event page can see it, without signing in: every couple's name, placement, tie status, advanced flag and rating band for this round. Couples excluded from the result are listed by entry number only. Judges, ballots, marks, scores and audit records are never shown.

## Confirm step text (only for "The public as well")

> You are about to make this result visible to the public. People who are not entered in this event will be able to see every couple's name and placement. You can withdraw it later (the public will see that the result is under review, as they also do while a correction is open), but you cannot switch a published result back to entrants only without withdrawing it and publishing a corrected version. Continue?

Buttons: "Publish to the public" / "Keep entrants only".

## Constraints

1. Keep "Entrants of this round only" as the default and as the keyboard default; `The public as well` is never preselected.
2. Never say or imply the result is official, certified, or compliant with NDCA, UCWDC or WSDC.
3. Do not mention judge identities beyond "never shown"; body-specific judge-anonymity requirements stay profile-specific (no global policy).
4. Do not quote rulebooks.
5. If the owner adopts a required acknowledgement (RF-16.2), record the acknowledgement in the publish audit row; that is a design item, not part of this text.
