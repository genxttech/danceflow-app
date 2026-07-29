# ARIA Automation Center / Operations UX Correction — Slice 6.1

## Purpose

This correction clarifies the relationship between ARIA configuration and ARIA day-to-day work.

### Automation Center

Answers:

**How should ARIA work for this studio?**

It contains:

- the three recommended setup decisions;
- operational pack on/off controls;
- per-rule exceptions;
- delivery-mode boundaries.

### ARIA Operations

Answers:

**What is ARIA doing, and what needs me?**

It contains:

- handled work;
- decisions;
- exceptions;
- upcoming work;
- action lifecycle;
- delivery and retry state;
- outcome verification;
- digest activity.

Operational activity is no longer duplicated on the Automation Center.

## Three setup preferences

The former informational cards are now real controls.

### Front Desk

Options:

- Prepare routine follow-up for review — recommended
- Notify me only

No schedule change is automated.

### Marketing

Options:

- Prepare opportunities for review — recommended
- Suggest opportunities only

Campaigns are not automatically sent.

### Billing & Payments

Options:

- Notify me about payment exceptions — recommended
- Prepare follow-up for review

Financial actions remain staff-controlled.

## Persistence

Choices are stored in the existing `aria_automation_pack_preferences.settings` JSON:

- `recommended_setup_choice`
- `setup_reviewed_at`
- `setup_reviewed_by`

No database migration is required.

The save action also synchronizes existing `automation_rules.mode` rows where applicable, but never widens capability beyond the catalog rule's executable channel.

Therefore a setup choice cannot make an internal-only or review-only rule externally executable.

## Navigation relationship

Automation Center now links to Operations with:

**See ARIA working day to day**

Operations links back with:

**Manage automation preferences**

This creates the intended mental model:

**Automation Center = configure ARIA**

**ARIA Operations = supervise ARIA**
