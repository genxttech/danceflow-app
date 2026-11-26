# Option B2: contest identity fixed at publication (design only)

**Status: DESIGN. No code, no migration, nothing applied, nothing executed.** Owner decision 2026-11-26: design B2 (documents only); B1 is not chosen; no interim rule is built. DanceFlow Studio/Custom policy, not a governing-body rule.
An independent reviewer checked a first draft by reading and found that it did **not** close what it claimed (a spare two-stage chain, unbound sibling rounds, mutable dance identity, binding rules that broke advancement). This revision changes sections 3 to 14 in response and **has not been re-reviewed**.
Code claims cite files under `src/lib/supabase/migrations/` (short: the timestamp) or `src/`, read on `release/website-embeds`. **Every behavior described for B2 is unexecuted.**

## 1. What B2 must stop

Executed locally (PR 865, section 12a): from a published never-run spare heat installed by fixture, one manager published a self-approved replacement of a corrected result: spare round with the corrected round left alone (NC), cancelled (CS) or independently approved then cancelled (CA), and a spare heat moved to a new round (R). Reading shows the database planner function and publication would accept a spare round; the app planner does not create one (it schedules only the lowest-sequence round per division, `src/lib/competition/floorPlanner.ts:136`).

## 2. Verified facts the design rests on (code reading)

| Fact | Evidence |
|---|---|
| Only two stages can produce a result: a **preliminary** callback round in a `promote_callback` program, and a **final** | callback engine: `20270215090000` ~L223-224 (`round_not_callback`), `results/engines/studioCallbackTally.ts:51`; ordinal engine: `20270215090000:368-369` (`round_type_not_final`) |
| Studio setup shapes a division as one Final, or one preliminary then one Final | `src/lib/competition/scoring/studioSetup.ts:36-41, 185-190` |
| The schema also allows qualifying, quarterfinal, semifinal and other types, but no engine scores them and nothing advances them | `20260620_competition_foundation_v1.sql` ~L92-93; engines above |
| A new running order can still be published while a round holds ballots if no heat has the status staging, active or complete (heats can count as danced through entry or lock state) | `20270106090000:284-292`; HL1 `20270119090000` ~L55-60 |
| `dance_id`, `dance_key` and `dance_label` on a heat are written independently; the foreign key is on (dance_id, event) only | `20260621_competition_heat_planning_v1.sql:85-110` |
| The only advancement is preliminary (sequence n) to Final (sequence n+1) of the same division; target chosen from manager-written type and sequence | `20270120090000:209-233` (`_cf1_callback_successor` / `_source`); writer `apply_competition_round_advancement` L1236; records L100-140 (insert-only, definer-written), plus revocations |
| The Final receives its heat **from advancement**, written into the live order; advancement requires the Final to have no heats | `20270120090000` L1394-1408; `COMP_ADVANCEMENT_FINAL_HEATS_PRESENT` |
| **Multi-dance results cannot be calculated today** (verified): both engines refuse a dance count other than one | `20270215090000:175-176` (shared panel step, called by callback L267 and ordinal L378) and `:244-245`; TypeScript `results/engines/common.ts:298`, `studioCallbackTally.ts:99`; advancement refuses too (`20270120090000:1201, 1349`) |
| The floor planner makes one scoring heat per dance inside the same round for per-dance divisions, so such a round with two or more dances cannot be calculated | `floorPlanner.ts:145-150` with the row above |
| Dance catalog rows are per program, unique only on `dance_key`; the name is free; any event manager may write them; no lock at program publication was found | `20260620_competition_dance_catalog_v1.sql:7-29, 129-137` |
| Result evidence names dances as `coalesce(dance_id, dance_key)` | `20270114090000:613` |
| Publication writes an event snapshot (rounds, dances, entries); publication rows are directly insertable by managers, so they are **not** trusted lineage | `20260620_competition_generation_operations_v1.sql` (table); `20261111090000:866-1055`; insert grant per the Option D review |
| Locked programs freeze a round's type, sequence, division and program only **after** insert; new rounds are inserted freely | `20270116090000:50-85` |

## 3. Data model

All new tables: RLS on, **no write privilege for any API role** (select for managers), written only by SECURITY DEFINER functions, UPDATE / DELETE / TRUNCATE refused by `protect_competition_history_evidence`, triggers ENABLE ALWAYS (the A7 pattern).

* `event_competition_contest_slots`: `id, event_id, program_id, division_id, dance_identity text, depth int, created_at, created_by, transaction_id`; **unique (event_id, division_id, dance_identity, depth)**.
  One slot is "this division, this dance, this stage". Depth 0 is the first stage; depth n+1 exists only by advancement.
