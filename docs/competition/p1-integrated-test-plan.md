# P1 restricted pilot: integrated test plan

Scope: OWNER-DECISIONS.md section 21 and `P1-RELEASE-PACKAGE.md` (PR 795). DanceFlow Studio/Custom pilot behaviour; nothing here states a governing-body rule. **Local only. No hosted SQL, merge, deploy, activation or provider call.** Status words: EXECUTED / PENDING / BLOCKED. The database composition has run once (`p1-integrated-run-record.md`); the application workflow, browser run and flag-off smoke are **PENDING**.

## 1. Database composition run (`scripts/qa/p1/comp-p1-integrated-run.sh`)

Composition at lock time from the PR heads: base chain from the pinned release line `57c33191` (PR 867 merged, so JC1/U18/U18-S are part of the base; released suites come from the candidate tree as before), then every correction in timestamp order: 20270219090000 (844), 090000 (865), 100000-102000 (864), 110000 (866), 120000 (863), 130000-131000 (866), 140000-141000 (877), 170000 (899), 180000-189000 (restriction).

| Phase | Chain | Evidence |
|---|---|---|
| A | base | released suites, route probe (control), catalog and trigger dump |
| B | base + corrections, no restriction | every Competition suite, route probe, Option D's planted-heat probe |
| C | B + restriction (PR 919; skipped and reported PENDING if no `2027030118x` file is on origin) | same, plus the concurrency scripts (they run on B only when there is no C) |
| D | rollback in reverse order | catalog (functions, grants, triggers, policies, columns, constraints, indexes) compared with A |
| E | re-apply | catalog compared with the last forward phase; the corrections' own suites again |

Rules: suites are unmodified where possible; every modified copy is listed in `adapted-copies.txt` and its result carries `[ADAPTED COPY]`, which is not a pass of the released suite. A concurrency script that fails is re-run on B and on the base chain for attribution. The F2 race script's TypeScript parity check cannot run from the composed copy and is not covered. If a restriction migration does not apply, phase C is BLOCKED. Interacting guards on heats, heat entries, entries and schedule versions are listed per phase (`guards-*.txt`). A suite or race that fails on B or C naming an R-15 clearance refusal is run once more on a separate database copy with PR 866's test-only fixture `r15_clearance_autoseed.sql`; those rows are `[AUTOSEED]`, prove the scenario for cleared couples only, and never replace the released result (not installed for the R-15, S5 or OD-31 negative suites; suites that seed unplaced entries need an explicit `clear_all()` call, which the runner does not add).

### Route probe (`scripts/qa/p1/probe_p1_r11_routes.sql`)

Replays NC, CS, CA and R with competition state built only through application paths; the superuser seeds identities and studio roles, computes the engine rows through a read-only helper and reads state; deferred constraints are checked per step. Verdicts: REACHED; NOT REACHED (read which guard refused first); CLOSED AT SETUP (the restriction removed a precondition, so the later route steps were not exercised); INCONCLUSIVE (the probe or something else failed: fix and re-run). A direct move of an existing published heat is observed separately. Expected in B: reachable (the package records the self-approved replacement as reachable with all existing PRs). Expected in C: closed, mostly at setup. PR 877's head is the branch tip until its rebased head is reported (`P_S6` pins it); the restriction is stacked on 877 `6c80b98a7`. First execution: inconclusive on A and B (probe defect), closed at setup on C.

Not covered by the probe: the named residual (a second contest with the same people prepared before judging: another division, program or event). Add it as a separate case once the restriction's text is final; it is expected to remain reachable.

## 2. Representative end-to-end workflow

One adult-only $0 competition, one final-only division per contest, at least two couples, judges' own electronic ballots, second-manager approval. Run first against the database (the probe's setup is the skeleton), then through the app (section 3).

| Step | Application path | Must succeed | Must be refused |
|---|---|---|---|
| Registration | simple setup, publish, open registration, staff or public $0 registration | adult with date of birth | under 18, missing date of birth (863, 835) |
| Eligibility | organizer determination (866 + app wiring, unbuilt) | eligible entry | direct table write of eligibility (131000) |
| Setup | one final per division | | callbacks, second round or heat, multi-dance, divisions or rounds added after judging starts |
| Running order | draft, floor plan, publish | publish once | direct writes to the published order (899), replacement or cancellation after start |
| Panel | officials, panel, readiness, attendance (864 + app confirm flag) | odd panel as configured | start with an unready panel |
| Heats | schedule, start, staging, active, complete, lock | | scratch or withdrawal of a started heat (877) |
| Judge ballots | each judge's own account | submit for the started heat | ballot before the heat starts, paper ballot |
| Calculate | database calculation | stable input hash | stale input |
| Approval | second manager | | approval by the calculator |
| Publication | publish to entrants and public | names and numbers as approved | one-couple final, official-body-declared event (832), corrections |

Also check: another studio's manager and anonymous callers are refused at every step; audit rows exist for approval and publication; published names and numbers do not change after publication (restriction item "frozen").

## 3. Production-build browser run

Preconditions (all PENDING): one integration branch holding the app parts of 835, 837, 846, the eligibility wiring, 864's confirm flag, 865's approval messages, 878 and the restriction messages; a local full stack (auth, REST, database with the composed chain) because the database-only image cannot serve the app; local-only keys; no Stripe, email or SMS credentials; `next build && next start` (never `next dev`); heavy lock held for build and stack.

1. Flags on, locally only: `NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED`, `COMPETITION_FINALS_ENABLED`, `COMPETITION_PUBLIC_RESULTS_ENABLED` (the `NEXT_PUBLIC_` value is inlined, so it needs its own build).
2. Walk section 2 in the browser as manager A1, manager A2, three judges, a registrant and an anonymous visitor. Record each step's screen result and database read-back; check console and failed network requests.
3. Each disabled operation: the control is absent or shows the restriction message, **and** the direct request is refused.
4. Phone-width pass of the judge ballot screen and public results.

### Flag-off smoke (separate build with all three flags unset)

- Public registration page and checkout, resume and release APIs refuse; public results page shows nothing; finals actions are refused server-side.
- No competition publication, order or provider call is created by any of those requests.
- Non-competition events, public event pages and the app's main dashboards behave as before.

## 4. Not covered by this plan

Paid checkout, refunds and registration sync against started heats (listed as unproven or to verify in the package), hosted preflights, DEV or PROD apply, load, and the OD-05 / OD-10 / OD-15 rulings.
