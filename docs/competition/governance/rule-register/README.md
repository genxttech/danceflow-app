# Rule register

The versioned rule register traces each rule-dependent Competition OS behavior:

> official rule → Competition OS requirement → implementation → automated test → verification status

It implements [RULEBOOK_GOVERNANCE.md](../../RULEBOOK_GOVERNANCE.md) (permanent, non-negotiable) and builds on
[governing-body-source-registry.md](../../governing-body-source-registry.md), which pins the official documents
by SHA-256. This README covers the process only; it does not repeat the governance rule.

## Layout

- `register.schema.json` — JSON Schema (draft-07) for one entry.
- `rules/*.json` — one file per rule entry, named `<id>.json`. `EXAMPLE-0001.json` is a template marked
  `"example": true`; it is exempt from the verified-compliant evidence checks and must never be cited as evidence.
- Integrity test: `src/lib/competition/governance/__tests__/ruleRegister.integrity.test.ts`.

## Fields

`id`, `governing_body` (a registered body, or `dance_flow_policy` / `organizer_policy` / `silent`), `format`,
`source` {`registry_document`, `edition`, `effective_from`, `effective_to` (nullable), `sha256`, `section`,
`quote_free_summary`}, `rule_class`, `requirement`, `implementation` [{`path`, `symbol_or_migration`}],
`enforcement_point`, `tests` [{`path`, `name`}], `verification_status`, `interpretation_notes`,
`applicable_event_versions`, `decision_refs`, `last_reviewed`.

Rule classes: `mandatory`, `recommended`, `permitted_exception`, `organizer_discretion` (governing-body sourced);
`dance_flow_policy`, `organizer_policy`, `rulebook_silent` (no governing-body source; `source` is `null`).

Verification status: `verified_compliant`, `inconsistent`, `unsupported`, `requires_interpretation`, `unverified`.

## Rules the integrity test enforces

- Every entry validates against the schema; ids are unique and match the file name.
- `source.sha256` and `source.registry_document` match a row of the source registry.
- Governing-body classes carry a source with effective dates; policy/silent classes never carry one.
- A non-example `verified_compliant` entry cites implementation paths that exist and test files that exist and
  contain the cited test name.
- `inconsistent`, `unsupported` and `requires_interpretation` entries explain themselves in `interpretation_notes`.

## Writing an entry

1. Read the rule in the official document itself (registry rule 1). Record the section reference.
2. Write `quote_free_summary` in your own words; at most a short quoted phrase, never long text.
3. Pick `rule_class` honestly. If the rulebook is silent, use `rulebook_silent` or the policy class and
   `"source": null`; do not borrow another body's rule without a written justification in `interpretation_notes`.
4. List implementation and the automated test that proves it. No test, no `verified_compliant`.
5. Add the entry's id to the decision record and PR that rely on it.

## Evaluating a rule against an event's rulebook version

An event is evaluated against the rulebook edition applicable to it, not the newest one:

1. Determine the event's governing body and the edition in force on the event's date (the event's rules profile
   records the edition; the registry lists editions and status).
2. Select entries whose `governing_body` matches, whose `applicable_event_versions` includes that edition, and
   where the event date lies in `[source.effective_from, source.effective_to]` (`effective_to` null = open-ended).
   If the date window and `applicable_event_versions` disagree, the entry does not apply (both must hold)
   and the disagreement is flagged for resolution before approval.
3. An entry whose cited registry document is `not current` is never used for current behavior.
4. If no entry applies, the behavior is unregistered: treat it as `rulebook_silent` or an audit gap and flag it
   before approval; do not infer a rule from another body.
5. A new edition adds new entries (or new `applicable_event_versions`); superseded entries are kept with an
   `effective_to`, never edited in place to change meaning.

## Known limitation: unknown effective dates (OD-30)

`source.effective_from` is required, but no pinned edition states an effective date (see the
[source registry](../../governing-body-source-registry.md#edition-lifecycle-and-effective-dates-od-30-design-only)).
Entries whose notes begin "EFFECTIVE DATE UNKNOWN" carry a schema placeholder (`2026-11-22`) that is **not** an
effective date and must not be used for event-date window evaluation. A schema change (nullable date plus an explicit
`unknown` status) is proposed in
[OD-30 design finding F-1](../editions/OD-30-rulebook-editions-design.md#11-age-rules-coordination-findings-and-boundaries).

## Adding a body or edition

Follow the extensibility steps in [RULEBOOK_GOVERNANCE.md](../../RULEBOOK_GOVERNANCE.md#governing-bodies-and-extensibility):
registry row with pinned SHA-256 and status first, then register entries.
