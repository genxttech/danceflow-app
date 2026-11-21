---
title: "How DanceFlow Protects Your Studio, Students, Events, and Business Data"
slug: how-danceflow-protects-your-data
category: "Security & Privacy"
summary: "A plain-English overview of the security protections DanceFlow uses to help protect studio, student, event, payment, and business data."
order: 700
visibility: public
---

## Overview

DanceFlow is built for dance studios, organizers, instructors, and dancers. Because DanceFlow supports client records, schedules, payments, documents, event registrations, public listings, and business workflows, security is treated as an ongoing product priority.

This article explains the protections DanceFlow has in place in plain language. It is written to help studio owners, organizers, staff, and students understand the steps DanceFlow takes to reduce common risks.

No software platform can eliminate every possible risk, but DanceFlow is actively hardened to help protect your studio, your students, your events, and your business data.

## Secure sign-in and account access

DanceFlow uses authenticated access for studio workspaces, organizer tools, student portals, and mobile app features.

**What this helps protect against:** People accessing private studio, client, student, event, billing, or schedule information without signing in.

## Safer sign-in links and redirects

DanceFlow validates where users are sent after login, signup, logout, password reset, and secure email sign-in flows.

**What this helps protect against:** Unsafe links that try to trick someone into signing in and then sending them to a malicious website.

## Role-based permissions

DanceFlow checks user roles before allowing access to sensitive tools such as billing, reports, exports, payments, client records, schedule management, event tools, and settings.

**What this helps protect against:** Staff, instructors, or other users seeing or changing information outside their responsibilities.

## Studio and workspace separation

DanceFlow checks that clients, appointments, payments, packages, memberships, documents, reports, and exports belong to the correct studio or workspace before showing or updating them.

**What this helps protect against:** One studio or workspace accidentally accessing another studio's private business information.

## Student portal ownership checks

DanceFlow verifies that a signed-in student is connected to the correct client record, portal, schedule item, document, ticket, payment request, or event order.

**What this helps protect against:** A student viewing or changing another student's schedule, documents, tickets, wallet items, or portal information.

## Mobile app ownership checks

DanceFlow mobile app routes validate the signed-in user before returning schedule, wallet, ticket, event order, partner message, or self-service booking information.

**What this helps protect against:** Mobile users accessing records that do not belong to them.

## Public data minimization

DanceFlow public pages, public discovery, website embeds, and public calendar feeds are designed to show only information intended for public viewing.

**What this helps protect against:** Internal notes, draft content, private listings, unpublished events, inactive listings, or non-public descriptions appearing publicly.

## Public calendar and website embed protection

DanceFlow website calendar feeds and embed tools only include eligible public events from active workspaces and return limited event details.

**What this helps protect against:** Hidden events, inactive studio listings, private event information, or internal event copy leaking through calendar feeds or website embeds.

## Secure payment processing

DanceFlow uses Stripe for online payments, in-app payments, subscriptions, event tickets, and in-person card reader workflows. DanceFlow verifies payment results before marking related records as paid or complete.

**What this helps protect against:** Fake payment confirmations, unpaid access being granted by mistake, mismatched payment amounts, or incorrect payment status updates.

## Stripe webhook protection

DanceFlow verifies Stripe webhook signatures and checks payment details before updating registrations, tickets, subscriptions, orders, packages, memberships, or payment records.

**What this helps protect against:** Forged payment events, incorrect payment updates, duplicate processing, or records being marked paid without a verified payment.

## In-person card reader checks

DanceFlow validates in-person card reader payment sessions before completing payment records.

**What this helps protect against:** Stale reader sessions, mismatched amounts, duplicate processing, or a payment being attached to the wrong record.

## Event ticketing and registration controls

DanceFlow checks event visibility, registration windows, ticket availability, capacity, required documents, and payment status during event checkout.

**What this helps protect against:** Oversold events, expired checkout attempts, private event exposure, invalid ticket purchases, or missing required documents.

## Document and e-signature records

DanceFlow stores signed document details such as signer name, signer email, timestamp, accepted document text, consent language, and audit information.

**What this helps protect against:** Unclear document history, accidental overwriting of signed versions, missing proof of acceptance, or confusion about what was signed.

