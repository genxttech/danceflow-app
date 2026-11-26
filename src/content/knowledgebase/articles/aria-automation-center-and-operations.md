---
title: "ARIA Automation Center vs ARIA Operations"
slug: aria-automation-center-and-operations
category: "AI & Automations"
summary: "Understand the difference between configuring ARIA in Automation Center and supervising ARIA in Operations."
order: 770
visibility: public
---

## Overview

ARIA has two related workspaces with different jobs.

**Automation Center = choose how ARIA should work.**

**ARIA Operations = see ARIA working.**

## Use Automation Center for configuration

Open Automation Center when you want to change:

- Operational pack autonomy
- Whether an operational area is on or off
- A stricter rule exception
- Communication and automation boundaries

The normal studio workflow is to set each operational pack once and only return when your preferences change.

## Use ARIA Operations for daily work

Open ARIA Operations when you want to see:

- Work ARIA handled
- Items that need your decision
- Exceptions
- Upcoming operational work
- Delivery status
- Failed or retried work
- Outcomes and follow-up status

## How they work together

Automation Center sets the boundaries.

ARIA Operations shows the work produced inside those boundaries.

For example:

**Front Desk pack = Handle automatically**

ARIA can automatically perform the safe parts of supported Front Desk workflows. A cancellation or schedule conflict that still requires judgment appears in Operations for review instead of being changed automatically.

## Rule exceptions

Individual rules normally inherit the pack setting.

Use a rule exception only when one workflow should be more restrictive than the rest of the operational area.

## Best practice

Keep pack settings simple. Review Operations as part of the normal studio day and only return to Automation Center when your studio's preferred level of autonomy changes.
