// S11 / plan section 9 cleanup. Mandatory after every run, including after an abort, with two deliberate exceptions where touching Stripe
// again would be unsafe: livemode:true / identity mismatch / a blocked (buggy) request. There the script makes NO further call and prints the ids
// for manual cleanup by the owner.

import type { GuardedClient } from "./guarded";
import type { Expect } from "./types";

export type CleanupReport = {
  skipped: string | null;
  stoppedBecause: string | null;
  deletedInvoices: string[];
  deletedCustomers: string[];
  remainingInvoices: string[];
  remainingCustomers: string[];
  verifiedEmpty: boolean;
};

export async function cleanup(client: GuardedClient, expect: Expect): Promise<CleanupReport> {
  const rep: CleanupReport = { skipped: null, stoppedBecause: null, deletedInvoices: [], deletedCustomers: [], remainingInvoices: [], remainingCustomers: [], verifiedEmpty: false };
  const acct = expect.connectedAcct;
  const a = client.aborted();
  if (a && (a.code === "livemode_true" || a.code === "identity_mismatch" || a.code === "blocked_request" || a.code === "environment_refused" || a.code === "key_refused")) {
    rep.skipped = `cleanup NOT run after ${a.code}: no further Stripe call is made. Manual cleanup needed.`;
    rep.remainingInvoices = [...client.seen.drafts];
    rep.remainingCustomers = [...client.seen.customers];
    return rep;
  }
  if (client.seen.nonDrafts.size > 0) {
    // plan: if any non-draft invoice exists, STOP and report; do not "fix" it
    rep.stoppedBecause = `non-draft invoice(s) present: ${[...client.seen.nonDrafts].join(", ")}`;
    rep.remainingInvoices = [...client.seen.drafts, ...client.seen.nonDrafts];
    rep.remainingCustomers = [...client.seen.customers];
    return rep;
  }
  try {
    for (const id of [...client.seen.drafts]) {
      await client.call({ method: "DELETE", path: `/v1/invoices/${id}`, stripeAccount: acct }, { phase: "cleanup", expectStatus: [200, 404] });
      rep.deletedInvoices.push(id);
    }
    let empty = true;
    for (const cus of [...client.seen.customers]) {
      const l = await client.call({ method: "GET", path: "/v1/invoices", stripeAccount: acct, query: { customer: cus, limit: "100" } }, { phase: "cleanup" });
      if (Array.isArray(l.json?.data) && l.json.data.length > 0) empty = false;
    }
    for (const cus of [...client.seen.customers]) {
      await client.call({ method: "DELETE", path: `/v1/customers/${cus}`, stripeAccount: acct }, { phase: "cleanup", expectStatus: [200, 404] });
      rep.deletedCustomers.push(cus);
    }
    rep.verifiedEmpty = empty && client.seen.drafts.size === 0 && client.seen.customers.size === 0;
  } catch (e) {
    rep.stoppedBecause = `cleanup interrupted: ${(e as Error).message}`;
  }
  rep.remainingInvoices = [...client.seen.drafts];
  rep.remainingCustomers = [...client.seen.customers];
  return rep;
}

export const MANUAL_CLEANUP_NOTE =
  "Owner steps after the run: expire the restricted key in the dashboard (immediately), clear the shell variable and its history entry, verify the Invoices and Customers lists of the connected account are empty.";