* `event_competition_contest_slot_rounds`: `slot_id, round_id, event_id, bound_via ('publication'|'advancement'), schedule_version_id, advancement_id, bound_at, bound_by`; unique (round_id, slot_id); **a round's depth is fixed by its first binding** (a later binding at another depth is refused).
* `event_competition_contest_slot_refusals` is not needed: refusals raise.

**One slot per dance**, not per dance set: a round holding Waltz and Tango binds two slots, so a round with an overlapping set cannot escape. Entries are **not** part of the key, so a second entry set in the same division and dance lands in the same slot.

**References:** the slot tables reference only the event (cascade, the same exception as other history). Round and division ids carry no foreign key, so removing a never-run division or round before publication keeps working; a left-over row is harmless (a round with ballots or results cannot be deleted).

## 4. Stage comes only from the advancement graph

* **Publication binds depth 0 only, and never binds a callback Final.** For every round with heats in the version being published, one binding per heat dance to the division's depth-0 slot, whatever the round's name or sequence. A round that is shaped as the target of a callback (final, directly after a preliminary, in a `promote_callback` program) is **left unbound**: only advancement may bind it. Reading those labels here can only withhold a binding (unbound is the stricter state), never grant one.
* **Advancement binds depth n+1.** `apply_competition_round_advancement`, in its own transaction, binds the target to the slot at (source depth + 1) for each of its dances, with the advancement id. No other path creates a deeper slot.
  * Source unbound or without a catalog dance: the advancement still succeeds and the target stays unbound (never fail an advancement).
  * Re-advancement after a revocation: an existing identical binding is left as it is; section 6 reads the advancement tables, not the binding's advancement id.
* A round already bound that is republished with another dance, or at a depth that would conflict, **stays unbound for that dance**; publication is never refused for this. Unbound for any of its dances means replacement (section 6).
* So a spare round published by a manager is depth 0 (the same slot as the first round of that division and dance) or unbound.

Stages needing an advancement model before they can have their own slot: qualifying, quarterfinal, semifinal and any multi-round chain. None can produce a result today, so nothing in use is lost. A preliminary in a program that does not advance by callback shares depth 0 with the division's Final: the second of them needs a second manager.

## 5. Dance identity, locking, deduplication

* `dance_identity` = the catalog dance's `dance_key`, normalized (trim, lower case, spaces and punctuation removed).
* **At running-order publication** (not only at profile lock, which publication does not require): every heat dance must carry a catalog `dance_id` of the round's program; its `dance_key` and `dance_label` must equal the catalog row's; and the program's catalog must have no two rows whose normalized key or name equal each other (key against key, name against name, key against name). Programs locked before B2 are checked here too.
* **Freeze:** a catalog row referenced by any binding or any published heat can no longer change its key or name or be deleted, whatever the program's lock state; after profile lock no dance is added either (new guard).
* A result whose evidence names a dance that does not map to a bound slot gets no single-staff override (fail closed).
* **Residual, stated:** synonyms ("Waltz" and "Slow Waltz") and look-alike or zero-width characters in custom names are different identities to this rule. Closing that needs a fixed taxonomy from the locked rules profile, with custom dances losing the override (owner question Q2).

## 6. The rule

For a round r with a result version V, define **own(r)** as true when any of:
1. r is not bound for **every** dance of V and of its current published heats (unbound = fail closed);
2. another round **of a slot of r** has ever had a ballot or a result version (cancelled or not). Slot membership is the bindings **together with** the dances of currently published heats, so a dance row changed during publication cannot hide a sibling;
3. another round of the **same division** has a ballot or a result version and is **not bound** for all its dances (a legacy or unbound sibling counts against everyone);
4. r has depth > 0 and there is no unrevoked advancement into r whose source round is bound to the depth-1 slot, is not cancelled, and whose source version is still that round's approved version.

**replacement(r) = own(r), or replacement(s) for any advancement source s of r, evaluated now, back to depth 0.** Rules 2 and 3 ignore r's own advancement ancestors as "other rounds". Without the transitive part, a manager can build a spare preliminary and Final beside a real single Final, approve the spare preliminary before the real round has ballots, advance it, and self-approve the spare Final.

