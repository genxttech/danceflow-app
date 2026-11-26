# SC1 in-app Scratch workflow: port to the live Competition line

Status: DRAFT, app-only, no migration. Nothing is applied, merged, deployed or activated.
Original: PR #306 (`competition-sc1-scratch-workflow`, head 59775cd3). Target: `release/website-embeds`.

## What #306 did, and what applies today

| #306 piece | Verdict | Why |
| --- | --- | --- |
| New RPC `scratch_competition_entry` (554-line migration), scratch-policy tables/RPCs, `event_competition_scratches` table | **Dropped** | Owner decision 3 requires the existing audited `change_competition_entry_lifecycle` and prefers no migration. #306's SQL also introduced financial resolutions (`refund`, `credit`) and an official override of locked heats: new financial authority and a weaker lock rule. Not ported. |
| Revoking the lifecycle RPC from API roles (referenced by R2 doc P2-7) | **Not ported** | Would break this workflow, which calls that RPC. S6 owns any grant change. |
| Resolution picker, policy page (`scratch/policy`), `scratchDecision`, `isOfficial` | **Dropped** | Depends on dropped SQL; money-adjacent. |
| `classifyPlacements` (certified / disqualified / danced / locked / open / unplaced) | **Ported** | Same rule the live R2 cascade uses (`danced` placement, or non-scratched placement in an active/complete heat). Locked now refuses for everyone (the live RPC refuses locked and certified for all roles). |
| `entryStatusLabel` (scratched and withdrawn both "Scratched") | **Re-implemented** | Blurred outcomes. Now Scratched, Withdrawn and a stored `disqualified` status ("Disqualified status (not a DanceFlow decision)") stay distinct. "Excluded (organizer decision)" (OD-20, PR 853) names the CF1 A5 two-person action and is not used for any stored status here; no-show marks are not shown on this page. |
| Scratch page, server action, `scratchHref` target | **Re-implemented** against current files | Uses `requireCompetitionWorkspace` / `requireCompetitionManager` (`workspaceServer.ts`), the user-session client, `entry_changes` for history. Old code used `getCurrentStudioContext` plus `_paywh1_actor_can_manage_event` (not on the live line). |
| Link on day-of page | Already present on the live line (`scratchHref` in `dayOf.ts`); now resolves instead of 404. | |
| Registrations page link | **Added** (pending / confirmed / waitlisted entries only). | |

## Behaviour

1. Manager opens `/app/events/:id/competition/registrations/scratch/:entryId` (404 for non-managers via the competition layout and `requireCompetitionWorkspace`).
2. Submits a required reason (1-500 chars; the button disables while pending). `performScratch` (user client) re-reads the entry and its heat entries, applies `scratchPreflight`, then calls
   `change_competition_entry_lifecycle(selected_entry_id, 'scratched', reason, 'not_applicable')`.
3. Live RPC (SECURITY INVOKER, `can_manage_event_competition`): refuses locked/certified heats, updates the parent entry (audit trigger writes `event_competition_entry_changes` with reason), then sets `scheduled`/`checked_in` heat entries to `scratched`. U18-S accepts this sequence (marker `app.competition_entry_change_type = scratch`, parent scratched, audit row exists).
4. Read-back verifies parent = `scratched` and no heat entry left `scheduled`/`checked_in` (`COMP_SC1_INCONSISTENT` otherwise).

5. Replay: an entry already scratched or withdrawn never reaches the RPC again ("already scratched" / "already withdrawn", nothing changed). If such an entry still has scheduled or checked-in heat entries (for example left by the older registration sync or a direct write) the workflow reports `COMP_SC1_STRANDED` and changes nothing: on the live RPC a repeat call overwrites the recorded reason and time without a new audit row.

## Option A (owner decision 2026-11-26; DanceFlow Studio/Custom policy)

Recorded in `governance/audit/OWNER-DECISIONS.md` section 14 (PR 795, `3515c5524`). Whole-entry scratch and withdrawal stay blocked once any associated heat is active, completed, danced or disqualified.

