# P1 pilot: decisions needed before activation (2026-11-28)

Nothing here is approved. Approval would authorize only non-applied drafting, local tests, independent review and written procedures. It would not authorize a merge, hosted SQL, deployment, flag change or activation. **P1 is not release-ready.** Independently reviewed once; its findings were checked and applied in this version, which was not re-reviewed. Code facts are from release candidate `8b7ecdb3d`, by reading.

**Assumed pilot (please confirm):** one event, one studio, adults only, Studio/Custom rules, one final per division, no money taken, results visible to entrants only. No other studio runs a competition during it.

## 1. How couples get registered

**Found:** the only app route I found that creates competition entries is the public registration checkout. It is off unless the build-time flag `NEXT_PUBLIC_COMPETITION_REGISTRATION_ENABLED` is on; I found no staff entry screen, although the P1 package lists "staff or $0 registration". The flag covers every event with registration open, not just the pilot. Nothing enforces free entries: a studio with online payments set up can charge. Desk payment at check-in also remains. You hold public competition registration until three ordinary-event money and check-in defects are fixed or waived (recorded 2026-10-12; current status not checked).

**Recommendation: build a minimal staff entry action for free entries** and keep public registration off. Not designed or estimated yet. Alternative: enable public registration for the pilot, which needs your waiver of that hold, a redeploy, and reliance on procedure to keep entries free.

## 2. A second result for the same couples

**Found** (one local run on base `57c33191` migrations, reviewed by reading; PR 863 `2cc630928`): with the pilot restrictions, the calculator cannot approve, but the same people can be judged again in another division, contest or event, and a second manager can approve and publish a different result while the first approved one stays unpublished. The probe used two manager accounts and the judges' own ballots. Screens, controlled or colluding accounts and publishing the first result afterwards were not tested.

**Recommendation: a database list of allowed pilot events, plus a written checklist.**
* Ballots, approvals and publications would be refused for unlisted events. No application account, including the service role, could edit the list. Exactly one event is listed, by a hosted SQL step you approve, and removed afterwards; rehearsals need listing too.
* It would close the two routes through another event.
* **It leaves open** a second division and a second contest inside the pilot event. Control: at the start and again before approval, a named approver who did not register, calculate or enter anything lists every final, judged or not, and resolves each overlap of dancers in writing (legitimate double entry is allowed); then publishes all approved results in one sitting and reconciles ballots, approvals and publications. The database does not require that this person is the one who approves.
* Estimated one to two engineering sessions, including a composed run; existing restricted-chain tests need to list their events.
* **Accepting the two remaining routes departs from your rule against reachable vulnerabilities (sections 20(5) and 21(4)) for those routes only.** It is your pilot-only adjudication; it does not by itself clear R-11, and other R-11/B2 items stay recorded separately.

Alternatives: checklist only (blocks nothing); also refusing the same couple and dance twice in an event (evaded by changing a letter of a name; refuses legitimate double entry); showing overlaps and requiring the approver to acknowledge them (screen and database work; blocks nothing).

## 3. Conflicts, ballot access and official attestation (OD-05, OD-10, OD-15)

You decided all three on 2026-11-23. I and the reviewer found none built: no conflict check or recusal enforcement (OD-05); no ballot-view audit log, and managers and scorers can still read every individual ballot before publication, which OD-10 says to restrict (OD-10); no officials' attestation record (OD-15).

**Recommendation: defer the software for this one pilot only, with manual controls.**
* Each judge declares conflicts in writing before judging; a conflicted judge does not sit.
* Only named people hold manager or scorer access during the event, and are told not to open individual ballots before publication. **Nothing enforces or records this.**
* The organizer signs a dated record naming each official and role, without presenting it as certification.
* All three must be built before a second pilot, a second studio or public activation.

This departs from your three decisions and from the P1 requirement to preserve audit protections, for this event. Alternative: build them first (not estimated; database and screen work and another composed run).

## 4. When something goes wrong

* **Money:** the pilot takes none. Older entry-refund tests stop at a pilot restriction and no real refund path is tested.
* **No-show or scratch:** a no-show can be recorded only before ballots lock (reopening is refused in the pilot). A final with fewer than two ranked couples cannot be approved, and cannot be cancelled once the event has started: it stays unfinished. The suite records a no-show after ballots, but does not carry that round through approval.
* **Wrong published result:** corrections are off. The app can still withdraw a publication (by reading; untested with the restrictions). **Recommendation:** withdraw it and announce the correction outside DanceFlow.

## Still required whatever you answer

Draft release pull request; app end-to-end workflow, production-build browser run and flag-off check (queued); the combined database run used an older base (`57c33191`), with later database changes checked by comparison and not rerun, and the new work above needs its own run; hosted checks; merge to `main` and the release branch; database approvals for DEV then PROD (Apps reports its new gate refuses forward PROD applies while other items are open); app promotion; activation.
