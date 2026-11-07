// S11 / plan section 9 cleanup. Mandatory after every run, including after an abort, with two deliberate exceptions where touching Stripe
// again would be unsafe: livemode:true / identity mismatch / a blocked (buggy) request. There the script makes NO further call and prints the ids
// for manual cleanup by the owner.

import { NO_CLEANUP_AFTER, pinned, type GuardedClient } from "./guarded";
import type { Expect } from "./types";

export type CleanupReport = {
  skipped: string | null;
  stoppedBecause: string | null;
  deletedInvoices: string[];
  deletedCustomers: string[];
  remainingInvoices: string[];
  remainingCustomers: string[];
  /** creates whose outcome could not be confirmed (lost response, odd shape, 5xx...): look for them by metadata.d24_intent_id (see the README). Filled on EVERY path. */
  unverifiable: string[];
  verifiedEmpty: boolean;
};

export async function cleanup(client: GuardedClient, expect: Expect): Promise<CleanupReport> {
  const rep: CleanupReport = { skipped: null, stoppedBecause: null, deletedInvoices: [], deletedCustomers: [], remainingInvoices: [], remainingCustomers: [], unverifiable: [], verifiedEmpty: false };
  const acct = expect.connectedAcct;
  const a = client.aborted();
  if (a && NO_CLEANUP_AFTER.has(a.code)) {
    rep.skipped = `cleanup NOT run after ${a.code}: no further Stripe call is made. Manual cleanup needed.`;
    rep.remainingInvoices = [...client.seen.drafts];
    rep.remainingCustomers = [...client.seen.customers];
    rep.unverifiable = [...client.uncertain];
    return rep;
  }
  if (client.seen.nonDrafts.size > 0) {
    // plan: if any non-draft invoice exists, STOP and report; do not "fix" it
    rep.stoppedBecause = `non-draft invoice(s) present: ${[...client.seen.nonDrafts].join(", ")}`;
    rep.remainingInvoices = [...client.seen.drafts, ...client.seen.nonDrafts];
    rep.remainingCustomers = [...client.seen.customers];
    rep.unverifiable = [...client.uncertain];
    return rep;
  }
  try {
    for (const id of [...client.seen.drafts]) {
      const d = await pinned(client, { method: "DELETE", path: `/v1/invoices/${id}`, stripeAccount: acct }, { phase: "cleanup", expectStatus: [200, 404] });
      // listed as deleted ONLY when Stripe says so; a 404 / anything else leaves the id in `seen` (so it stays in remainingInvoices and verifiedEmpty stays false)
      if (d.status === 200 && d.json?.deleted === true && d.json?.id === id) rep.deletedInvoices.push(id);
    }
    let empty = true;
    const keep = new Set<string>(); // customers whose invoices could NOT be verified gone: never deleted, never reported clean
    const notes: string[] = [];
    for (const cus of [...client.seen.customers]) {
      const l = await pinned(client, { method: "GET", path: "/v1/invoices", stripeAccount: acct, query: { customer: cus, limit: "100" } }, { phase: "cleanup", expectStatus: [200] });
      // the read must have SUCCEEDED, returned a list, and the list must be complete; anything else means "not verified", never "empty"
      const readable = l.status === 200 && Array.isArray(l.json?.data) && l.json?.has_more !== true;
      if (!readable) {
        empty = false;
        keep.add(cus);
        notes.push(`invoices of ${cus} could not be read back (status ${l.status}${l.json?.has_more === true ? ", more than one page" : ""})`);
      } else if ((l.json?.data as unknown[]).length > 0) {
        empty = false;
        keep.add(cus);
        notes.push(`${cus} still has ${(l.json?.data as unknown[]).length} invoice(s)`);
      }
    }
    for (const cus of [...client.seen.customers]) {
      if (keep.has(cus)) continue;
      const d = await pinned(client, { method: "DELETE", path: `/v1/customers/${cus}`, stripeAccount: acct }, { phase: "cleanup", expectStatus: [200, 404] });
      if (d.status === 200 && d.json?.deleted === true && d.json?.id === cus) rep.deletedCustomers.push(cus);
    }
    // a lost response means an object may exist that was never seen: never claim "empty" in that case
    rep.verifiedEmpty = empty && client.seen.drafts.size === 0 && client.seen.customers.size === 0 && client.uncertain.length === 0;
    if (client.uncertain.length > 0) notes.push(`unverifiable: ${client.uncertain.length} create response(s) were lost (${client.uncertain.join("; ")}); check the dashboard`);
    if (notes.length > 0) rep.stoppedBecause = notes.join(" | ");
  } catch (e) {
    rep.stoppedBecause = `cleanup interrupted: ${(e as Error).message}`;
  }
  rep.remainingInvoices = [...client.seen.drafts];
  rep.remainingCustomers = [...client.seen.customers];
  rep.unverifiable = [...client.uncertain];
  return rep;
}

export const MANUAL_CLEANUP_NOTE =
  "Owner steps after the run: expire the restricted key in the dashboard (immediately), clear the shell variable and its history entry, verify the Invoices and Customers lists of the connected account are empty.";
