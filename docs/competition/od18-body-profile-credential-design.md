# OD-18: organizer verification now, body-profile credential capture later (design only)

**Status: design note only. Nothing here is implemented or authorized to build.** Owner decision OD-18 (2026-11-23): Option A for initial activation, i.e. the organizer verifies amateur/professional status, proficiency and skill-level eligibility for Studio / Custom. Governance: [RULEBOOK_GOVERNANCE.md](RULEBOOK_GOVERNANCE.md). Body requirements that are NOT implemented are listed in the rule register under `*-OD18-*` entries (status `unsupported`).

## What ships now

- The organizer's decision for each entry is recorded in the existing `eligibility_status` workflow plus an audit record in `event_competition_entries.metadata.eligibility_determination`: user id, actor role, timestamp, outcome, reason code and the list of criteria the organizer confirmed (`age_division`, `status`, `level`). No credential numbers, dates of birth, points or membership details are stored or logged.
- Per-division applicability: a division is classified by age when it has an age label, by level when it has a skill label, and by status when an entry has a professional or student participant. Studio / Custom divisions with none of these need no criteria. Unknown labels fail closed.
- No new table and no migration: the existing workflow holds the criteria. Limits (overwrite on change, no append-only history, no DB-level guard) need a separate SQL approval; see the OD-03 PR.
- Copy: Studio / Custom eligibility is determined by the organizer. DanceFlow does not verify NDCA registration, UCWDC membership or WSDC Points Registry eligibility.

## Gate matrix

| Dimension | Source | Waiver can clear? | Organizer determination can clear? |
|---|---|---|---|
| OD-02 adult-only (18+) | stored date of birth | never | never |
| Age division (OD-03) | division age label | never | yes (`age_division`) |
| Amateur / professional status | participant roles | never | yes (`status`) |
| Level | division skill label | never | yes (`level`) |
| Event policy: documents, fee, scheduling | organizer | yes, categorised | n/a |

Waivers are limited to the three event-policy categories. The prohibited override subjects (under-18 restriction, body mandatory age, body status, body proficiency level, body membership or registration) are defined in `PROHIBITED_OVERRIDE_SUBJECTS` and refused by the gates. "Body-permitted exception applied" is a different thing: an organizer applying an exception the rulebook itself permits (for example dancing up where a body allows it) with every criterion still confirmed; it is not a waiver.

## Future body profiles: credential capture and verified rule evaluation (design only)

The register lists the future requirements with edition, section and page: NDCA professional/amateur/Pro-Am status (II.A.1, II.A.2, II.A.4), proficiency points (X.C), Newcomer/winner rules (II.B.7), registration (III.D.4, V.A.2); UCWDC status definitions (ProAm II.A.1, II.A.17, II.F.8; Couples II.F.9, II.F.4.c), Associate Membership (II.B.1.a), level graduation (II.L); WSDC Points Registry, petitions (3.1.6), skill levels and roles (3.2.3-3.2.8), Charts 3-4.

1. **Per-body profile.** Each body gets a versioned profile that declares which credentials it requires (for example NDCA registration number, UCWDC membership number, WSDC competitor ID), the reference date rule, and the rule set version. A profile is a register-backed artifact: no rule without a cited section.
2. **Credential capture.** The registrant supplies the credential identifier; Competition OS stores it as a sensitive field (not in logs, exports to third parties or public pages) with who supplied it and when. A credential is a claim until verified.
3. **Verification sources.** The sources named in the rulebooks themselves are the only authority (for example the NDCA registrant list, the UCWDC membership record, the WSDC Points Registry). **This design invents no provider API.** Whether any of them offers machine access, terms of use or a data-sharing agreement is NOT SPECIFIED IN PROVIDED SOURCE and must be established with the body before any integration. Until then, verification stays an organizer action that records "verified against <source> by <user> at <time>".
4. **Rule evaluation.** A pure, versioned evaluator takes the verified credential facts plus the division's rules and returns eligible / ineligible / needs-organizer-decision with reason codes. Where a rule is ambiguous (for example whose age counts in Pro-Am and Couples, AE-16) the evaluator returns needs-organizer-decision, never a guess.
5. **Never claim more than verified.** Product copy and the register state "verified by organizer" or "verified against <source>" only for what was actually verified; DanceFlow is never described as verifying NDCA registration, UCWDC membership or WSDC Points Registry eligibility until a source-backed integration exists and is reviewed.
6. **Overrides.** The override categories above carry over: no waiver for age, status, level, membership or registration. Body-permitted exceptions are modelled as exceptions with their own citations.
7. **Privacy.** Credential numbers and points are sensitive; minimum necessary, role-limited reads, no logging of values, retention aligned with the OD-02 Option A design.

## Open items for the owner

- Which bodies' profiles to build first and whether any body will provide a verification path (outreach is not authorized by this note).
- Whether organizer determinations need an append-only history and a database guard (separate SQL approval).
- AE-16 (whose age counts in Pro-Am and Couples) remains unresolved.
