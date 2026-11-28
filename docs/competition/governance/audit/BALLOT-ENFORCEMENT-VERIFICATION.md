# Ballot-integrity enforcement verification (owner ruling, OWNER-DECISIONS.md section 15, requirement 10)

Independent read-only check of PR 877 `8c738c4d8` and PR 878 `22c27b505` on base `49dbaee1b`, 2026-11-26. All findings are read from code; nothing was executed. Option D (PR 899) was not part of this check.

# Ballot enforcement verification: PR 877 / PR 878

**Everything here is read from code. Nothing was executed** (no SQL, tests, builds or hosted database).

Refs: base `origin/release/website-embeds` 49dbaee1b; PR 877 `origin/claude/od31-s6-entry-status-guard` 8c738c4d8; PR 878 `origin/claude/sc1-port-live-line` 22c27b505. Both expected heads match; both branch directly from base. 877 also carries JC1, U18 and U18-S (20270215092000-094000).

File keys (under `src/lib/supabase/migrations/`; line numbers at the 877 head):

| Key | File prefix |
|---|---|
| L140 / L141 | 20270301140000 lifecycle definer / 20270301141000 status write guard |
| E2 | 20270102090000 ballots |
| R2 | 20270103090000 entry refunds |
| O1 | 20270106090000 day of |
| 10A / 10D | 20261107090000 / 20261111090000 |
| F2 | 20270114090000 results lifecycle |
| NS1 | 20270115090000 no-shows |
| CF1 / A1 / A3 / A5 / A6 | 20270120090000 / 085000 / 093000 / 094000 / 095000 |

## Bottom line

Neither 877 nor 878, alone or with base, applies any ballot test to ordinary Scratch or withdrawal. Ballots can be filed while heats are still `scheduled`: the insert path requires only an `active` round (or an open correction) and a published/live ballot heat (E2:281-289, E2:799-911, E2:414-428; F2:396-418). In that window the 877 RPC accepts the scratch.

## A. Requirements

| # | Requirement | Verdict | Evidence |
|---|---|---|---|
| 1 | Block ordinary scratch/withdraw when affected ballots exist | **MISSING** for the lifecycle RPC, registration sync and R2. Enforced only for the separate callback-Final withdrawal (A6) | L140:62-136 never reads ballots, including the repeat-call cascade L140:108-115. R2:580-595 and R2:663-739, R2:1388-1469 likewise. A6:242-244 raises `COMP_WITHDRAWAL_BALLOTS` (any ballot in the Final), at request and cosign (A6:447, A6:561). 878: `scratchServer.ts` `performScratch` and `scratch.ts` `scratchPreflight` look only at entry status and placement class |
| 2 | Keep whole-entry block once any associated heat starts/completes | **ENFORCED with 877** (edges below) | L140:70-80 and 96-106 (R2 class, R2:588-591); L141:163-206 (direct update/delete of placements and heat delete); sync R2:1424-1438; refund apply R2:719-731. 878 mirrors it in app (`classifyPlacements`, `scratchOffer.ts`) |
| 3 | Block by exact affected scoring scope | **MISSING** | No scope is computed on any scratch path |
| 4 | No bypass | **PARTIAL** | See section C |
| 5 | Preserve ballots and audit evidence | **ENFORCED** (one cascade exception) | E2:222-227 refuses update/delete/truncate on ballots, marks, attendance, ballot events; E2:964-967 leaves only SELECT; corrections are new versions. 10A:703-720 permits the delete when the parent event is deleted, so event deletion erases ballots (event-delete guarding not examined) |
| 9 | Negative tests | **MISSING** | The 877 S6 guard and concurrency tests and U18/U18-S tests contain no "ballot". 878 scratch code/tests contain none. Ballot mentions elsewhere in 877 tests (A5 concurrency, callback-final, JC1) are not scratch-vs-ballot cases as far as file names and counts show (contents not read) |

Edges on #2 (in code, not necessarily defects):
- A placement already `scratched` in an active/complete unlocked heat does not block (R2:591; 878 doc line 34).
- `staging` is not treated as started.
- Registration sync takes no heat lock, so a concurrent heat start can race it.
- Without 877 applied, the base RPC refuses only locked/certified heats.

878 text points the other way from the ruling: scratch page line 113 says a ballot that already ranks the entry "must be corrected", and `docs/competition/sc1-live-line-port.md:43` says such ballots are handled by the engines.

## B. Which ballots a removed entry affects

### Formats
- `ordinal_rank@1`: heat-level (`heat_id` set), full 1..N over the heat's ranking set (E2:233-264).
- `callback_yes@1`: round-level (`heat_id` null), exactly T yes marks over the round's eligible set.
- `three_band` is not approved, so no ballots.
- Drafts (`event_competition_ballot_drafts`) are never engine input.

### Ranking set
`_compe2_round_heats / _heat_entries / _round_entries` exclude scratched placements, NS1 no-shows and A5 exclusions (NS1:176-199, A3:90-105). A ballot heat must be non-cancelled, in a published/live version, with at least one remaining entry.

### Effects of scratching E (the RPC scratches all of E's scheduled/checked-in placements)