**Approval** (`approve_competition_round_result`, on top of PR 865's post text md5 `2d178c29177ebf2ec14a46bf510ccc12`): PR 865's initial / corrected rule is unchanged and runs first. If replacement(r): no single-staff override, and the approver must not be the calculator nor anyone who **opened a correction of, or cancelled,** any round in the slots of r **or of its advancement ancestors** (new code `COMP_REPLACEMENT_APPROVER_REQUIRED`).

**Result publication re-applies the whole test** (`publish_competition_round_result`, `20270122090000:352`; its text md5 is to be pinned at implementation, not yet computed): if replacement(r) is true at publication time, the version's approval must satisfy the approval condition as of now (approver not the calculator, opener or canceller), whether it was an override or an ordinary approval. This covers a spare approved first and the real round run, corrected or cancelled before publication.

**Timing and locks.** The test is a check at the moment of approval and of publication, taken under the existing round lock. B2 does **not** add an event lock to ballot filing, calculation or correction (that would redefine pinned E2 and F2 functions with no slot here). A concurrent first ballot in a sibling round is therefore equivalent to that ballot arriving just after: publication re-checks, and what slips past both is exactly the residual "published before the other round had a ballot".

## 7. Planner and publication changes

* `publish_competition_schedule_version` (after Option D it is definer and locks the version; pin D's post md5 `abccc653c7c2380c7ec65c97a54526dd`): check catalog dance ids, create missing depth-0 slots, insert bindings, all in the publication transaction. Publication of a version is already refused once any heat has run (`COMPO1_RUN_IN_PROGRESS`).
* Owner question Q1: also **refuse** to publish a second round into a slot (no spare rounds at all), or allow it and rely on section 6. Refusing is the only thing that closes the first-published-spare residual.
* `apply_competition_round_advancement`: add the depth binding (pinned replacement).
* App (separate PR, before the approval change is applied): show "this approval needs a second manager" and why; warn in the planner when a publication would create a second round in a slot; map the new code. The app planner needs no behavior change to stay correct.

## 8. Residuals

| Case | Under B2 |
|---|---|
| NC, CS, CA, R | **closed by design**: same division and dance means same slot, which has ballots (R's new round is also unbound) |
| Spare preliminary plus Final beside a single Final, real round run before the spare Final is approved or published | closed by the transitive rule |
| Round left with ballots and never calculated, then a spare | closed (ballots count) |
| Legacy or unbound sibling with ballots | closed (rule 3) |
| Spare run first and approved, real round run before result publication | closed at publication |
| **Spare approved AND published before the real round's first ballot** (marks can be known before filing: paper ballots, watching the floor) | **open**: nothing existed to compare with. Closed only if spare rounds cannot be published (Q1) |
| Second entry set in the same division | closed (entries are not in the key) |
| Duplicate catalog records with equal key or name | closed (section 5) |
| Synonym or look-alike dance names | **open** (Q2) |
| A **second division** (or program) with the same people and dance | **open**: nothing trusted distinguishes it from a legitimate category. It has to be in a published order; that no new order can be published after heats ran depends on heat run statuses, hence on U18. A publication-time refusal of identical rosters is possible but would also refuse legitimate twins (Q3) |
| **Another event** | **open**, out of scope: a different competition |
| Direct publication-row inserts, round renaming | not lineage; see Option D's list |
| Database superuser | outside the threat model (as for the history triggers) |

**New refusals of legitimate work:** two rounds of the same division and dance that are not advancement (flights run as separate rounds, a re-dance after a floor incident, a non-callback preliminary before a Final) need a second manager (Q4, Q6); so does every round of a division while any sibling with ballots is unbound (typical for events already running when B2 is applied). Single-manager initial approval is unchanged for the only round of a slot, including a Final reached by advancement. Multi-dance changes nothing today (not calculable).

## 9. Already published orders and rollback

* No backfill of history by default: existing rounds are unbound, so they need a second manager until a publication or advancement binds them; an event with a heat in a run status cannot re-publish, so its rounds stay unbound (an event whose heats count as danced only through entry or lock state can still publish). Hosted counts read 2026-11-26: 0 approval rows on DEV and PROD; entry counts were not re-read for this design. Re-check before any apply (Q7).
* Rollback per step restores pinned function texts. Slot tables hold history: rollback keeps them; dropping them is a separate step allowed only when empty. Rolling back the approval step re-opens the four routes. Order: approval and result publication, then advancement, publication binding, tables, dance guard; Option D and PR 865 are rolled back only after the steps that pin them.

## 10. Interplay

| Item | Effect |
|---|---|
| PR 865 (R-11) | prerequisite; B2 redefines approval on its pinned text and adds history beside its three sources |
| Option D (PR 899) | prerequisite: bindings mean little if published placement can be rewritten; B2 pins D's publication text |
| U18 (PR 867) | prerequisite for the "no new order after a heat ran" property and so for the bounded second-division residual (otherwise direct danced writes avoid it) |
| OD-07 (PR 838) | a post-completion correction stays in the same round, so same slot; any OD-07 path that creates a replacement round must bind the same slot and count as replacement |
| OD-12 (PR 845) | paper ballots count as ballots; a verification step adds nothing to lineage |
| OD-26 (PR 854) | reorders numbered heats only; bindings do not depend on heat numbers. A future move of an entry or round between published heats must not rebind |
| S3 (PR 864) | panel readiness: none |
| S4 (PR 866) | `r15_guard_version_publish` runs inside the same publication transaction and may refuse first; no shared function redefined |
| S5 (PR 863) | participant age: none |
| S6 | not examined |

## 11. Test matrix (all to be written; none executed)

| # | Case | Expected |
|---|---|---|
| T1-T4 | NC, CS, CA, R replayed from the probe | override refused; calculator, opener and canceller refused; an independent manager approves |
| T5 | ballots locked, never calculated, round cancelled, spare run | refused |
| T5b | single Final against a spare preliminary plus Final (spare preliminary approved first) | spare Final refused at approval and publication |
| T5c | legacy or unbound sibling with ballots, spare published after B2 | refused |
| T5d | spare approved by another manager, original then corrected or cancelled by A, publish attempted | refused while the approver is the calculator, opener or canceller |
| T6 | spare first (self-approved), then original with ballots, publish the spare | publication refused |
| T7 | second entry set, same division and dance | same slot, refused |
| T8 | duplicate normalized key or name at publication; rename or delete of a referenced dance, locked or not; heat label differing from the catalog row | refused |
| T9 | free-text heat dance at publication; result with unmapped dance | refused / no override |
| T10 | preliminary to Final by advancement, single manager; Final with draft heats published before advancing; revoke then re-advance | override allowed on both; publication never binds the Final; re-advance succeeds |
| T11 | Final after the advancement is revoked, or source cancelled or corrected | needs second manager |
| T12 | spare "Final" published without advancement after a callback | depth 0: needs second manager |
| T13 | separate one-dance rounds for different dances; same couple in two divisions | override allowed (documented residual for the second) |
| T14 | multi-dance round | calculation refused (unchanged) |
| T15 | single round of a slot; correction then self-approval | allowed; then refused by PR 865 |
| T16 | unbound legacy round | needs second manager |
| T17 | concurrency: publish vs approve, advancement vs approve, sibling ballot vs approve, two publications | consistent bindings; a sibling ballot racing approval is caught at result publication |
| T18 | history: update / delete / truncate of slots and bindings; API-role writes; event deletion cascade | refused / cascade only |
| T19 | rollback and re-apply per step; md5 pins; ACL unchanged | exact |
| T20 | existing suites (F2, A0 advancement, A3, A5, A6, F3, 10D, O1, R-11, D) before and after | no regression |

## 12. Phased plan (slots `20270301160000`-`169000`)

| Slot | PR | Content | Needs |
|---|---|---|---|
| `160000` | B2-1 | dance catalog identity, dedupe and lock guard | none (independent) |
| `161000` | B2-2 | slot and binding tables, immutability, read functions | B2-1 |
| `162000` | B2-3 | publication binds depth 0 and checks dance identity | Option D, B2-2, U18 |
| `163000` | B2-4 | advancement binds depth n+1 | B2-2, B2-3 |
| no SQL | B2-app | messages and planner warnings | before B2-5 is applied |
| `164000` | B2-5 | approval and result-publication rule | PR 865, B2-3, B2-4, U18 |
| `165000`-`169000` | reserved | follow-ups (optional backfill, taxonomy) | |

Each PR: forward, rollback, SQL suite, local run, independent review. None is authorized yet.

## 13. Open owner questions (ask one at a time, in this order)

1. **Q1.** May a published running order hold a second round for the same division and dance (a spare)? *Refuse at publication* (recommended: it is the only closure of the first-published-spare residual), or allow and require a second manager.
2. **Q2.** Custom dances: accept per-program deduplication (synonyms remain open), or require rules-profile dance identities and withdraw the single-staff override from custom dances?
3. **Q3.** A second division with the same people and dance: accept and disclose (recommended), or refuse identical rosters at publication?
4. **Q4.** Should rounds of one division and dance that are not advancement (flights) require a second manager? (As designed: yes.)
5. **Q5.** Is the person who cancelled a round of the slot barred from approving its replacement, like a correction opener? (As designed: yes.)
6. **Q6.** A single-manager studio can then never approve a genuine re-dance: accept, or define a fallback inside OD-07?
7. **Q7.** Existing published orders: leave unbound, needing a second manager (recommended), or build a reviewed backfill?

## 14. Not verified

Every B2 behavior; the post-revision design itself (not re-reviewed); the md5 of the result-publication function; whether any other writer creates result-bearing stages; the sibling-ballot race; S6; hosted grants and data beyond the 2026-11-26 approval counts.
