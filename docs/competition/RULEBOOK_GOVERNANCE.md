# Competition OS rulebook governance (permanent)

**Status: PERMANENT and NON-NEGOTIABLE.** Issued by the owner on 2026-11-22. It binds every proposal, design
decision, implementation and review touching Competition OS, whoever or whatever (developer, reviewer, AI
assistant) is doing the work. It can be changed only by an explicit written owner decision recorded in this file.

This document builds on, and does not replace:

- [governing-body-source-registry.md](governing-body-source-registry.md) — the pinned SHA-256 list of official
  documents (UCWDC, WSDC, NDCA). Its "Rules for using a source" stay in force.
- [phase10c5-source-to-ui-matrix.md](phase10c5-source-to-ui-matrix.md) — source-to-UI mapping for the 10C.5 wizard.
- [scoring-method-registry.md](scoring-method-registry.md) — scoring methods.
- The versioned [rule register](governance/rule-register/README.md) and the
  [retrospective audit](governance/audit/README.md) introduced here.

## The standing rule

Competition OS decisions are governed by the applicable official governing-body rulebooks. A rule-dependent
behavior is correct only when it can be traced from an official rule, through a stated requirement, to an
implementation, an automated test and a verification status. "It seemed right" is not a basis.

## Requirements for EVERY applicable proposal, design decision, implementation and review

A change is *applicable* when it affects any behavior that a governing body's rules, or an organizer's policy
under those rules, could constrain (see the scope list below). For each applicable change:

1. **Identify** the governing organization and the competition format (and discipline/division where relevant).
2. **Consult** the applicable official rulebook and the supporting judge/organizer policies, reading the
   section itself (registry rule 1).
3. **Record** source document, edition/version, effective date, and the specific rule/section.
4. **Distinguish** mandatory rules, recommendations, permitted exceptions, and organizer discretion.
5. **Explain** how the software implements the rule.
6. **Identify** where it is enforced (the enforcement point) and how automated QA verifies it.
7. **Do not apply** one governing body's requirements to another without a written justification.
8. **Flag** uncertain, conflicting or unsupported interpretations for resolution **before** approval.

Evidence goes in the decision record ([template](governance/decision-record-template.md), "Rule evidence"
section) and in the PR ([Competition OS PR template](../../.github/PULL_REQUEST_TEMPLATE/competition-os.md)).
GitHub only auto-applies a root `PULL_REQUEST_TEMPLATE.md`; for Competition OS PRs append
`?template=competition-os.md` to the compare URL, or paste the checklist into the PR body. Reviewers must
reject a Competition OS PR without a completed checklist.
A change that is not rule-dependent may say "N/A — not rule-dependent" with a one-line reason; nothing else
substitutes for the checklist.

Scope (non-exhaustive): formats, disciplines and divisions; age and eligibility calculations;
amateur/professional/Pro-Am/Pro-Pro classification; registration and partner requirements; judging
qualifications, assignments and conflicts; scoring systems, callbacks, placements and tie-breaking; scratches,
withdrawals, disqualifications and result changes; organizer authority, approvals, exceptions and appeals.

## No self-certifying decisions

No rule-dependent decision is final merely because a developer, a reviewer or an AI assistant recommended it.
A recommendation is input. A rule-dependent decision becomes final only when its rule evidence is complete and,
for anything classified `requires_interpretation`, `inconsistent` or `unsupported`, the owner has decided it.
Earlier recommendations (for example the judging-policy recommendations in PR #783) are **not approved**
unless and until re-validated through this process and accepted by the owner.

## When the rulebook is silent

Where the official rulebook does not address a behavior, record `NOT SPECIFIED IN PROVIDED SOURCE`
(registry rule 2) and label the behavior explicitly as **DanceFlow policy** or **organizer policy**
(rule classes `dance_flow_policy` / `organizer_policy`; `rulebook_silent` for the gap itself). Such a behavior
is never presented, in the UI, docs, tests or marketing, as a governing-body requirement, and never carries a
governing-body source in the register.

## Versions and effective dates

Rules are evaluated against the rulebook edition and effective dates **applicable to the event** (normally the
event date, or the date a rule says it applies from), not against the newest edition. The register records
`effective_from`/`effective_to` and `applicable_event_versions`; see the
[register README](governance/rule-register/README.md#evaluating-a-rule-against-an-events-rulebook-version).
A registry document with status `not current` (e.g. a draft edition) is never used as current behavior.

## Governing bodies and extensibility

Starting bodies: **NDCA**, **UCWDC**, **WSDC**. The mechanism is extensible to other governing bodies and to
independent competitions. To add a body or a new edition:

1. Add a row to the governing-body source registry with body, document, edition, file name, **pinned SHA-256**,
   and status (`authoritative` / `reference` / `not current`). A new edition is a new row; the old row is kept
   and its status changed deliberately, in a reviewed change.
2. Record effective dates (`effective_from`, nullable `effective_to`) on every register entry citing it.
3. Add register entries for each rule relied upon; run the integrity test.
4. Run the retrospective audit rows for any existing behavior the new body or edition affects.
5. An independent competition with no published rulebook is `organizer_policy`, labelled as such.

## Retrospective audit — a public activation release gate

Every previously approved rule-dependent behavior must be audited against the official sources and classified
`verified_compliant`, `inconsistent`, `unsupported` or `requires_interpretation`. **Public Competition OS
activation is NOT authorized until that audit is complete and every `inconsistent`, `unsupported` and
`requires_interpretation` finding has been resolved by an owner decision.** Tracking:
[audit/TRACKER.md](governance/audit/TRACKER.md); process: [audit/README.md](governance/audit/README.md).

Previously approved behavior is **never silently changed**. A discrepancy is reported with its sources and a
proposed correction, and the owner decides. The owner is not asked to perform manual audit or QA work; the
engineering side produces the evidence.

## Confidentiality and outreach

Contacting competition directors/organizers about Competition OS, and disclosing unreleased Competition OS
plans, remain prohibited. Governance docs must not reproduce rulebook text at length: use short cited phrases
and section references only; the full documents stay outside the repository, pinned by SHA-256.
