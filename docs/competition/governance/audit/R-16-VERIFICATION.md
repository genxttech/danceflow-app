# R-16 verification: Studio/Custom result-publication visibility

**Policy ratified (owner, 2026-11-24, DanceFlow Studio/Custom policy):** result publication defaults to `entrants`; `public` only by an explicit, authorized
organizer choice. It is **not** applied to future governing-body profiles, whose publication requirements differ (section 7).
**Policy ratified vs implementation verified are kept separate.** Base `origin/release/website-embeds` @ `49dbaee1b`. Evidence labels as in
[R-07-VERIFICATION.md](R-07-VERIFICATION.md). **All SQL claims are INSPECTED; no SQL suite was run** (heavy-lock queue). Executed: the static test
`src/lib/competition/results/__tests__/r16.publication.static.test.ts` (5 tests, reads migration text only). Cross-reference: the `r12-ops-verify` publication-hold
work was searched for (`git branch -r`, no matching branch found); no publication-hold tests were written here.
Source: F3 `20270122090000_competition_f3_publication.sql` (no later 2027* migration redefines its functions, policies or grants; no `supabase_realtime` entry; no API route for results).

## 1. Exactly what is exposed (INSPECTED)

`_compf3_payload` builds both readers' JSON: `publication{id, version, published_at, visibility}`, `event_id`, `round{id, name, round_type, division_id, division_name, program_name}`,
`rows[]{entry_number, display_name, placement, tie_group, advanced, rating_band, mine}`, `excluded[]{entry_number, display_name, mine}`; the readers add `published`, `under_review`.
**Not in any payload:** judge names or letters, ballots, marks, scores, traces, input hash, calculator or approver identity, audit data. `published_by` and `withdrawn_reason`
appear only in the manager reader `competition_round_publications`.

| Reader | Who can call | What they get |
|---|---|---|
| `competition_round_results_public`, `competition_event_results_public` | anon and authenticated | only publications with `visibility = 'public'`, current and live, and only when the event itself is `published` and public. Anon with an `entrants` publication gets `{published:false, under_review:false}`; a withdrawn or stale public publication gives only `under_review:true` (no data, no reason) |
| `competition_my_results` | authenticated (service_role revoked); needs `auth.uid()`, **no verified-email check** | the caller's entries are resolved by `_compf3_viewer_entries` (competitor `user_id` = caller, or a linked self client of the event's studio); with no entries it returns `[]`. Otherwise every CURRENT live publication of that event (entrants or public) for rounds whose version contains at least one of the caller's entries |
| `publish_competition_round_result`, `withdraw_competition_round_result`, `competition_round_publications` | authenticated; manager role of the round (publish/withdraw also need a verified email) | publish/withdraw; history for managers |

**Entrants visibility, precisely:** an entrant of a round sees **every row of that round** (placement, tie group, advanced flag, rating band) but `display_name` only on their own
rows; other couples show only an entry number; excluded couples are listed by number, and by name only to themselves. **Public visibility:** everyone sees every non-excluded couple's name,
placement, tie group, advanced flag and rating band. `_compf3_live` requires the round to be published or complete, `correction_open` not true, the version approved and the round's latest.

**Tenant isolation:** payloads filter by publication and `event_id`; the entrant link is per event, so an entrant of event A gets `[]` for event B; managers are checked per round
(`_compe2_round_role`), so a studio B manager is `COMP_FORBIDDEN` on event A. **Direct table access:** the publications table has RLS on, one SELECT policy for managers, `grant select` to authenticated
only, everything revoked from anon and service_role; no client write grant; backstop triggers refuse writes without the audit row; delete/truncate blocked. F2 result versions/rows/approvals/events are readable only by managers (versions also by an assigned scorer), never by entrants or anon.

## 2. Defaults and authorization (INSPECTED)

Default `entrants` at every layer: column `default 'entrants'` with a CHECK limiting values to `entrants`/`public` (F3 L101); RPC `p_visibility` has no default and a blank value is coalesced to `entrants`, anything
else is `COMP_PUBLICATION_VISIBILITY`; the server action `parseVisibility` returns null for anything but the two values and refuses before calling the RPC (`results/actions.ts:96-99`); the UI radio has `entrants`
`defaultChecked`; there is no wizard setting. **Who may choose `public`:** any manager of the round's event with a verified email; there is **no separate permission** for `public` (see finding RF-16.2). Preconditions
(all must hold): round `approved`, version latest and approved with an approval row, input hash equal to the current ballots (`COMP_RESULT_STALE`), version never published before, no undecided callback tie
(`COMP_PUBLICATION_UNRESOLVED`), advancement from the same version, no unresolved refund exception (`COMP_PUBLICATION_BLOCKED_BY_EXCEPTION`), roster still eligible.

## 3. Organizer UI (INSPECTED)

`results/[roundId]/page.tsx` L303-340: legend "Who can see this result"; options "Entrants of this round only" (default) and "The public as well"; button "Publish result"; once published the line reads "visible to the
public and entrants" or "visible to entrants only". **Insufficient:** nothing before publishing says what each option exposes, and there is no confirm step. A bounded disclosure spec is in
[R-16-PUBLICATION-DISCLOSURE-SPEC.md](R-16-PUBLICATION-DISCLOSURE-SPEC.md) (text only; implementation belongs to the relabelling workstream).

