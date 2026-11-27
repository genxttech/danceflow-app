# Retrospective rulebook audit

Process for the retrospective audit required by [RULEBOOK_GOVERNANCE.md](../../RULEBOOK_GOVERNANCE.md): every
previously approved rule-dependent Competition OS behavior is checked against the official sources pinned in
[governing-body-source-registry.md](../../governing-body-source-registry.md). Progress is tracked in
[TRACKER.md](TRACKER.md).

## Public activation gate

**Public Competition OS activation is NOT authorized** until [TRACKER.md](TRACKER.md) shows every domain audited
and every `inconsistent`, `unsupported` and `requires_interpretation` finding resolved by an owner decision
(and no rule-dependent behavior is left `unverified`). This is a release gate. Nothing in the audit changes behavior: previously approved behavior is never silently
changed; discrepancies are reported with sources and a proposed correction, and the owner decides. The owner is
not asked to do manual audit or QA work.

## Finding classes

| Class | Meaning |
|---|---|
| `verified_compliant` | Read in the official source; implementation matches; an automated test proves it (register entry exists). |
| `inconsistent` | Implementation or approved spec contradicts the official source. |
| `unsupported` | Behavior has no basis in the cited source (neither required nor permitted) and is not labelled policy. |
| `requires_interpretation` | Source is ambiguous, conflicting, or silent in a way that needs an owner decision. |

Inventory rows use exactly these four classes. A row for labelled policy behavior is classified
`verified_compliant` only when the label, the approval and the test are all in place (register class
`dance_flow_policy` / `organizer_policy` / `rulebook_silent`); otherwise it is `requires_interpretation`.
A register entry left `unverified` is not an audit result: any `unverified` rule-dependent behavior keeps its
domain open and blocks activation, exactly like an unresolved finding.

Behavior the rulebook is silent on is recorded as DanceFlow policy or organizer policy (labelled, not a
governing-body rule) and is not an `unsupported` finding as long as it is labelled and approved as such.

## Inventory files

One file per domain: `inventory-<domain>.md` in this directory, written by the auditing session, one PR per
domain, linked in the tracker. Each row:

| domain | behavior | where implemented | decision/spec | tests | governing source (body, edition, section) | classification | proposed correction | owner decision needed |
|---|---|---|---|---|---|---|---|---|

- Cite sections by reference; short phrases only; no long rulebook text.
- A `verified_compliant` row gets a rule-register entry in the same or a follow-up PR.
- Do not change code or specs in an audit PR; propose corrections in the row.
- Findings that need the owner are batched into one decision package per domain (evidence included).

## Completing a domain

A domain is done when its inventory file lists every rule-dependent behavior found in code, migrations, specs and
UI copy; every row is classified; and the tracker row has counts, PR link and `status` updated. Unknown or
uninspected areas are listed as blockers, never silently omitted.