| Case | Effect |
|---|---|
| Ordinal heat ballot ranking E | Stale: lock blocked (E2 `_compe2_round_blockers`, stale query from E2:772). Engine/PV1 fail `mark_out_of_range` if reached |
| Ordinal heat emptied by removing E | Heat leaves the ballot-heat set; its ballots silently drop from evidence (F2:555-561) and are not flagged stale |
| Multi-heat ordinal round, ballot in heat 1, E in heat 2 | Heat 1 marks unchanged, but round evidence (entries, excludedEntries, heats, input hash; F2:562-627) changes. Engine fails multi-heat closed (`studioOrdinalMajority.ts` V11; PV1 same). Removing heat 2's only couple would turn it into a single-heat, calculable round |
| Callback judge who selected E | Stale; engine `callback_count` (T-1 eligible marks) |
| Callback judge who did not select E | Ballot stays valid, but eligible set and cut shrink |
| Callback where T >= remaining couples | "All advance, not danced": every ballot in the round is ignored (`studioCallbackTally.ts`; PV1:259-263) |
| Minimums | Callback Final needs >= 2 available couples at lock/calculate/approve (A1:233-346); ordinal needs N >= 1; callback target >= 2 (A4a) |
| Advancement | A changed source result changes who advances. An advanced couple has a danced earlier heat, so rule 2 already blocks the whole entry. Final roster changes go through A6 |
| Superseded versions | Excluded from evidence, but their slot always has a current successor; as an existence test, "any version" is equivalent and preserves history |
| Correction ballot that drops E | Preserved as a new version; must not make E eligible |
| Other divisions, rounds where E has no placement (including a later round not yet holding E) | Unaffected |
| Drafts | Do not count (a draft naming E would fail at submit) |

### Smallest correct predicate (proposed)

Refuse ordinary scratch/withdraw of entry E when any row in `event_competition_ballots` (any version, any source; drafts excluded) satisfies **any** of:

1. `ballot.round_id` is a round of a heat on which E holds a placement with status other than `scratched`, whatever that heat's status, lock state or schedule-version status; or
2. one of the ballot's marks references E (any version); or
3. `ballot.heat_id` is a heat on which E holds a placement (catches a heat later moved to another round).

Notes:
- Round granularity is deliberate. Results, eligible set, minimums and input hash are round-wide. A heat-only rule is correct solely for marks, and would let a scratch in heat 2 change a round holding heat 1 ballots. Ordinal Finals are single-heat in practice, so the two coincide there.
- Do **not** reuse `_compe2_round_entries` / `_compe2_round_heats`: they filter on published version, non-cancelled heat, no-show and exclusion, so unpublishing or cancelling would switch the block off.
- Clause 1 reads current placements. If a placement is moved or deleted after ballots (section C) and no mark names E (callback), no clause matches. The predicate is only sound once those reassignment paths are closed.
- Cancelled rounds are included on purpose, so cancel-then-scratch does not unblock.
- The same test belongs on the repeat-call cascade (L140:108-115).

## C. Write paths

| Path | Refused once ballots exist? |
|---|---|
| Lifecycle RPC, scratch and withdraw | **No** (L140). Only locked/certified/started/danced/disqualified |
| Direct entry status/link/evidence write | **Yes** with 877 (L141 entry guard, status refusal at L141:137) regardless of ballots |
| Direct entry delete | Not ballot-aware. Refused for confirmed/linked entries (L141:92-105); cascade onto placements in a published version is refused (10D:337-374); cascade onto marks is refused by history protection (E2:222-227). Residual: unlinked pending entry, no marks, placements only in a version flipped back to draft |
| Entry `eligibility_status` write | Not refused. Does not drop the couple from the ranking set; blocks lock/calculate/approve (A1:129-180) |
| Direct placement scratch | **Yes** for client roles: U18-S (20270215094000:28-48). Allowed for an already scratched/withdrawn entry with the GUC and audit row; definer paths are exempt |
| Direct placement insert/delete/move | Refused in published versions (10D:337-374, not ballot-aware) and in started heats (L141:163-203, update/delete). **Not refused** in a draft version, other than A6 / advanced-Final guards |
| Ballot / mark update, delete, truncate, direct insert | **Yes** (E2:222-227, 964-967). Event-delete cascade excepted |
| Heat status to `cancelled` by direct update | **No guard found** for a scheduled, open heat outside an advanced Final (O1:238-243 lets non-running transitions through; CF1:691-694 covers advanced Finals only; 10A lock guard covers locked only). Its ballots stop counting |
| Heat `round_id` change by direct update (same division) | **No guard found** for a non-running heat outside an advanced Final (O1:233-237; the placement trigger column list 10D:464-467 omits `round_id`; CF1:699-716) |
| Schedule version published to draft/superseded by direct update | **No guard found** before any heat runs (O1:268-297; CF1:835-843 acts only on publish/live; policy and grant 10A:509-521). All its heats leave the ballot set and 10D then permits placement delete/reassign |
| Replacement schedule version publish | **No ballot guard** (20260620 generation ops:598-650; O1 refuses only once a heat runs). Old heat ballots stop counting |
| Heat delete | **Yes** in effect: published refused (10D:376-393); ballot cascade refused by history protection. A draft heat with no heat-level ballot can be deleted even if the round has callback ballots |
| Round delete | **Yes** in effect (ballot cascade refused); also SS1 20270116090000:87-106 and E1 20270101090000:239-254 |
| Round cancellation (`cancel_competition_round`) | **No** ballot check (O1:421-479); allowed from active/ballots_locked if no heat is staging/active. Direct round status writes are refused (O1:181-184) |
| Replacement round | No dedicated function found. No ballot guard found on creating a new round after cancellation |
| Registration sync (registration cancelled/failed/refunded) | **No** ballot check (R2:1397-1445); skips locked/certified/danced only. 877 leaves client-driven registration changes open (L141 header) |
| R2 refund apply | **No** (R2:715-725). Open/unplaced class includes balloted but unstarted heats. EXECUTE revoked from service_role by 877; owner-run callers remain |
| NS1 no-show | **No** ballot check (NS1:205-283). Requires active round and active/complete heat; removes the couple with ballots present (judges resubmit) |
| A5 exclusion | Allowed with ballots by design: two-person, danced only (A5:272-290) |
| A6 Final withdrawal / reinstatement | **Yes** (A6:242-244) |
| F2 correction of an earlier round | Refused if a later round has ballots (F2:1214-1224). Not a removal path; useful precedent for locking |

