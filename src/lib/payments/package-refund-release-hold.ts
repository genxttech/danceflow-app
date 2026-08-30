// Package Refund P0 RELEASE HOLD: the Package Refund reconciliation RPCs
// (reconcile_package_stripe_refund, resolve_partial_refund_credit_review,
// restore_package_refund_reconciliation) have not been applied to
// development or production. Until they have, calling any of them 500s
// whatever caller reaches them -- for the Stripe webhook, the *entire*
// event, not just the package-related part of it -- because PostgREST
// can't find the function. Held explicitly here rather than reverting the
// merged Package Refund work, so the implementation stays intact and fully
// verified for later activation.
//
// Single source of truth for every Package Refund reconciliation call
// site -- both automatic (the Stripe webhook's forward reconciliation and
// reversal restoration) and manual (the staff partial-refund review Server
// Action), plus the server-side UI suppression that keeps the review panel
// from ever rendering while held. Import this constant rather than
// redeclaring it locally.
//
//   true  = Package Refund reconciliation is held/inactive.
//   false = Package Refund reconciliation is activated.
//
// This value may be changed from true to false only as part of the
// controlled, combined Package Refund release -- after the required
// migrations have been applied to the target environment and verified
// there (see the Package Refund pre-activation hardening/runbook
// material) -- never as an isolated, standalone change.
export const PACKAGE_REFUND_RECONCILIATION_RELEASE_HOLD = true;