- The page and the server action refuse such an entry. The day-of and Registrations pages show no Scratch link for it, and none for a locked or certified heat or a `disqualified` / `complete` entry (`scratchOffer.ts`). If placements cannot be read, no link is shown.
- A `staging` heat is not in the policy and is not refused. A placement already `scratched` inside an active or completed unlocked heat does not block (same as `_r2_entry_participation_class`).
- An advance withdrawal is never recorded or worded as a No-show. No-show stays the separate per-heat day-of action. Withdrawing only the later heats of a partly danced entry has no mechanism; Option C is a separate design.

## Consistency and money

- Parent entry, heat entries, audit row: written by the RPC in one transaction; verified by read-back and by the unit model in the tests.
- Registration / order / cart rows are not touched. Entry dances are not touched (unchanged live behaviour of the RPC).
- Fee handling is fixed to `not_applicable`: no fee decision is recorded. No Stripe, refund, credit or fee code is imported (asserted by a test). Refunds stay in R2 (`refundActions.ts`); a scratch never requests one.
- Scoring (R-08): untouched. Scratched heat entries are already excluded from the ranking set and never placed last; ballots that still rank a scratched entry are handled by the existing engines.

## Un-scratch

None offered. U18-S refuses `scratched -> *` for non-owner writers, and the parent entry has no restore path in this workflow. A restore is a correction (OD-07/R-12 workflows).

## Known gaps on the live RPC (every SQL change is owned by S6; not fixed here)

1. The RPC does not refuse a danced or disqualified placement, or an active or completed heat, when the heat is UNLOCKED. This workflow refuses it in the app only: a direct RPC call is not stopped, and a heat that starts between the app's check and the call is not stopped either.
2. The RPC is not idempotent: a repeat call writes no second audit row (the audit trigger fires only on a status or similar change) but bumps `lifecycle_version` and overwrites the scratch reason and time. The app blocks sequential replays and disables the button while pending; two truly concurrent submits can still both pass, leaving the entry's reason different from the one audit row.
3. The RPC accepts any current status. The app refuses `disqualified` / `complete` / already-out entries from its own read; a status committed between that read and the call (for example a refund cascade writing `withdrawn`) would be overwritten with `scratched`.
4. An already-out entry with scheduled or checked-in heat entries cannot be repaired from this page (Behaviour 5).
5. A scratch on a published schedule is allowed: the 10D heat-entry guard exempts status-only changes, and scratching is a day-of operation. Heat reassignment stays refused.

## S6 coordination (OD-31 session)

- Read from draft PR 877 (`claude/od31-s6-entry-status-guard`, head 5a8c5456, stacked on PR 867; not applied; the OD-31 session leads the joint 877 + 878 verification; the head may move). `20270301140000` makes the lifecycle RPC SECURITY DEFINER (authenticated only) with mandatory rules: source states (`COMP_ENTRY_LIFECYCLE_STATE`), placed entries refused (`COMP_ENTRY_LIFECYCLE_PLACED`), heat and entry row locks, and a repeat call that writes no audit row or version bump and only completes the heat-entry cascade. `20270301141000` guards direct entry status writes. The earlier optional 142000 was folded into 140000.
- Expected effect once applied (by reading): gaps 1-3 close. Gap 4 could then be repaired by repeating the call with the entry's current status; this workflow does not do that.
- Contract: signature unchanged, this workflow's call shape stays valid, both new codes are mapped. SC1 writes no entry status itself, so 141000 does not affect it.

## Dependencies / merge order

Guard landing PR (JC1, U18, U18-S) -> 865 -> 864 -> 866 -> 863 -> S6 correction PR 877 (14xxxx) -> this PR (app-only, last). It works without S6 and U18-S, but gaps 1-3 remain until S6's 140000 is applied. Hosted DEV and PROD already have U18-S (OD-31 finding), so the workflow is expected to run under it; that has not been executed against a database here.

## Rule evidence

DanceFlow Studio/Custom policy only; no governing-body rule is implemented or claimed. Register entry: `governance/rule-register/rules/SC1-STUDIO-CUSTOM-SCRATCH-WORKFLOW.json` (status `unverified`: no SQL was executed).
