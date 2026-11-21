---
title: "Collecting In-Person Card Payments in DanceFlow"
slug: collecting-in-person-card-payments-in-danceflow
category: "Billing & Payments"
summary: "Use a registered Stripe reader to collect an in-person payment and attach it to the correct DanceFlow payment record."
order: 610
visibility: public
---

## Overview

DanceFlow's in-person card payment flow lets staff start a sale in DanceFlow, send the amount to a registered Stripe reader, and automatically connect the successful payment to the correct DanceFlow record.

This is different from Stripe Dashboard Tap to Pay.

With Stripe Dashboard Tap to Pay, staff starts the payment in the Stripe mobile app and records the payment in DanceFlow afterward.

With DanceFlow-controlled payments, staff starts the payment in DanceFlow and the customer pays on the registered reader.

## Technology required

To collect a DanceFlow-controlled in-person card payment, the studio needs:

- Completed Stripe payout setup
- A supported physical Stripe Terminal reader
- The reader registered in DanceFlow
- The reader online and available
- A DanceFlow payment workflow, such as package sale, lesson balance, client balance, or quick charge when available

## Linked payment process

Use this process for payments that must attach to a specific client, package, membership, appointment, or balance.

1. Open the payment workflow in DanceFlow.
2. Confirm the client, amount, and purchase type.
3. Choose In-person card reader.
4. Select the registered reader, if prompted.
5. Start card collection.
6. Ask the customer to tap, insert, or swipe their card on the reader.
7. Refresh the status after the payment is completed, if needed.
8. Confirm the payment shows as paid in DanceFlow.

For a package sale, the package can become active after payment succeeds.

## Quick charge process

Quick Charge is intended for fast front desk charges such as group class drop-ins, social party entrances, practice parties, floor fees, and other ad hoc charges.

The intended flow is:

1. Staff opens Quick Charge.
2. Staff taps a preset charge such as Group Class or Social Party.
3. DanceFlow sends the payment to the default registered reader.
4. Customer pays on the reader.
5. DanceFlow records the payment automatically.
6. Staff is ready for the next person.

Quick Charge may be expanded separately from linked package or membership payments because door-sale payments need fewer steps.

## Canceling a payment attempt

If the customer changes their mind, the reader is unavailable, or the wrong payment was started, use the cancel option before trying again.

## Best practice

Use DanceFlow-controlled reader payments when you want the payment automatically connected to DanceFlow.

Use Stripe Dashboard Tap to Pay only as a fallback when there is no registered reader available, and remember to record the payment in DanceFlow afterward.