## D. Concurrency

Ballot submit and paper entry share `_compe2_insert_ballot`:
- advisory transaction lock on (round, official) (E2:824, E2:672-677);
- round row `FOR SHARE` (E2:826; again in the insert guard E2:281-285);
- implicit foreign-key `KEY SHARE` on round, heat (if set), official, and on each marked entry;
- roster read (`_compe2_heat_entries` / `_compe2_round_entries`) and mark guard (E2:331-354) take **no** heat-entry, heat or entry row lock. Later rewrites seen (F2, NS1, A3, A7, OJ1) change conditions, not these locks.

877 lifecycle:
- unlocked pre-checks; associated heats `FOR SHARE` in id order (L140:83-86); entry `FOR NO KEY UPDATE` (L140:87-89); re-checks; entry update; placement updates. **No round lock, no advisory lock.**

`FOR SHARE` / `FOR NO KEY UPDATE` do not conflict with `KEY SHARE`, and the two paths share no conflicting lock (no status-bearing full unique index on entries found). Under READ COMMITTED, both orders are therefore possible:
- ballot commits between the scratch's check and its write (a newly added check would miss it);
- scratch commits between the ballot's roster validation and the ballot commit, leaving a ballot that names a scratched couple.

So adding a check alone is insufficient. The scratch needs a lock on each affected round row that conflicts with `FOR SHARE`, held before a fresh-statement ballot check. Lock order needs care: floor advance takes heat then round `KEY SHARE` (NS1:265-266 comment), A6 cosign and F2 take the round first, and HL1 reopen holds a heat then takes round `FOR SHARE` (20270119090000:75-77), so round-then-heat can deadlock with it. The same applies to sync and R2. Lock/calculate/approve do take ranking-set entries `FOR SHARE` (A3:163-182, A2), which does serialize with the lifecycle entry lock.

## Missing enforcement

1. Ballot check in the lifecycle RPC for scratch and withdraw, including the repeat-call cascade.
2. Affected-scope predicate (above).
3. Serialization with ballot submit and paper entry (round lock).
4. Same rule on registration sync and R2 refund apply (route to a recorded exception rather than withdraw).
5. Guard direct heat cancellation and heat round reassignment once ballots exist.
6. Guard schedule version unpublish/supersede and replacement publish once ballots exist (which also closes placement delete/reassign).
7. Guard round cancellation (and hence replacement round) as a bypass once ballots exist.
8. Align 878 app preflight, offer and wording, with a stable error code.
9. The negative tests in requirement 9.

## Owner decisions surfaced

- **No pre-start recovery path.** With the block in place, a balloted entry in an unstarted heat cannot be removed: A5 needs a danced heat, NS1 an active/complete heat. NS1/A5 become available only after the start. Requirement 9's "controlled correction recovery" needs a definition for this window.
- NS1 removes a couple while ballots exist. Confirm it is a controlled correction path and not covered by requirement 4.
- Refunds are not "ordinary" scratches: decide the exception behaviour.
- Whether legitimate round cancellation / schedule republish with ballots is refused outright or needs an audited path.
- Event deletion erases ballots.

## Not determined

- Anything about runtime behaviour; the "no guard found" bypasses are inferences from trigger, policy and function text and were not reproduced.
- Effective grants/RLS and applied migrations on DEV/PROD (877 SQL is marked not applied).
- Whether dynamic DDL outside the searched patterns adds revokes or guards on heats, rounds or schedule versions.
- Whether any app UI performs the direct writes in section C (only a limited search).
- A7/U66 correction internals and F3 publication paths were only skimmed.
- The bodies of the A5 and A7 ballot-insert triggers were not read for additional row locks.
