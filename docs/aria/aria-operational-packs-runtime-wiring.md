# ARIA Operational Packs Runtime Wiring

## What this slice changes

This slice connects the ARIA operational packs to persisted studio configuration.

Each studio receives:

- One preference row per operational pack
- Default action policies for currently implemented ARIA rules
- Explicit `automation_rules` rows that control external delivery permission
- Safe defaults without requiring the owner to configure every rule manually

## Approval and delivery remain separate

`aria_action_policies.auto_approve` controls whether ARIA may approve the operational decision.

It does not authorize external communication.

External sending still requires:

1. The corresponding `automation_rules` row to be enabled.
2. Its mode to be `auto_send`.
3. The action to be an email-executable ARIA rule.
4. A valid recipient.
5. Successful queue and dispatch processing.

Turning a pack off prevents its policies from generating new actions. Existing audit history remains intact.

## Default ownership

Rows created by DanceFlow use:

- `default_source = danceflow_default`
- The pack key that owns the rule
- The catalog handling mode
- The catalog delivery mode

A studio change records `default_source = studio_override` for the policy. Default initialization inserts only missing rows and does not overwrite existing studio choices.

## Runtime behavior

The scheduled ARIA operations run now ensures missing default configuration before evaluating signals.

New operational rules inherit their explicit delivery mode:

- `auto_send` for safe automatic communication
- `draft` for review-based communication
- `suggestion` for internal or suggestion-only work

ARIA execution checks the same ARIA rule key that generated the action. It no longer depends on a parallel legacy rule key for delivery permission.

## Migration

Run:

`20260729000200_aria_operational_pack_preferences_v1.sql`

after the five existing ARIA lifecycle and constraint migrations listed in the migration header.