## File upload validation

DanceFlow validates uploaded files by type, size, extension, and expected content patterns.

**What this helps protect against:** Unsafe or unexpected files being uploaded as client photos, instructor photos, event images, public profile images, imports, or other assets.

## Form validation

DanceFlow validates important form inputs such as names, emails, phone numbers, dates, IDs, notes, statuses, and public settings before saving them.

**What this helps protect against:** Broken records, malformed submissions, accidental bad data, and some common abuse attempts.

## Bot and spam protection

DanceFlow uses rate limits, form validation, honeypot fields, timing checks, and abuse checks on public forms and messaging surfaces.

**What this helps protect against:** Spam submissions, automated form abuse, fake leads, message flooding, and public form attacks.

## Rate limiting on high-risk actions

DanceFlow limits repeated attempts on sensitive actions such as login, checkout, billing, SMS, student app requests, partner messages, AI actions, and public forms.

**What this helps protect against:** Brute-force attempts, repeated checkout abuse, message spam, and automated abuse.

## Safer error messages

DanceFlow avoids showing sensitive system, database, payment provider, SMS provider, OAuth, or webhook details in user-facing error messages.

**What this helps protect against:** Attackers learning internal system details from public error messages.

## OAuth connection protection

DanceFlow protects Google Calendar and Wave Accounting connections with OAuth state validation and encrypted token storage.

**What this helps protect against:** Unauthorized account linking, stolen connection attempts, and exposure of integration access tokens.

## Scheduled job and callback protection

DanceFlow protects scheduled jobs, notification routes, SMS callbacks, and other sensitive background routes with shared secrets or verified provider requests.

**What this helps protect against:** Unauthorized systems triggering private background jobs or fake provider callbacks.

## Browser security headers

DanceFlow uses browser security headers to reduce common web risks.

**What this helps protect against:** Certain browser-based attacks such as content-type confusion, unsafe framing, broad browser permissions, and unintended cross-site behavior.

## SMS consent checks

DanceFlow checks SMS opt-in status before sending text messages and protects delivery status callbacks with a secret.

**What this helps protect against:** Unauthorized texting, accidental messaging without consent, and fake delivery updates.

## Public partner and job listing controls

DanceFlow public Partner Search and Now Hiring areas use published/active listing rules and controlled public fields.

**What this helps protect against:** Hidden, disabled, or inappropriate listings appearing publicly.


## Secure accountant report delivery

DanceFlow can send accountant reports through time-limited secure links instead of placing sensitive financial reports directly in an email attachment.

Access tokens are stored in protected form, links expire, canceled deliveries stop working, and only the reports selected for that delivery are available.

**What this helps protect against:** Sensitive accounting reports being exposed through forwarded attachments, guessed URLs, expired links, or access to reports that were not approved for delivery.

## Safer spreadsheet exports

DanceFlow’s CSV exports (accountant reports, financial and event reports, and instructor pay files) use one shared routine that neutralizes text a spreadsheet could interpret as a formula, including text that begins with spaces or tabs. Cells that could be read as formulas are prefixed with an apostrophe so they open as plain text. Client file imports are not CSV exports and are not covered by this protection.

**What this helps protect against:** Studio-entered text being interpreted as a formula or command when a report is opened in spreadsheet software.

## AI and automation safeguards

DanceFlow uses role checks, rate limits, and review-oriented workflows around AI-assisted business tools.

**What this helps protect against:** Uncontrolled automation, excessive AI requests, or AI tools acting outside allowed workspace context.

## Ongoing security improvements

Security is not a one-time project. DanceFlow continues to improve protections as the product grows.

Planned security maturity improvements include:

- Stronger distributed rate limiting across production infrastructure.
- Additional security audit logging for sensitive business actions.
- Pen-test style reviews of high-risk routes and workflows.
- Continued review of public pages, exports, payments, documents, integrations, and mobile APIs.

## What this means for your studio

DanceFlow is designed to help protect your studio operations, student information, event registrations, payments, documents, and public listings.

The goal is simple: keep the right information available to the right people, reduce common security risks, and continue improving safeguards as DanceFlow grows.
