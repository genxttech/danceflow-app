---
title: "Using the ARIA Automation Center"
slug: using-automations-for-client-follow-up
category: "AI & Automations"
summary: "Choose how ARIA should work across front desk, client relationships, scheduling, marketing, billing, documents, events, payroll, retail, and studio health."
order: 630
visibility: public
---

## Overview

The ARIA Automation Center controls **how ARIA is allowed to work**.

Use it to set the normal autonomy level for each operational area. Then use **ARIA Operations** to supervise the work ARIA creates.

## Operational packs

ARIA groups related work into operational packs such as:

- Front Desk
- Client Relationships
- Scheduling
- Sales and Retention
- Marketing
- Billing and Payments
- Documents
- Events
- Staff and Payroll
- Retail and Inventory
- Studio Health

## Autonomy levels

Each pack has one autonomy setting:

- **Handle automatically**: ARIA uses the maximum safe autonomy allowed by the rules in that pack.
- **Prepare for my review**: ARIA prepares work and stops for staff review when needed.
- **Notify me only**: ARIA surfaces the issue without taking the next step.
- **Off**: ARIA does not create new work from that pack.

## Applying a pack setting

Click **Save pack** on each pack. Saving a pack applies its setting to most of that pack's rules. In Client Relationships, intro follow-up email can still be sent automatically unless that pack is Off. Until Billing and Payments is saved, past-due membership email can still be sent automatically.

## Autonomy is not the same as delivery permission

Choosing Handle automatically does not automatically give ARIA permission to send an email.

External delivery still depends on the underlying rule being explicitly allowed to send. ARIA automation sends email only; it does not send text messages.

## Financial safety

Billing and Payments can be set to Handle automatically for safe detection, preparation, and permitted communication.

ARIA still cannot automatically:

- Charge a payment method
- Retry a failed payment
- Issue a refund
- Waive a balance
- Mark a payment paid
- Create a payment transaction
- Change financial access or payment status

## Best practice

Start with DanceFlow's recommended pack settings, and click **Save pack** on each one to apply it. Change a pack only when your studio needs a different boundary.
