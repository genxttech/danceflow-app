# Event Operations Schedule — future Competition OS slice (design only)

Status: design. Not implemented. It is a separate slice from heat generation (10D) and the setup wizard (10C.5).

## Why

Real events run many things at once across many rooms. The owner's review of the Nashville Dance Classic 2026 (Country), Cleveland DanceSport (Ballroom) and Meet Me in St. Louis 2026 (WCS) schedules shows this:

- competition;
- workshops;
- private lessons;
- social dancing;
- registration;
- contest check-in and cutoffs;
- floor trials;
- awards;
- meals;
- meetings;
- room closures and resets.

The heat generator should not absorb this. Beginner organizers should not have to build a weekend operations schedule inside the setup wizard either.

## Three separate concerns

| Concern | Answers | Shape |
|---|---|---|
| **A. Event Operations Schedule** (this slice) | What is happening, where, and when? | Event → Schedule Day → Venue Space / Room → Scheduled Activity |
| **B. Competition Program Structure** (10C.5 metadata) | What is the semantic order of competition? | Profile-driven: Country level → age → dance; Ballroom style → level → age → event; WCS contest format → division → round |
| **C. Heat / Floor Execution** (10D) | Who is physically on a competition floor now? | Competition Block → Floor Heat → Scoring Heat |

A **Venue Space / Room** is a scheduling resource. A **Competition Floor** is a competition resource inside a room. A room may hold zero floors (a workshop room), one floor, or several (Grand Ballroom → Floor A, Floor B).

## Model (conceptual)

- **`event_schedule_days`**: event, date, label, and an operating window.
- **`event_venue_spaces`**: event, name, kind (ballroom, workshop room, registration desk, lobby, other), capacity, and an optional parent space.
- **`event_competition_schedule_floors`** (exists today, 10A/10D): gains an optional `venue_space_id`. This is additive; existing floors stay valid without it.
- **`event_scheduled_activities`**:
  - event, day, space, optional floor, starts/ends, and status;
  - an activity type: competition block, workshop, social dance, registration, private lesson, floor trial, practice, awards, meal, contest check-in / cutoff, meeting, room closed / reset, party, or other;
  - optional links to a competition schedule block, a program or a contest;
  - a visibility setting: public, staff or competitors.
- **Availability and overlap rules:**
  - A space cannot host overlapping exclusive activities.
  - A floor cannot host overlapping competition blocks (this rule already exists for blocks).
  - Concurrent activities in different spaces are normal.
- **Recommendations (later):** use the 10C.5 programming metadata (hierarchy, dance sequence, special-offering boundary) plus entry volume to suggest days, program blocks, rooms and floors. The organizer approves; nothing is placed without approval.
- **Displays:** a day-by-room grid for staff, a public program, and a per-competitor itinerary.

## 10D compatibility (read-only audit, DEV schema)

| Question | Finding |
|---|---|
| Can existing floor rows later belong to rooms? | Yes. `event_competition_schedule_floors` is event-scoped (name, location_label, capacity, active, configuration). Adding a nullable `venue_space_id` is additive. |
| Can multiple floors be added without replacing Floor Heat? | Yes. Floors are already many per event, and `event_competition_floor_heats.floor_id` and `event_competition_schedule_blocks.floor_id` already exist. Floor-heat numbers are unique per schedule version, i.e. global across floors. Numbering per floor would be an additive constraint change, not a new model. |
| Can competition blocks run concurrently on different floors? | Structurally yes. Publishing refuses overlapping blocks only on the *same* floor. The simple (numbered floor-heat) planner remains a one-floor v1. |
| Does Floor Heat survive unchanged? | Yes. |
| Does Scoring Heat survive unchanged? | Yes. |
| Additive future schema or replacement? | Additive. |
| Existing overlap | June-era `schedule_blocks.block_type` already includes workshop, meal, awards, practice, registration, showcase, break and other. Those are competition-schedule blocks. The operations slice would reference competition blocks rather than duplicate non-competition activity there. |

**Important future issue.** Competitor conflict detection across floors must become **time-aware**. Today the simple planner's conflict check works on numbered floor heats on one floor. With concurrent floors, a dancer in heat 101 on Floor A and heat 102 on Floor B at the same time must be detected from planned times. Not implemented in 10C.5.

No structural blocker was found, and no 10D schema change was made in 10C.5.
