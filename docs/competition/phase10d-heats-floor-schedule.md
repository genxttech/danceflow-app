# Phase 10D — Heats + Floor Schedule v1

Migration `20261111090000_phase10d_heats_floor_schedule.sql` (rollback in `rollback/`), suite
`sql-tests/test_T_phase10d_floor_schedule.sql`, planner `src/lib/competition/floorPlanner.ts`.

## Two heat concepts

| Concept | Table | Meaning |
| --- | --- | --- |
| Scoring heat | `event_competition_heats` (existing) | One division + round (+ dance for per-dance divisions); the entries judged together. Entries via `event_competition_heat_entries`. 10A audited lock states unchanged. |
| Floor heat | `event_competition_floor_heats` (new) | The numbered unit called to the floor ("Heat 12") in one schedule version. Holds one or more scoring heats that share one music/run context. |

`event_competition_heats.floor_heat_id` places a scoring heat in exactly one floor heat; a composite FK
`(floor_heat_id, schedule_version_id, event_id)` keeps both in the same event and version. A scoring heat
is placed in a floor heat (SIMPLE) or a time block (ADVANCED), never both.

## Planning modes, one authority

- **Simple** (canonical Schedule & Heats page): sequence-first numbered floor heats.
- **Advanced** (`/competition/advanced/schedule`, readiness, generation): the June time-block planner,
  unchanged (sessions → blocks → scoring heats, constraint runs, proposal review, apply).

Both use schedule versions and the same `publish_competition_schedule_version` /
`build_competition_schedule_snapshot` / `create_competition_schedule_version`. Publishing accepts a
version with sessions or with floor heats; the snapshot adds `floor_heats` (number, floor, planned time,
scoring heats, dances, entries with entry numbers and each competitor's relationship and lead/follow).
Creating a version from a floor-heat version copies its running order (only still-confirmed, eligible
entries) into a new draft.

## Rules

Hard (database):
- same event / version / division / round ownership; one floor-heat placement per scoring heat;
- running order changes only while the version is a draft (published = frozen; edit a new version);
  day-of status updates on heat entries (check-in, scratched, danced) stay allowed;
- a competitor appears in at most one entry per floor heat and per scoring heat
  (heat entry → entry → entry participant → `competitor_id`);
- all scoring heats in a floor heat share one music key;
- only `confirmed` entries that are not `ineligible` can be scheduled; per-dance divisions require the
  entry's registration for that dance; scoring-heat capacity per round.

Soft (app only): floor size above the recommendation (8 entries) is a warning.

Music key (`_comp10d_heat_music_key`, mirrored by `musicKeyFor`): `dance:<key>` for one dance,
`set:<keys>` for a prescribed set, `exclusive:<heat>` for routines/own music (selection mode
`routine`/`none`, contest types showdance, cabaret, formation, team, spotlight) or unknown dances.

Numbering: contiguous positive integers per version = running order. Insert, move and delete renumber
atomically while draft; an emptied floor heat is removed and the order closes the gap.

Capacity: 8 entries per scoring heat (DanceFlow product default, not a sanctioning rule), editable per
round in `event_competition_rounds.configuration.max_entries_per_heat`.

## Generation (deterministic)

Division (contest order) → first round → dance/run unit → split by capacity without putting one
competitor twice in a scoring heat → pack into the earliest floor heat with the same music key, no shared
competitor and room under the recommendation; routines get their own floor heat.

## Deferred

Per-heat J&J pairing records (a J&J entry stays one competitor with lead/follow; pairings belong to the
round/officials workflow), multi-floor UX, timing forecasts, public heat sheet, re-checking conflicts when
entry participants change after placement, officials / ballots / scoring / results.
