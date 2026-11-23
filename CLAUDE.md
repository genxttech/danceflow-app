# CLAUDE.md

Repository-wide guidance for AI sessions. Keep it short; project documentation lives in `docs/`.

## Standing project rules (pointers; the owner's existing process governs)

- Coordinators (Apps, Competition, TW-4F/Twilio) each own only their own domain and hand the rest off.
- Respect CODEOWNERS and protected-branch rules; open PRs through the GitHub App identity; no AI attribution lines in commits or PRs.
- No production SQL, deploy, or live Stripe/Twilio action without the required owner approval; hosted SQL only through the ops tooling.

## Competition OS: rulebook governance (permanent)

**Scope: Competition OS and competition-related functionality only.** It places no restrictions on unrelated DanceFlow work.

Before any rule-dependent design, implementation, review or approval in that scope, consult the applicable official
governing-body rules (NDCA, UCWDC, WSDC, extensible) and record source, edition, effective date and section. No such
decision is final because a developer, reviewer or AI recommended it; where the rulebook is silent, label the behavior
DanceFlow or organizer policy, never a body rule. Public Competition OS activation is blocked until the retrospective
audit is complete and the owner has decided every open finding. Do not quote rulebooks at length.

Authoritative documentation:
[docs/competition/RULEBOOK_GOVERNANCE.md](docs/competition/RULEBOOK_GOVERNANCE.md) ·
[rule register](docs/competition/governance/rule-register/README.md) ·
[source registry](docs/competition/governing-body-source-registry.md) ·
[audit tracker](docs/competition/governance/audit/TRACKER.md) (directory: `docs/competition/governance/audit/`).
