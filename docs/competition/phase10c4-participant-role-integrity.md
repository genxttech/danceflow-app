# Phase 10C.4 — Competition participant role integrity

Migration `20261110090000_phase10c4_participant_role_integrity.sql` (rollback in `rollback/`), suite
`sql-tests/test_T_phase10c4_participant_roles.sql`, plus 10C.4 scenarios in the shared pricing-parity
fixtures (TypeScript and SQL run the same cases).

## Model

Every entry participant now has two independent dimensions:

| Column | Meaning | Values |
| --- | --- | --- |
| `participant_role` | relationship / status in this entry | `dancer`, `student`, `professional`, `instructor` (the instructing pro in ProPro), `team_member`, `alternate`, `other` |
| `dance_role` | lead/follow in this entry | `leader`, `follower`, `NULL` |

Both live on `event_competition_entry_participants` and on `event_competition_registration_cart_entry_people`,
so the value survives builder → `start_competition_registration` → cart staging → canonical participant.
Lead/follow is per entry; the competitor's `primary_role` stays an event-level default only.
`competition_role_type` (primary/secondary) is now derived from `dance_role`.

## Rules (SQL authoritative: `_comp10c_allowed_roles` + `_comp10c4_participant_shape_errors`, mirrored in `src/lib/competition/participantRoles.ts`)

| Format | People | Relationship roles | Lead/follow |
| --- | --- | --- | --- |
| `pro_am` | exactly 2 | one `student` + one `professional` | one leader + one follower |
| `pro_pro` | exactly 2 | one `instructor` (instructing pro) + one `professional` (competing pro) | one leader + one follower |
| `couple`, `mixed_amateur` | exactly 2 | `dancer` | one leader + one follower |
| `professional` | exactly 2 | `professional` | one leader + one follower |
| `random_partner` (J&J) | exactly 1 | `dancer` | leader or follower; pairing stays in rounds/heats |
| `team` | rule limits | `team_member` | none |
| `solo`, `custom` | rule limits | dancer/student/professional/instructor/alternate/other | optional |

Line dance contests (`contest_type = 'line_dance'`, e.g. ProAm Line) may omit lead/follow entirely; if
given it must be a full pair. Legacy `participantRoles` of `leader`/`follower` are refused (no
compatibility window: public competition registration is OFF and the only writer ships with this change).

## Migration

Additive first (columns + checks), then a fail-closed backfill: leader/follower rows convert only for
formats whose relationship is implied (`couple`, `mixed_amateur`, `random_partner` → `dancer`;
`professional` → `professional`); any other leader/follower row aborts the migration. Then the
`participant_role` checks drop leader/follower and the two functions are replaced (bodies otherwise
identical to 10C). The rollback restores the 10C definitions verbatim and refuses if any row holds
lead/follow (or a ProPro instructor) the 10C model cannot represent.

`number_holder_role = 'leader'` (couple formats) now refers to the dance role; check-in matches it against
`dance_role` too. Heat conflict detection treats `dancer` + lead/follow as partners, as before.

## Carry-forwards (not in this slice)

NDCA Student/Student and Mixed Proficiency formats; a judged-participant marker; UCWDC / NDCA / WSDC
sanctioned profiles and profile-driven format exposure in Advanced setup; WSDC points eligibility;
couples inside teams; profile-specific minimum team size; per-round pairing records (10D+).
Studio Simple v1 is unchanged (ProAm, Couples, Solo, Showcase, Jack & Jill, Team — no ProPro).
