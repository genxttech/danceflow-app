---
title: "Registering a Stripe Card Reader in DanceFlow"
slug: registering-a-stripe-card-reader
category: "Billing & Payments"
summary: "Create a Terminal location, register a Stripe reader, and refresh reader status from the Billing & Payouts page."
order: 600
visibility: public
---

## Overview

DanceFlow-controlled in-person payments require a supported physical Stripe Terminal reader.

Registering the reader lets DanceFlow send a payment amount to the reader, collect the card-present payment, and connect the result back to the correct DanceFlow sale or payment record.

If your studio is only using Stripe Dashboard Tap to Pay, you do not need to register a reader in DanceFlow. Dashboard Tap to Pay is handled inside the Stripe Dashboard mobile app and must be recorded in DanceFlow afterward.

## Technology required

To use DanceFlow-controlled reader payments, make sure:

- Stripe payout setup is complete for the studio.
- The studio has a supported Stripe Terminal reader.
- The reader is powered on.
- The reader is connected to the internet.
- The reader shows a registration code.
- You have permission to manage billing or payment settings.

Recommended reader types include Stripe Terminal smart readers such as Stripe Reader S700/S710 or BBPOS WisePOS E, depending on availability in your region.

## Create or confirm the Terminal location

1. Go to Settings.
2. Open Billing & Payouts.
3. Find In-person payments or Card readers.
4. Create or confirm the studio Terminal location.

The Terminal location tells Stripe where the reader belongs.

## Register the reader

1. On the reader, find the registration code.
2. In DanceFlow, enter the registration code.
3. Add a clear label for the reader, such as Front Desk Reader.
4. Submit the registration.
5. Refresh the reader list.

After registration, the reader should appear in the DanceFlow reader list.

## Reader labels

Use labels that staff can recognize quickly.

Examples:

- Front Desk Reader
- Studio A Reader
- Event Door Reader
- Mobile Reader

## Troubleshooting

### The reader does not appear

Refresh the reader list. Confirm the reader is online and that the registration code was entered correctly.

### The registration code expired

Generate a new registration code on the reader and try again.

### The studio is not ready for reader setup

Complete Stripe payout setup first, then return to Billing & Payouts.

### Staff are trying to use a phone as the DanceFlow reader

A phone running the Stripe Dashboard app cannot act as the reader for a DanceFlow-started payment.

For DanceFlow-controlled payments, use a supported registered Stripe Terminal reader.

## Best practice

Register one front desk reader first and test it before adding multiple readers. Keep reader labels simple so front desk staff can choose the right device during payment collection.
