# R-03, R-04, R-05, R-09: Studio/Custom wording and availability (display layer only)

Owner ratifications 2026-11-23. Stacked on OD-28. No SQL, migration, scoring engine, merge or deploy. Register entries: `governance/rule-register/rules/R03-*, R04-*, R05-*, R09-*`. Code: `setup/studioCustomDisplay.ts`, `results/resultLabels.ts`, `results/viewer.ts` (`placementLabel`), the organizer round page, `participantRoles.ts` (`DANCEFLOW_ROLE_NOTE`).

## R-03: one Studio Open division, no body division rules
- Relabelled (ids unchanged): `ndca_mixed_amateur` "Studio/Custom: Mixed partnership", `ndca_mixed_professional` "Studio/Custom: Mixed professional couples", `ndca_pro_am_theatrical` "Studio/Custom: Pro-Am theatrical", `ndca_pro_am_exhibition` "Studio/Custom: Pro-Am exhibition" (Showdance, Cabaret, Theatre Arts, Formation, Team Match were done in OD-19/OD-28). The `open_only` scheme (axis skill_level, value Open) is untouched.
- NDCA partnership/registration rules (II.A.5.a Mixed Amateur, II.B.2 Mixed Professional) are recorded NOT IMPLEMENTED (`R03-NDCA-MIXED-*`), coordinated with OD-18.
- Studio age categories are organizer-defined; the age axis note discloses that no age range is validated automatically; "Youth" is no longer an offered choice (availability), while a saved configuration containing it still loads (tested). A user can still type "Youth" as a custom value; OD-02 refuses under-18 competitors whatever the label. Organizer-configurable age ranges are a separate design opportunity (thresholds, validation, audit history, compatibility review): not implemented.
- Out of scope but notable: Country Junior*, Ballroom Pre-Teen/Junior/Youth and WCS Juniors are still offered by the non-Studio schemes while OD-02 prohibits under-18 competitors.

### Pro/Am Theatrical and Pro/Am Exhibition: what the Rule Book says (pinned PDF, SHA d1b73e1f...)
- II.B.7.c (printed p7): "PRO/AM competitions may offer any or all of the following divisions" followed by the list including "THEATRICAL; EXHIBITION".
- IX, Lifts and Dangerous Movements (1) (printed p39): "Lifts are allowed in the Theatrical, Showdance, Grand Championship and Exhibition/Cabaret" categories only.
- IX.A.1 (printed p38): "with the exception of Exhibition/Cabaret, all couples must dance all dances".
- No definition of a Pro/Am Theatrical or Pro/Am Exhibition division was found beyond these. Nothing is inferred; the new copy says only that the organizer defines the division and that DanceFlow applies no lift or dance rules. Entry `R03-NDCA-PROAM-THEATRICAL-EXHIBITION` (requires_interpretation).

### Formation / Team Match scoring readiness (exact result)
Both are team offerings in the Ballroom style, whose only judging option is Placements, so the round's legacy `scoring_method` is `ordinal_majority`, which resolves to the approved Studio ordinal majority engine. `studioReadiness.ts` therefore counts the round as configured (no notice); it raises the blocker `COMP_ORDINAL_MULTI_HEAT` only when the round has more than one heat. Result calculation, approval and publication work with Studio placements. Nothing implements NDCA cumulative-point scoring (III.D.11), and nothing in the UI says it does; the new descriptions say scoring follows the style's judging method. Separately (OD-28): a Country Team (Medal Marks) or a Studio team judged by Ratings has no calculable method and is only a readiness NOTICE, so it can be published. No guard added; reported separately.

## R-04: DanceFlow person types
`PERSON_TYPES` and `RELATIONSHIP_ROLES` are unchanged and snapshot-tested with the validation messages. `DANCEFLOW_ROLE_NOTE` states they are DanceFlow roster classifications that establish no body professional registration (NDCA II.A.1), Pro/Am Student status (II.A.4) or credential, and that Alternate is not the NDCA formation reserve rule (XII.C.7, recorded in `OD28-NDCA-FORMATION-AGE-SUBSTITUTION`). It is NOT yet displayed: the public builder is being changed by the OD-02/OD-03 PRs; wire it beside the person-type picker after they land.

