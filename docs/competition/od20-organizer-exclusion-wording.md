# OD-20: organizer exclusion only (Option A, initial activation)

Owner decision 2026-11-23. Stacked on the OD-19 PR. No SQL, migration, merge or deployment. Register entries: `governance/rule-register/rules/OD20-*.json`.

## What changed (wording only)
- One label, `EXCLUDED_LABEL` = "Excluded (organizer decision)" (`results/reviewTypes.ts`): the manager line, the non-manager line and the section heading in `CallbackPanels.tsx`; manager line is now "Excluded (organizer decision): <kind>, <reason>".
- The results panel states the exclusion is an organizer decision, not a governing-body disqualification. The request, co-sign and reversal notices say "Exclusion (organizer decision) ...".
- Audit of every string, error message, export and results page for "disqualified / DQ / disqualification": none applied to organizer exclusion existed; the only hits are status-code literals (below) and the UCWDC scoring-reference record (a source-grounded reference, not shown as a DanceFlow action). A test now guards the exclusion surfaces.
- Unchanged: CF1 A5 functions and their messages, exclusion state machine, no-show (NS1: excluded, not placed), scratch, withdrawal, scoring and placement. No new DQ action, "D" mark or Chairman ruling workflow.

## Distinct concepts (not merged by wording)
| Concept | DanceFlow behavior | Not |
|---|---|---|
| Scratch | entry/heat entry removed before the heat | a penalty |
| No-show (NS1) | staff mark; excluded from the round, not placed last | a disqualification |
| Excluded (organizer decision, A5) | danced couple removed from the ranking with a reason, two people | a governing-body ruling |
| Disqualified | database status only; no DanceFlow action writes it | a supported action |

## `disqualified` status: readers, writers, reachability
- App writers: none (static test). App readers: `ballots/actions.ts` and `ballots/[roundId]/page.tsx` (heat is danced), `noShow.ts` (refuse no-show), `payments/competitionRefundSummary.ts` and `competitionRefundRules.ts` (entry no longer active), registration status page (shown as "Not eligible").
- SQL readers: HL1 `_hl1_heat_is_danced`, NS1 mark refusal, R2 refund locks, 10D.1. No SQL function writes it.
- **Reachability gap on this base:** the `competition_manage` policy lets a manager write `event_competition_heat_entries.status = 'disqualified'` through the table API; HL1 then treats the heat as danced and R2 locks refunds. The U18 trigger guard (migration `20270215093000`, PR 483) is on the competition-cf1 release line but NOT on `release/website-embeds`. `event_competition_entries.status = 'disqualified'` is not covered by U18 on either line. Needed SQL (separate owner approval, not written here): bring the U18 guard to this line and extend it to the entry status.

## Sources re-read in the pinned PDFs (2026-11-23, SHA-256 match)
UCWDC Couples II.P.3.a (p14), ProPro/ProAm II.P.3.a, Line Dance II.P.3.a ("will be disqualified from that dance category"); Teams II.O.2.a ("scratched (disqualified)"); Couples II.N.2 (exclusion at "sole discretion of the UCWDC"), II.N.3 (post-event Judge Review Board); NDCA IX "Lifts and Dangerous Movements" (D rule (a)-(g)); NDCA IV.C.9 (refer to the Ballroom Department after the event) and III.D.47 (eligibility complaint deferred to after the event, NDCA Grievance & Disciplinary Committee). All recorded NOT IMPLEMENTED for future body profiles.

NDCA "Implementation of Disqualification under the 'D' Rule": an adjudicator marks "D" and notes the reason; tells the Chairman; the Chairman informs the competitors and adjudicators before the next round; a repeat reported by more than one adjudicator means the marks for that dance are deleted; in the final, more than one "D" means placement last in that dance; all are noted on the scrutineers' sheet; a competitor who keeps ignoring the Chairman may be disqualified from the event at the Chairman's discretion.

**WSDC:** the only WSDC document in the registry is the 2027 draft, status "not current", so nothing from it drives behavior or a register entry. Findings for the record: a competitor who dances in an incorrect skill level without a successful petition, or is not allowed to compete, "must be disqualified" and gets no points (Registry Event rules, skill-level section); Chart 7 sets Board penalties for event directors (warning, probation, fine). The restart provision (3.1 item 8) is not a disqualification rule.

## Tests
`exclusionWording.od20.test.ts` (label, no disqualification wording on exclusion surfaces, no app writer of the status, exclusion state machine / reason kinds / no-show window snapshots); updated label assertions in `evidence.cf1a3.test.ts` and `wiring.cf1b.test.ts`.
