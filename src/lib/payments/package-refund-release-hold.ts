// Package Refund P0 RELEASE HOLD. Released by PKG-REFUND-2: the Package
// Refund reconciliation RPCs (reconcile_package_stripe_refund,
// get_client_package_refund_financial_state,
// resolve_partial_refund_credit_review, restore_package_refund_reconciliation)
// and the refund-ledger unique index were applied and verified in DEV and
// PROD before this value was set to false. While held, none of these call
// sites reach the RPCs; setting it back to true re-holds every call site
// (a missing RPC would otherwise 500 the *entire* Stripe webhook event).
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
export const PACKAGE_REFUND_RECONCILIATION_RELEASE_HOLD = false;