### OD-02 coverage per pathway (alternates, reserves, roster changes)
| Path | Under-18 protection | Verdict |
|---|---|---|
| Public registration (`POST /api/events/[slug]/competition/checkout`; quote/start RPCs are service_role only) | OD-02 gate (PR 835) evaluates every person in `participantIds`, including alternates and team members; a roster person with an under-18 DOB is refused even outside an entry | Covered, once PR 835 is on the line |
| Studio-side registration | same route, same gate | Covered |
| Staff-created entry | no application route exists; a manager can write entries and participants through the table API (`competition_manage`, all operations) | **Unprotected: release blocker** (needs a SQL guard) |
| Team roster add/replace/substitution, entry edits after registration | no application route; same table-API path | **Unprotected: release blocker** |
| Alternate/reserve listed only on the roster | not an entry participant, so not evaluated unless it supplies a DOB under 18 | Covered by the DOB rule; no reserve concept in the data |
| Later confirmation | OD-03 re-reads every participant's stored DOB and fails a missing DOB | Covers the application layer; direct heat-entry and status writes skip it |
No application-layer fix exists for the unprotected paths: they are database writes. Needed SQL (separate approval): a trigger on `event_competition_entry_participants` (and entries/heat entries) that refuses a participant without a stored adult date of birth, plus the U18 heat-entry guard.

## R-05: Multi-Dance and Solo
- Multi-Dance minimum (2 dances, prescribed sets, style order) unchanged; descriptions now say it is DanceFlow Studio policy and that nine- and ten-dance events are not currently supported (no claim about NDCA). Names unchanged.
- Country Solo: "Studio/Custom: Solo routine", described as DanceFlow's own format, not UCWDC Solo Medley (II.A.20) or Showdance (II.A.21).
- Register: `R05-NDCA-TEN-DANCE` (III.D.36 is on printed p23 and III.D.38 on p24, not p22 as in the request), `R05-NDCA-ALL-DANCES-AND-ORDER` (IX.A.1.a-d read separately: Rhythm is professional championships only, and the order is recommended, not required, for other competitions), `R05-UCWDC-SOLO-MEDLEY-SHOWDANCE`. None may block eligible Studio/Custom competitions.
- **Skipped-dance finding:** a Multi-Dance category cannot open registration (`COMP10C_REGISTRATION_HOLD`, any category with `registration_hold`), and the Studio engines refuse a multi-dance run (`multi_dance_unsupported`, X-6). So a couple that skips or is excused from a dance is never scored or combined today; no "must dance all dances" rule exists or is claimed. Scratching a heat entry affects only that heat. Unsupported dance combinations cannot reach a calculable result; the only readiness exposure is the general one above.

## R-09: "Not called back"
Stored label `Semi-final` (engine constant, PV-1 recompute, stored output) is unchanged. Display mapping `displayResultLabel` and `notAdvancedWording`; `placementLabel(row, roundType)` shows "Not called back" for a non-final round row with `advanced === false`, and the organizer round page shows it for callback preliminaries.

| Surface | Renders the stored label raw? | Result |
|---|---|---|
| Organizer round review (`results/[roundId]/page.tsx`) | no: shows placement and advanced/not advanced; the review RPC rows carry no `output` | now "Not called back" for callback preliminaries |
| Public/entrant results (`events/[slug]/competition/results/page.tsx` via `viewer.ts`) | no: `parseViewerRounds` drops `output` | now "Not called back" for non-final rounds |
| `CallbackPanels.tsx`, advancement preview | no | unchanged |
| `unresolvedTie.ts` | label there is a couple name | n/a |
| Setup wizard copy | no "semi-final" outside real NDCA/UCWDC source references (`scoringReference.ts`, profile dance-set notes) | unchanged |
| Exports (CSV/PDF/print) | none exist for results | n/a |
| SQL RPCs (`competition_round_results_review`, publication readers) | return placement/advanced only; the SQL still writes `Semi-final` into `output` (PV-1) | not touched, no blocked surface found |
Any future surface that prints `output.label` must use `displayResultLabel`.