## 4. OD-10 confidentiality (INSPECTED + executed static)

Public visibility cannot reach original ballots, judge identities, scores, traces, the input hash or unpublished evidence: the payload builder names none of them (executed static check on the builder body), the
public readers return only the payload, and the underlying tables are manager-only under RLS. The existing SQL test "the public payload carries no judge, scorer, approver, hash, trace, score or reason fields" (L521) checks the same
at runtime but its regex omits `rating`, `tie` and `name`, which are intended fields (NOT RUN).

## 5. OD-07 / OD-22 evidence preservation (INSPECTED)

Withdraw writes a `result_withdrawn` audit row first, stamps `withdrawn_at/by/reason` (reason 3-500 characters); supersede writes `result_superseded` and `result_published`, audit rows first in the same transaction, and stamps `superseded_by` on
the old row. Publication rows are never deleted; only those stamps can be written, once. Withdrawn and superseded rows stay visible to managers in `competition_round_publications`, and audit rows are readable by managers. A visibility change in place is impossible
(a new publication requires a corrected version, since a version publishes once), so history is not overwritten; the consequence is RF-16.3.

## 6. Tests: existing / added / executed / pending

| Case | Existing | Executed here? |
|---|---|---|
| anon cannot read entrants results; anon executes exactly the two public readers | `test_T_competition_cf1_f3_publication.sql` L386, L428 | NOT RUN |
| entrant cannot publish; cross-tenant publish and history reads refused | same file L433-440, L549 | NOT RUN |
| unknown visibility refused, never defaults to public | same file L445; vitest `publication.f3.test.ts` "accepts only entrants or public and never defaults to public" | vitest EXECUTED; SQL NOT RUN |
| stale input hash not publishable | same file L463 | NOT RUN |
| client cannot write/update/delete/truncate the table | same file L496-505 | NOT RUN |
| entrant sees own name only; entrants-only invisible to the public; non-published event shows nothing publicly | same file L568, L565, L533 | NOT RUN |
| Defaults, manager+verified-email, payload field names, no realtime, anon grants | **added** `r16.publication.static.test.ts` (5 tests) | EXECUTED (static) |
| **Missing:** non-verified-email manager refused publish; entrant of event A reads nothing from a populated event B; unapproved version not publishable (explicit); public publication invisible for a draft/private event beyond L533; exposure wording | none | PENDING (SQL needs the isolated database; wording test needs the disclosure implemented) |

## 7. Future body profiles (NOT IMPLEMENTED; the Studio default is not applied to them)

`R16-NDCA-0001` (III.D.17, printed p.21, PDF p.28: digital scrutineer sheets made publicly accessible, uploaded at least after each competition day, posted only for completed events with results announced);
`R16-UCWDC-0001` (Scoring Format General Information, PDF p.8: DSA reports accessible to contestants, adjudicators, Contest Coordinators and named officers; hired Scoring Systems produce the awards report read to the public);
`R16-WSDC-0001` (3.1 item 9, PDF p.12: results posted at the event, open to all competitors for at least 30 days, including rounds, placements and score reports; judges may be listed anonymously at the Event Director/Owner/Chief Judge's
discretion; corrected results must be posted). Body-specific judge-identity requirements stay separate; **no global judge-anonymity policy** is set here, and the Studio `entrants` default is not a body requirement.

## 8. Findings

| ID | Severity | Finding |
|---|---|---|
| RF-16.1 | medium | The organizer UI does not explain what `public` exposes before publishing and has no confirm step (section 3). Disclosure spec provided. |
| RF-16.2 | owner decision | `public` needs no authorization beyond manager + verified email; there is no separate permission or acknowledgement. Whether that counts as "explicit authorized organizer choice" is an owner call; a bounded option is a required acknowledgement of the disclosure text at publish time (design only). |
| RF-16.3 | low | A manager cannot downgrade `public` to `entrants` except by withdrawing and publishing a corrected version (withdrawal shows `under_review` to the public; history is preserved). |
| RF-16.4 | low | `entrants` visibility shows every couple's placement/tie/advanced/band to any entrant of the round (names hidden). Intended, but it should be stated in the disclosure. |
| RF-16.5 | info | `competition_my_results` does not require a verified email (publish and withdraw do). U18 name protection for `public` was not examined (OD-02 prohibits under-18 competitors at first activation). |
| RF-16.6 | info | Hosted state of the F3 migration was not determined (repo docs say local-only until authorized). |

## 9. PENDING

All SQL suites above; the missing negative tests in section 6; UI exposure-wording test (after implementation by the relabelling workstream). No SQL, behavior, merge or deploy change was made.

## 10. Independent review

A subagent re-checked this report against the migration and UI: payload keys, grants/RLS, defaults and authorization were confirmed. Corrections applied: the disclosure spec now states the event-published-and-public condition, that the public also sees `under_review` while a correction is open, that excluded couples appear by number, and that entrants viewing a `public` publication see names. Acknowledged weaknesses of the static tests: they read only the F3 file (a later re-grant would not be seen), the word check covers only the payload builder, and the published-event requirement is not tested.
