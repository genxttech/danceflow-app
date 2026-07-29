# Mindbody Client, Staff, and Relationship QA

## Clients
- Run Dry Run before live execution.
- Retain available Mindbody client IDs.
- Review duplicate emails and normalized phone matches.
- Do not merge family members solely because they share contact details.
- Confirm create-only reruns skip existing source identities.
- Confirm create-or-update reruns update the same DanceFlow client.

## Relationships
- Preserve explicit guardian, dependent, payer, household, and related-client links.
- Resolve by related Mindbody client ID before email fallback.
- Review unresolved relationships.
- Never link a client relationship to the same DanceFlow client record.
- Confirm relationship source IDs make reruns safe.

## Staff
- Retain Mindbody staff IDs.
- Match source ID first and email second.
- Import teaching records as instructors.
- Review Manager, Front Desk, Owner, Administrator, and similar source roles.
- Never grant DanceFlow owner, administrator, payroll, or financial permissions automatically.

## Reconciliation
- Compare client and staff totals with source exports.
- Compare relationship rows, resolved relationships, and relationships needing review.
- Resolve blocking source-identity conflicts before later stages.
