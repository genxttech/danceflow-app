---
title: "Taking In-Person Payments with Stripe Dashboard Tap to Pay"
slug: taking-in-person-payments-with-tap-to-pay
category: "Billing & Payments"
summary: "Use Stripe Dashboard Tap to Pay as a fallback phone-based payment option, then record the payment in DanceFlow."
order: 590
visibility: public
---

## Overview

Stripe Dashboard Tap to Pay lets a studio accept an in-person card payment using the Stripe Dashboard mobile app and a compatible phone.

This is a fallback process for studios that do not have a physical Stripe Terminal reader yet.

It is not the same as a DanceFlow-controlled reader payment.

## Technology required

Make sure:

- Your studio has completed Stripe payout setup.
- You can sign in to the Stripe Dashboard mobile app.
- Your phone supports Tap to Pay.
- Tap to Pay is available for your Stripe account and region.
- Staff know which DanceFlow sale, client, class, party, package, membership, lesson, or balance the payment belongs to.

A separate physical card reader is not required for Stripe Dashboard Tap to Pay.

## Process

1. Open the Stripe Dashboard mobile app.
2. Start a new payment or charge.
3. Enter the amount due.
4. Choose Tap to Pay when available.
5. Ask the customer to tap a contactless card or mobile wallet on the phone.
6. Wait for payment confirmation in Stripe.
7. Return to DanceFlow.
8. Record or confirm the payment against the correct DanceFlow record.

## What to record in DanceFlow

After the Stripe payment succeeds, open the correct area in DanceFlow:

- Client profile for general client payments
- Sell to Client (the Sell page) for package sales or package payments
- Memberships for membership payments
- Schedule or Daily Closeout for lesson balances
- Take Payment for ad hoc payments (choose Record collected payment)
- Event or door-sale tools for event-related payments, when available

Use:

- Method: Card already collected
- Notes: Stripe Dashboard Tap to Pay

## Why a DanceFlow record is still needed

A payment taken directly in the Stripe Dashboard app is not started by DanceFlow.

DanceFlow does not automatically know whether the payment was for a group class, social party, package, membership, lesson, event, floor rental, or client balance.

Recording the payment in DanceFlow keeps:

- Client history accurate
- Package and membership records accurate
- Payment reports accurate
- Front desk closeout cleaner
- Future accounting exports more reliable

## Best practice

For busy front desk payments, write down or immediately select the reason for the charge before using Tap to Pay.

After the payment succeeds, record it in DanceFlow right away so the studio does not have to reconcile unmatched Stripe charges later.
