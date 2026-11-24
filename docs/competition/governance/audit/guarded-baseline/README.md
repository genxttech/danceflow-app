# OD-31 guarded baseline: release path, where U18 / U18-S live, and what is verified

Owner decision OD-31 (2026-11-23): **Option A, audit against the actual guarded Competition OS release candidate.** This directory holds the
read-only investigation, the negative SQL suite, the query files used against DEV/PROD, and the **appended** guarded-baseline results
([GUARDED_BASELINE_RESULTS.md](GUARDED_BASELINE_RESULTS.md)). Nothing here edits or replaces an original audit row or inventory file; historical findings stay as written.

Scope and limits: docs and a local-only test file. No migration, merge, deployment, promotion or activation, no hosted write (DEV or PROD reads only,
through `danceflow-ops/sb.sh`). U18 and U18-S are **DanceFlow integrity guards: NOT SPECIFIED IN PROVIDED SOURCE** (no rulebook basis). "U18" is a QA gate id, not an under-18 rule (under-18 is OD-02).

Evidence labels used throughout: **[EXEC]** executed SQL/application test or hosted read-only query, with the artifact named; **[INSP]** code or document inspection only;
**[REC]** taken from a repository record or an engineering note and NOT re-verified in this session.

**Final audit sign-off for the guarded baseline: BLOCKED** (reasons in section 5). Local SQL results are recorded in GUARDED_BASELINE_RESULTS.md section F.

## 1. Release-path finding

**The authoritative Competition shipping line is `release/website-embeds`, not `main` and not `release/competition-cf1-app-candidate`.** The integrated release candidate does not exist yet as one artifact.

