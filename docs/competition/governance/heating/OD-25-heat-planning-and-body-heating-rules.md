# OD-25: heat planning, randomization and body heating rules

Owner decision **OD-25, 2026-11-23: Option B now for Studio/Custom heat planning; Option A for future body profiles.**
Documentation only: no planner, SQL, UI or copy change is made or authorized. Nothing here claims NDCA, UCWDC or WSDC
compliance.

## 1. Studio/Custom heat planning, preserved (`OD25-DF-0001`)

- **Capacity:** scoring-heat capacity is configurable per round (`configuration.max_entries_per_heat`, accepted when an
  integer from 1 to 100) with a default of 8 (`DEFAULT_SCORING_HEAT_CAPACITY` in `src/lib/competition/floorPlanner.ts`). The callback-Final guard
  has a CHECK on the ledger column `target_capacity` (1 to 100) in `20270120090000_competition_cf1_callback_final_advancement.sql`. The guard function there reads `max_entries_per_heat` without that range check (default 8), while `scoringHeatCapacity` falls back to 8 outside 1..100, so a configured value above 100 may behave differently in the two places (not verified in the database).
- **Label:** capacity stays a **DanceFlow product default, not a sanctioning rule**. That wording already appears in
  `floorPlanner.ts` ("DanceFlow product default, NOT a sanctioning rule; editable per round"), in
  `20261111090000_phase10d_heats_floor_schedule.sql` and in `docs/competition/phase10d-heats-floor-schedule.md`. A
  user-facing label was not verified.
- **10D floor planner (`floorPlanner.ts`, `buildFloorPlan`):** deterministic. It sorts divisions and entries in a fixed order,
  splits a division into scoring heats by capacity (first fit, no competitor twice in a scoring heat; capacity is read from the division's first round only) and packs each scoring heat into the earliest floor heat with the same music key, no shared competitor and a combined entry count within the floor recommendation (8); own-music items (routines, showdances, etc.) are never shared. Nine entries give heats of 8 and 1 (test "splits a division into scoring heats
  by capacity ...", `floorPlanner.phase10d.test.ts`); it does not balance heat sizes.
- The database stays authoritative (`apply_competition_floor_plan` and the integrity triggers in
  `20261111090000_phase10d_heats_floor_schedule.sql`).

## 2. Finding: a seeded-random planner already exists (`OD25-DF-0002`), escalated

OD-25 says Studio is first-fit and that there is **no seeded randomization in Studio/Custom this release**. The code also contains a
second planner that does randomize:

- `generateHeatPlanAction` (`src/app/app/events/[id]/competition/readiness/actions.ts`) creates a random UUID **seed** per run,
  stores it with the engine version `danceflow-heat-planner-0.1.0` and an input snapshot (`create_competition_heat_plan_run`), then calls
  `buildHeatPlan` (`src/lib/competition/heatPlanner.ts`).
- `buildHeatPlan` shuffles each first-round division's entries with a seeded xorshift shuffle (`seededShuffle`, seed
  `<run seed>:<job key>`, where the job key is the round id, or `roundId:dance_key` for single-dance contests) and then `balancedGroups` splits them into the fewest groups of near-equal size (sizes differ by at most one).
- Group size comes from the **block's floor capacity** (`max(1, floor_capacity_snapshot ?? 1)`), not the round setting or the Studio default of 8: a block with no floor capacity plans one entry per heat, and a "no floor" blocker is raised. Only first-round jobs are shuffled; later-round heats are empty placeholders. An ordinal-majority round needing more than one heat raises a conflict **only when `COMPETITION_FINALS_ENABLED` is on** (with the flag off the planner never sees `scoring_method`).
- Output is a reviewable proposal (a heat plan run); it does not change operational heats until a later review/apply step. It is not the 10D scoring-heat planner.

So the readiness planner already records a seed and an engine version (a reproducible foundation) and balances to within one.
**This needs an owner/coordinator decision** (keep and label it, restrict it, or amend the OD-25 wording); this PR changes nothing.
**Reachability (verified by the reviewer reading the code):** an event manager (studio owner/admin, organizer user or platform admin) reaches it through Competition workspace, Schedule, "Advanced scheduling", "Schedule Readiness" (`/competition/readiness`) when the schedule version is editable and the readiness checks are green. No feature flag gates the action or page (`COMPETITION_FINALS_ENABLED` only changes callback behavior). **The seed is recorded** (with engine version and input snapshot); the same input and seed reproduce the plan. The audit evidence for the final order (OD-10, OD-07) was not examined.

**Question for the owner:** this behavior exists today and contradicts the OD-25 sentence "no seeded randomization is introduced" only if that sentence is read as "none exists". If it means "do not add any", preserving existing behavior keeps it. Which reading, and should the readiness planner be labelled, restricted or left unchanged?

Any new or changed randomization remains a **future optional enhancement** that needs separate design, compatibility testing
against existing plans and owner authorization (`OD25-DF-0003`).

