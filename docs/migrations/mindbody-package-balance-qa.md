# Mindbody Packages and Client Services QA

## Dry run
- Import Mindbody clients before package balances.
- Retain every available Pricing Option ID and Client Service ID.
- Review unsupported or ambiguous service types.
- Review negative, missing, or inconsistent visit balances.
- Treat duplicate source identities as blocking errors.

## Package templates
- Match by Mindbody Pricing Option ID first.
- Do not merge reused names automatically.
- Confirm private lessons, group classes, and practice parties map correctly.
- Confirm unlimited services remain unlimited.

## Client services
- Match the client by Mindbody Client ID.
- Preserve purchase and expiration dates.
- Preserve Visits Total and Visits Remaining.
- Confirm quantity used equals total minus remaining.
- Confirm expired client services are inactive.

## Historical safety
- Historical visits and attendance must not deduct imported remaining balances again.
- Create Only reruns must skip existing Client Service IDs.
- Create or Update reruns must update the same source-linked records.
- Historical payment imports must never create new charges.

## Reconciliation
- Compare pricing-option and client-service counts.
- Compare total remaining visits by usage type.
- Compare unlimited client-service counts.
- Resolve blocked rows before schedule and attendance migration.