| # | Evidence | Label |
|---|---|---|
| 1 | `release/website-embeds` was created from the live deployment's commit `c0172455` (a byte comparison of the deployed file tree against git is recorded in `docs/embeds/Release_Candidate_Path_B.md` section 1: live = Vercel project `danceflow-app-qfem`, source `cli`, i.e. production is an upload of a chosen tree, not a Git-branch auto-build) and only selected commits are cherry-picked onto it. Its head is `49dbaee1b` (2026-11-22) and it already carries the Competition CF1 app and settlement work (#745, #781, #798). | [INSP] doc + git |
| 2 | `main` is **466 commits ahead and 101 behind** `release/website-embeds`; `main` has no `CLAUDE.md`, no rulebook-governance docs and none of the live-line backports. The release doc states main-only work is excluded on purpose. | [EXEC] `git rev-list --left-right --count` |
| 3 | Every OD implementation / design PR opened under rulebook governance targets `release/website-embeds` (open drafts #832, #833, #835, #844, #848 and the docs PRs #795, #838-#854), or is stacked on one that does (#837 on #835, #846 on #837, #853 on #848). None targets `main` or the candidate branch. | [EXEC] `ghapp pr view` base refs |
| 4 | `release/competition-cf1-app-candidate` (head `92a8c17c6`, 2026-11-13) diverged from the live line at `0db5eabe9` and has **not** received the 33 later live-line commits. Its app-source difference from the live line is **one test file** (`excludedReason.u73.test.ts`); the rest is three SQL migrations, their rollbacks and SQL suites, and QA docs. It is a **migration-and-docs staging branch for the CF1 SQL release**, not a shippable app tree. | [EXEC] `git diff --stat` |
| 5 | The JC1 + U18 + U18-S SQL was **released to PROD out of that branch on 2026-11-19** under a one-time owner authorization ("JC1 + U18 + U18-S DEV-First, Then PROD"), while the app deployed from the live line (`PR 492`, `EXECUTION_EVIDENCE_2026-11-19.md`). So the *database* is already guarded while the *Git line that ships the app* does not contain the migration files. | [REC] (hosted state re-verified in section 3) |
| 6 | Governance: rulesets "Protect main" and "Protect release branches" are active on the repository (details not readable with the App token: 403). Per engineering notes, production builds from the `qfem` project are not triggered by `main`. `.github/CODEOWNERS` exists on `main` only; `release/website-embeds` has none. | [EXEC] ruleset names; [REC] notes |
| 7 | Not verifiable from here: which deployment is live *today* (no Vercel CLI in this session). Last recorded promotions (engineering notes): R+1 `dpl_FZb1Jsju…` 2026-11-19, R+3b `dpl_CTZfSRaJ…` and R+4 `dpl_ERsjXn2R…` (`e84ed0f3`) on 2026-11-22, all from the live line. | [REC] |

**Implication.** The audit baseline must be the live line plus the Competition guards plus the applicable OD implementation PRs (and SC1, section 4). Choosing the candidate branch because it "contains the guards" would audit a tree 33 commits behind what ships and missing the CF1 settlement/Path A work; choosing `release/website-embeds` as it stands would audit a tree that lacks the guard migration files even though PROD already runs them.

## 2. Ancestry and where U18 / U18-S exist

Commit ids verified with `git merge-base` / `git merge-base --is-ancestor` [EXEC]:

| Ref | Head | U18 `baa01ce40` | U18-S `c8b9a979d` | JC1 `6d1747944` | Ahead / behind vs live line |
|---|---|---|---|---|---|
| `origin/main` | `38b6277bf` | absent | absent | absent | 466 / 101 (merge-base `2cc05d9e8`) |
| `origin/release/website-embeds` (live line) | `49dbaee1b` | **absent** | **absent** | absent | 0 / 0 |
| `origin/release/competition-cf1-app-candidate` | `92a8c17c6` | **present** | **present** | present | 8 candidate-only, 33 live-line-only (merge-base `0db5eabe9`) |
| `origin/claude/cf1-u18-release-package` (PR 492, docs) | `5136bd133` | present | present | present | candidate + 4 docs commits |

The 8 candidate-only commits: JC1 (#475), QA docs (#478, #479), U73 test (#480), gate-refresh docs (#481), U18 (#483), U18-S (#487), activation-prerequisite docs (#485).
The 33 live-line-only commits are Embeds, Staff API backports, Twilio/TW-4F, Stripe-TEST guard and Competition settlement work, plus governance docs.

**Competition migration comparison** (blob ids of every `*competition*` migration, 34 on the live line vs 37 on the candidate) [EXEC]: identical except the three candidate-only files
`20270215092000_competition_jc1_inactive_judge_absent.sql`, `20270215093000_competition_u18_heat_entry_status_guard.sql`, `20270215094000_competition_u18s_heat_entry_scratch_audit.sql`.
Therefore **"live line + those three migrations" is Competition-database-identical to the candidate branch**, and the guard behaviour can be tested on that composition without importing the candidate's stale app tree.

### Does the intended release include both migrations and their dependent app changes?

* Both migrations are intended and mandatory (PR 492, `cf1-gate-refresh-2026-11-13.md`, OD-31 item 9). They are SQL-only; PR 492 records "no app change; independent of the app deploy order" [REC] and a grep of the live line confirms **no app code writes `event_competition_heat_entries.status` or `event_competition_entries.status`** (writes found: `eligibility_status`, `entry_number`, `verification_status`) [INSP/EXEC git grep].
* **Dependent application changes: none exist for U18.** For U18-S the *workflow it protects* does not exist on any release line: `change_competition_entry_lifecycle` has **no app caller** on the live line or the candidate, and `dayOf.ts scratchHref` links to `/app/events/[id]/competition/registrations/scratch/[entryId]`, which exists only on the unmerged branch `origin/competition-sc1-scratch-workflow` (PR #306, open, base `main`, last commit 2026-10-24). Until SC1 is ported to the live line, **no in-app audited scratch exists, and the U18-S guard has no client-facing legitimate path except the RPC called directly.** SC1 is therefore a dependency of the integrated candidate for Studio/Custom day-of operation, not of the guard itself. [EXEC git ls-tree/is-ancestor]
* Git/DB drift to close: PROD and DEV already contain JC1/U18/U18-S (section 3) but the shipping line's migration directory does not. Any future rebuild or replay of the chain from `release/website-embeds` would omit them. Landing the three migrations (+ rollbacks + SQL suites, byte-identical, pins below) on `release/website-embeds` is **a documentation-of-state merge, not a PROD apply**; it is a merge decision for the owner and is not done here.

## 3. Hosted DEV / PROD state (read-only, executed 2026-11-24 ~02:00-02:12Z)

Method: `sb.sh dev-read` / `sb.sh prod-read` only (read-only transaction wrapper); no keys printed; no writes. Query files are in [queries/](queries/) (sha256 in section 6).
The 2026-11-19 PROD note ("applied") is historical; **these results are the current state** [EXEC].

| Check (query) | DEV `epdrtzcydvnoidwrepqz` | PROD `hvsujyfbftfffxpfmlpb` |
|---|---|---|
| `cf1_u18_guard_heat_entry_status` trigger: AFTER, ROW, `tgenabled = A`, function SECURITY INVOKER, md5 (q2) | present, `e47914edb361e22c3b091263b4e317f7` | present, same md5 |
| `cf1_u18s_guard_heat_entry_scratch` trigger, same shape (q2) | present, `322afa75104f8acbdccc762ebad86276` | present, same md5 |
| PR 492 U18/U18-S postflight (q5, sha256 `86c79bb0…`, identical to the staged copy recorded 2026-11-19) | `ok: true` | `ok: true` |
| PR 492 JC1 postflight (q6, `a55d371a…`): `_compe2_is_absent` md5 `22be37b7aa70fb934d49fba71ecc4f31` | `ok: true` | `ok: true` |
| TRIGGER privilege on `event_competition_heat_entries` for anon / authenticated / service_role (q2) | false / false / false | false / false / false |
| UPDATE / INSERT / DELETE / TRUNCATE grants on the table for those roles (q2) | all true | all true (RLS: enabled, not forced; policy `competition_manage`, FOR ALL, role `authenticated`) |
| Heat-entry rows (q2) | 0 | 0 |
| Migration history table (q1b) | `supabase_migrations.schema_migrations` exists, **1 row**, no `2027021*` versions (history is not maintained; objects were applied by hand/`sb.sh`) | **table does not exist** |

Consequences: (a) "migration status" for these objects can only be established from the catalog (objects, enabled state, function md5, grants), and it matches the pinned 2026-11-19 values on both environments; (b) there is **no migration-history record** to reconcile against Git on either environment;
(c) neither hosted database has any competition heat-entry data, so the guards are behaviourally inert today and no data is at risk.
Observed environment drift outside this slice (not investigated): the function-body md5 of `competition_judge_ballot_sheet` differs between DEV (`d3214a8f…`) and PROD (`fc712ebc…`), and `_comppv1_callback` exists on PROD only among the objects selected by q3. Recorded for the Competition coordinator.

## 4. Baseline definition and dependency requirements (documented now; artifact not yet built)

The **integrated release candidate** = `release/website-embeds` at the release-time head **plus**:

| Component | State today | Needed for sign-off |
|---|---|---|
| JC1 + U18 + U18-S migrations, rollbacks, SQL suites (byte-identical to PR 492 pins) | on candidate branch only; applied to DEV and PROD | land on the live line (owner merge) so Git matches the databases |
| OD-01 (#832), OD-02 (#835) + OD-03 (#837) + OD-18 (#846), OD-04 (#844), OD-19 (#848) + OD-20 wording (#853) | open drafts | merge on the live line in a decided order; re-run the rows that each changes |
| Other OD implementation drafts (OD-07, 09, 10, 11, 24, 26, 30 and any not yet opened) | docs/design drafts or in progress | those that ship code must be in the artifact |
| SC1 audited scratch workflow (#306, base `main`) | unmerged, not on the live line | port to the live line, or record the explicit decision that Studio/Custom day-of scratch stays RPC-only |
| Scratch/credit policy (CC1, #301) | docs only | owner decision |
| PROD SQL still unapplied for any OD slice that adds SQL (OD-04 guard etc.) | not applied (owner gate) | apply order and pins per slice |

Until that artifact exists and the rows in [GUARDED_BASELINE_RESULTS.md](GUARDED_BASELINE_RESULTS.md) are re-run on it, **sign-off stays BLOCKED**. The results in this directory are a **partial guarded baseline**: the live line's Competition database (per the composition in section 2) with the three guards.

## 5. What is blocked

1. No integrated release candidate artifact (section 4).
2. SC1 not on any release line; no in-app audited scratch.
3. Findings F1 and F2 (parent-entry `disqualified`, OD-20) need an owner/engineering decision before OD-20 item 4 can be called satisfied ([GUARDED_BASELINE_RESULTS.md](GUARDED_BASELINE_RESULTS.md)).
4. Live deployment identity not independently verified in this session.

## 6. Fingerprints and tested state

* Pins (sha256, equal to PR 492's pins and to the blobs on the candidate): U18 `90a46801c052c92da76390e6c0c0d9c1cb45388e06dc0c9ed30a5e89e8d50776`; U18-S `5de8003f672b7dabf94ad653e58a60e96b5c6c76ddc39edf0d19c546517fc8ae`; JC1 `32007974708d0ce8b8859ce7056f5581176ce95cbc230d55c9d9cdcd10bb71a7`. Git blob ids: JC1 `12ffb808…`, U18 `a930c8ca…`, U18-S `91533ef8…` [EXEC `git hash-object`].
* Competition-migration fingerprint of the **candidate** (sha256 of the sorted `sha256  filename` list of its 37 `*competition*` migrations): `199ae347a634e702e2cb124f0debc6d7b8b6cfd5412f73e95d1de99eba6ff369`. The repo has no committed fingerprint convention beyond per-file sha256 pins (PR 492) and the catalog function-md5 postflight; those two are what this analysis uses.
* Source commits: live line `49dbaee1b4183aa70c5782a72425e392d65b2e7b`; candidate `92a8c17c6d0ee43540858402a647485c50476549`; `main` `38b6277bf6243c057819d9056dc1b84e792118f4`.
* Local test database: see "Executed local test results" in [GUARDED_BASELINE_RESULTS.md](GUARDED_BASELINE_RESULTS.md) (image id, migrations applied in order, fingerprint of the composed set, counts).

Query files (sha256): `q1_dev_migration_history.sql` ad1bae9e…, `q1b_history_table.sql` eca87f87…, `q2_heat_entry_objects.sql` 36857f74…, `q3_function_writers_readers.sql` eecbdfe8…, `q4_tables_with_disqualified_checks.sql` 0ca3e99d…, `q5_u18_postflight_from_pr492.sql` 86c79bb0…, `q6_jc1_postflight_from_pr492.sql` a55d371a….
`q1` fails on PROD by design of the finding (no history table); `q1b` is the portable probe.

## 7. Running the local suites

`run-guarded-baseline.sh` composes the chain from git objects (live line + the three candidate files), starts one disposable container from `cf1host:found` (no network, no published port), applies the Competition migrations in version order and runs the suites, under the heavy-lock FIFO rules. See the script header.
