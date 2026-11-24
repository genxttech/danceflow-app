# OD-28: team offerings are DanceFlow Studio/Custom formats (Option B)

Owner decision 2026-11-23. Stacked on OD-20 (PR 853) and OD-19 (PR 848). Display wording only: no SQL, migration, scoring engine, merge or deploy. Register entries: `governance/rule-register/rules/OD28-*.json`.

## What changed
`studioCustomDisplay.ts` now also covers the four team formats (persisted ids unchanged; each carries `entryFormat: "team"` so it only applies to a team definition):

| Id | Was | Now |
|---|---|---|
| `team` | Team | Studio/Custom: Team |
| `ndca_formation` | Formation | Studio/Custom: Formation team |
| `ndca_team_match` | Team Match | Studio/Custom: Team match |
| `studio_team` | Team (Studio) | Studio/Custom: Team |

Unchanged and tested: 2 to 100 members, `team_member` role, no lead/follow, pricing models and default, contest type, adjudication override flag, payload ids. No body team rule (size 4 to 8, couple make-up, ages, once-per-division) is added to the generic model.

## Scoring capability (finding; no guard implemented)
Team offerings have no scoring of their own (`adjudication_override: false`); they inherit the style's judging method, and the round's legacy `scoring_method` is interpreted through the registry map.

| Offering | Style judging | Round scoring_method | Result |
|---|---|---|---|
| Formation team, Team match (Ballroom) | Placements | `ordinal_majority` | Studio ordinal majority engine resolves; entry-based ranking, no team logic, no NDCA cumulative-point system |
| Team (Country) | Medal Marks | `custom` | `COMP_METHOD_LEGACY_UNMAPPED`: fails closed, no result can be calculated |
| Studio team (Custom style) | Placements | `ordinal_majority` | works as above |
| Studio team (Custom style) | Ratings | `proficiency_rating` | `COMP_ENGINE_NOT_AVAILABLE`: fails closed (method rejected) |

Result calculation fails closed (a pinned, approved method is required; there is no fallback). But readiness does not: a draft round with no calculable method is only a NOTICE (`COMP_SCORING_NO_METHOD`, `studioReadiness.ts`), `publishScoringBlockers` passes blockers only, so the program can be published, and the readiness page can show "Studio scoring methods" as Ready (with `COMPETITION_FINALS_ENABLED` off there is no scoring check at all). So a Country Team, or a Custom team judged by Ratings, can be chosen, published and shown as Ready while it can never produce results. This predates OD-28 and is not team-specific (every Country offering under Medal Marks has it). A capability guard (for example hiding or warning in review) is reported separately and is not implemented here. NDCA III.D.11 cumulative scoring is not implemented anywhere.

## OD-02 under-18, per team member (finding)
- Public path: the only way to create entries is `POST /api/events/[slug]/competition/checkout`; `quote_competition_registration` and `start_competition_registration` are granted to `service_role` only. In the OD-02 branch (`origin/od02-minors-restriction`, PR 835) `evaluateCompetitionAdultGate` evaluates EVERY person in `participantIds` individually (a team of 2 to 100 members is a list of people), failing closed on a missing or invalid date of birth. OD-03 (`eligibilityGate.ts`) also requires every participant to have a stored adult date of birth before confirmation. A team-name check in the quote is unrelated to age.
- Wording caveats: the name "Team match" is an NDCA-defined term kept as a plain description of the offering; "no governing-body formation rules (team size, couple make-up, ages)" does not remove DanceFlow's own OD-02 adult-only rule.
- **Exact gap:** no application route replaces or adds team members after registration, but the `competition_manage` policy gives an organizer or studio manager (`can_manage_event_competition`) all operations on `event_competition_entry_participants`, `event_competition_entries` and `event_competition_heat_entries` through the table API (policy created in `20260620_competition_foundation_v1.sql`; no later revoke found). A roster substitution or staff-created entry written that way has no database-level age check: a participant inserted without a competitor gets a competitor with a NULL date of birth (trigger `_comp10c_participant_competitor`), and a linked existing competitor may have no adult date of birth on file. OD-03's TypeScript layer re-reads every participant's stored date of birth at confirmation and in operational checks, so it would catch a NULL date of birth there; direct writes to heat entries and to entry status/eligibility skip that gate. Closing it needs a SQL guard (separate owner approval). The date of birth is also self-declared in the draft, not verified.
- None of the OD-02/OD-03/OD-18 code is on this base, so per-member tests cannot run here; they belong to those PRs (a team case with one under-18 member among adults is the test to require there). The OD-01 (PR 832) bypass test for body-declared events is likewise not possible on this base.

## Sources re-read in the pinned PDFs (2026-11-23)
NDCA XII.D p49 (four to eight couples per style; sex-specific couple wording), XII.C.1-7 p48, Team Match definition ("maximum of 5 Teams", cumulative point system, maximum of three adjudicators), III.D.11 p21 versus the formation rule "The Skating System of Scrutineering must be used", II.A.7.a ("without regard to the sex or gender of the dancer"). The XII.D versus II.A.7.a couple-definition conflict (CL-11) is preserved: no reconciliation, no gender collection. UCWDC Teams (SHA 7e71fdce...): II.C, II.D.1, II.E (Teams 3 or more members versus ShowTime any number), II.F.1.a, II.G.1.a-d.

## Known gap (same as OD-19)
The category name saved for new setups still comes from the immutable SQL profile ("Formation", "Team Match", "Team"). See the OD-19 doc.