## 3. NDCA (June 2026, SHA `d1b73e1f...`): Pro/Am floor limits (`OD25-NDCA-0001`)

III.D.34 (printed p.23): in Pro/Am events where "multiple competitions" are danced at the same time, no more than eight couples
may be judged at the same time. (a) the floor may be split into two or more "ballrooms", each panel judging a maximum of eight;
(b) no "ballroom" may be smaller than 1,080 square feet; (c) after a late registration or entry change, "up to ten (10) couples"
may be on the floor "provided at least two of the entries are uncontested".

These are floor and judging-load limits for Pro/Am. They are **not** the Final cap IV.C.2 ("No more than eight (8) couples shall
dance in any Final Round"); the IV.C.1.f / IV.C.2 conflict is tracked in PR 839 (`OD09-NDCA-0004`) and stays unresolved. Studio's
default of 8 coincides numerically but implements none of (a)-(c). NOT IMPLEMENTED; a profile-activation blocker.

## 4. UCWDC Scoring Format v16.9b: Heating Rules (printed p.1; SHA `44290a06...`)

Each item is recorded with its exact modal language, because only some are mandatory:

| Item | Wording (short) | Class | Register | Blocker? |
|---|---|---|---|---|
| 1 | each division's contestants "must be randomized by the scoring system"; contestants who stay on the floor "should" retire to the back | mandatory (randomize); advisory (floor etiquette) | `OD25-UCWDC-0001` | **Yes** (randomization) |
| 1, 2, 5 | same-division heats "If space, time, and circumstance allow"; co-mingling "may" be used | permitted / conditional | `OD25-UCWDC-0002` | No |
| 2, 7 | heat size difference "should be no more than 1" | recommended | `OD25-UCWDC-0003` | No |
| 3, 7 | multiple heats "must be run in a contiguous order" | mandatory | `OD25-UCWDC-0004` | **Yes** (not enforced by either planner: 10D can reorder or separate a division's heats through floor packing) |
| 4 | "Whenever possible", the smaller heat "shall precede" the larger | conditional/advisory | `OD25-UCWDC-0005` | No (confirm with owner). Both planners put the larger heat first (10D first-fit: 8 then 1; `balancedGroups` gives the remainder to the earliest groups) |
| 5, 6 | balancing "is recommended"; modules within one "is preferred" | recommended | `OD25-UCWDC-0006` | No |

Advisory items are tracked as compliance gaps, not hard blockers, and must not be enforced as hard blockers. The mandatory items
(scoring-system randomization per division, contiguous order for multi-heat divisions) block activation of a UCWDC profile.

**Reproducible randomization (design requirement for a future profile, not implemented):** record the seed and the algorithm
version at generation; store the final assigned order; treat any re-draw as an audited new version with who, when and why; never
re-shuffle after publication; keep the evidence readable under the confidentiality and read-audit rules of OD-10 (PR 842) and the
versioning rules of OD-07 (PR 838). The existing readiness planner is not a UCWDC implementation.

## 5. WSDC Registry Event Rules v2026.1C (SHA `140caae7...`)

- **3.4 item 8 (printed p.20):** Jack and Jill contests "must maintain the integrity of random and unbiased selection (i.e.,
  rotating partners, pairing of partners, and music selection)"; partner rotation in prelims and partner selection in finals "should
  be random"; music assignments should be fair. This concerns partners and music, **not** heat sizing or grouping.
  Section 6 items 6-7 (p.23): a computerized scoring system "should" randomly assign partners and order paired competitors randomly
  (`OD25-WSDC-0001`, NOT IMPLEMENTED; partner rotation is not modelled in DanceFlow).
- **Heat size, balance, randomization of competitors into heats:** **NOT SPECIFIED IN PROVIDED SOURCE** (`OD25-WSDC-0002`). Search
  terms: heat, heats, random, rotation, rotate, draw, at the same time, simultaneous, floor, on the floor. The Venue line (competition dance floor of at least 150 square meters) is a facility size, not a limit on couples; the other hits concern Trial Events and group judging. The only "heats" hit is the
  Definitions page (the Chief Judge decides heats, number of callbacks and cuts to finals). Absence is not proof.

## 6. Blockers, coordination and what is not verified

Mandatory unimplemented requirements (NDCA III.D.34, UCWDC randomization and contiguous order, WSDC 3.4.8) are profile-activation
blockers; the advisory UCWDC items are tracked gaps only. Coordination: OD-21 (PR 847) single-couple and minimum-participation
handling; OD-24 scoring-profile architecture; OD-26 (placeholder, presented next); OD-01 (PR 832) preserved.

Not verified: tests were not run (docs only); the audit evidence of generated plans; the database behavior for a configured capacity above 100; the `effective_from` dates on the register entries (NDCA 2026-06-01, UCWDC 2026-01-01, WSDC 2026-01-17), which are not in the source registry and follow the convention of sibling entries (NDCA's rule book states no effective date: OD-30); WSDC and UCWDC rules beyond the cited and searched passages.
