---
title: "In-Person Payment Options and Reader Requirements"
slug: in-person-payment-options-and-reader-requirements
category: "Billing & Payments"
summary: "Understand the difference between Stripe Dashboard Tap to Pay and DanceFlow-controlled card reader payments."
order: 580
visibility: public
---

## Overview

DanceFlow supports in-person payment tracking, but there are two different ways a studio may collect an in-person card payment.

These workflows are not the same. The technology requirements and recordkeeping steps are different.

## Option 1: Stripe Dashboard Tap to Pay

Use this option when the studio wants to accept a card payment using a phone and the Stripe Dashboard mobile app.

This is a useful fallback when the studio does not have a physical Stripe reader yet.

### Technology required

You need:

- A Stripe account connected for the studio
- The Stripe Dashboard mobile app
- A compatible phone
- Tap to Pay availability for the Stripe account and region
- A staff member who can sign in to the correct Stripe account

You do not need a separate physical reader for this option.

### Process

1. Staff opens the Stripe Dashboard mobile app.
2. Staff starts a charge inside Stripe.
3. Staff enters the amount in Stripe.
4. Customer taps their card or mobile wallet on the phone.
5. Stripe processes the payment.
6. Staff returns to DanceFlow and records the sale or payment against the correct client, package, membership, lesson, class, party, or balance.

### Important limitation

Payments taken directly in the Stripe Dashboard app are not started by DanceFlow.

That means DanceFlow does not automatically know what the payment was for. Staff must record the payment in DanceFlow so the client history, package balance, reports, and closeout records stay accurate.

## Option 2: DanceFlow-controlled card reader payment

Use this option when the studio wants to start the sale in DanceFlow and send the payment to a registered Stripe Terminal reader.

This is the recommended workflow for a clean front-desk process because the payment can be automatically tied to the DanceFlow sale.

### Technology required

You need:

- Stripe payout setup completed for the studio
- A supported physical Stripe Terminal reader
- The reader registered in DanceFlow
- The reader powered on and connected to the internet
- Staff access to the DanceFlow payment workflow

Recommended reader types include Stripe Terminal smart readers such as Stripe Reader S700/S710 or BBPOS WisePOS E, depending on availability in your region.

### Process

1. Staff starts the sale in DanceFlow.
2. Staff selects the correct purchase or charge type.
3. DanceFlow sends the payment amount to the registered Stripe reader.
4. Customer taps, inserts, or swipes their card on the reader.
5. Stripe processes the payment.
6. DanceFlow records the payment and links it to the correct sale or balance.

### Best use cases

DanceFlow-controlled reader payments are best for:

- Package payments
- Membership payments
- Appointment or lesson balances
- Client account balances
- Future quick charges for group classes, social parties, practice parties, and floor fees

## Which option should the studio use?

Use Stripe Dashboard Tap to Pay when:

- The studio does not have a physical reader yet
- A quick fallback payment is needed
- Staff are comfortable manually recording the payment in DanceFlow afterward

Use DanceFlow-controlled card reader payments when:

- The studio has a registered Stripe Terminal reader
- Staff need the payment connected to a DanceFlow sale automatically
- The studio wants cleaner reports and less manual reconciliation

## Important distinction

A phone using the Stripe Dashboard app does not act as the reader for a DanceFlow-started payment.

If the payment starts in the Stripe Dashboard app, it is a Stripe Dashboard payment and must be recorded in DanceFlow afterward.

If the payment starts in DanceFlow, it must be sent to a supported registered Stripe Terminal reader.
