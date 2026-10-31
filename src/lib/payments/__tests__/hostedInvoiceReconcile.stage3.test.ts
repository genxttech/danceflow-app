import { describe, expect, it } from "vitest";
import history from "./fixtures/stage2-event-history.json";
import {
  applyInvoiceObservation,
  emptyLedger,
  reconcileInvoice,
  recordInvoicePayment,
  recordRefund,
  type HostedInvoiceStatus,
  type InvoiceObservation,
  type InvoiceState,
  type RefundFact,
} from "../hostedInvoiceReconcile";

/**
 * Stage 3 (WP3/WP4/WP5): order-independent reconciliation, driven by the event timelines recorded in the Stage 2
 * sandbox runs (metadata-only fixture: [event id, type, created, "object:id"], newest first as the Events API lists).
 */

type Row = [string, string, number, string];
const rows = history as Row[];
// chronological order, ties keep the API's reverse list position (the only order Stripe guarantees in the listing)
const chronological = [...rows].reverse();

const N1 = "in_1UWTQdEdWFD6rTYPwCS8Epya";
const W1 = "in_1UWTQfEdWFD6rTYP7zYv91jZ";
const W2 = "in_1UWTQhEdWFD6rTYP9lfGQ3z1";

/** Status carried by the invoice snapshot of each recorded invoice event, derived from the lifecycle seen so far. */
function timeline(invoiceId: string, amounts: { total: number; due: number; remaining: number }) {
  let status: HostedInvoiceStatus = "draft";
  const out: InvoiceObservation[] = [];
  for (const [, type, created, ref] of chronological) {
    if (ref !== `invoice:${invoiceId}`) continue;
    if (type === "invoice.finalized") status = "open";
    if (type === "invoice.voided") status = "void";
    if (type === "invoice.marked_uncollectible") status = "uncollectible";
    out.push({
      invoiceId,
      status,
      eventCreated: created,
      total: amounts.total,
      amountDue: status === "draft" ? 0 : amounts.due,
      amountPaid: 0,
      amountRemaining: status === "draft" ? 0 : amounts.remaining,
    });
  }
  return out;
}

function fold(observations: InvoiceObservation[]): InvoiceState | null {
  return observations.reduce<InvoiceState | null>((state, o) => applyInvoiceObservation(state, o), null);
}

function* permutations<T>(items: T[]): Generator<T[]> {
  if (items.length <= 1) {
    yield items;
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) yield [items[i], ...p];
  }
}

describe("recorded Stage 2 fixture", () => {
  it("is the settled-candidate history: 214 unique events with the documented shape", () => {
    expect(rows).toHaveLength(214);
    expect(new Set(rows.map((r) => r[0])).size).toBe(214);
    for (const r of rows) {
      expect(r).toHaveLength(4);
      expect(r[0]).toMatch(/^evt_[A-Za-z0-9]+$/);
      expect(Number.isInteger(r[2])).toBe(true);
      expect(r[3]).toMatch(/^(?:[a-z_]+:[A-Za-z0-9_]+|balance:)$/);
    }
  });

  it("has same-second invoice events, so event time alone cannot order a lifecycle", () => {
    const w1 = timeline(W1, { total: 4425, due: 4425, remaining: 4425 });
    const seconds = new Map<number, Set<HostedInvoiceStatus>>();
    for (const o of w1) seconds.set(o.eventCreated, (seconds.get(o.eventCreated) ?? new Set()).add(o.status));
    expect([...seconds.values()].some((s) => s.size > 1)).toBe(true);
  });
});

describe("WP4 invoice state converges under every delivery order", () => {
  it.each([
    ["N1 (open after credit)", N1, { total: 187575, due: 180150, remaining: 180150 }, "open"],
    ["W1 (voided)", W1, { total: 4425, due: 4425, remaining: 4425 }, "void"],
    ["W2 (marked uncollectible)", W2, { total: 4425, due: 4425, remaining: 4425 }, "uncollectible"],
  ] as const)("%s", (_name, id, amounts, finalStatus) => {
    const obs = timeline(id, amounts);
    const inOrder = fold(obs);
    expect(inOrder?.status).toBe(finalStatus);
    // exact duplicates collapse, so permute the distinct observations (at most 7! = 5040 orders)
    const distinct = [...new Map(obs.map((o) => [`${o.eventCreated}:${o.status}`, o])).values()];
    expect(distinct.length).toBeLessThanOrEqual(7);
    let checked = 0;
    for (const order of permutations(distinct)) {
      expect(fold(order)).toEqual(inOrder);
      checked++;
    }
    expect(checked).toBeGreaterThan(1);
    // every observation delivered twice in any interleaving changes nothing
    expect(fold([...obs, ...obs])).toEqual(inOrder);
    expect(fold([...obs].reverse())).toEqual(inOrder);
  });

  it("a late open snapshot never reopens a voided or uncollectible invoice", () => {
    const voided = fold(timeline(W1, { total: 4425, due: 4425, remaining: 4425 }))!;
    const staleOpen: InvoiceObservation = { invoiceId: W1, status: "open", eventCreated: voided.eventCreated - 5, total: 4425, amountDue: 4425, amountPaid: 0, amountRemaining: 4425 };
    expect(applyInvoiceObservation(voided, staleOpen).status).toBe("void");
    const uncollectible = fold(timeline(W2, { total: 4425, due: 4425, remaining: 4425 }))!;
    expect(applyInvoiceObservation(uncollectible, { ...staleOpen, invoiceId: W2 }).status).toBe("uncollectible");
  });

  it("an uncollectible invoice that is later paid moves forward; void and uncollectible stay distinct", () => {
    const base = fold(timeline(W2, { total: 4425, due: 4425, remaining: 4425 }))!;
    const paid = applyInvoiceObservation(base, { ...base, status: "paid", eventCreated: base.eventCreated + 60, amountPaid: 4425, amountRemaining: 0 });
    expect(paid.status).toBe("paid");
    expect(fold(timeline(W1, { total: 4425, due: 4425, remaining: 4425 }))?.status).not.toBe(base.status);
  });

  it("paid and void on one invoice is surfaced as an anomaly, in either order", () => {
    const mk = (status: HostedInvoiceStatus): InvoiceObservation => ({ invoiceId: "in_x", status, eventCreated: 100, total: 10, amountDue: 10, amountPaid: 0, amountRemaining: 10 });
    const a = fold([mk("paid"), mk("void")])!;
    const b = fold([mk("void"), mk("paid")])!;
    expect(a).toEqual(b);
    expect(a.anomalies).toContain("paid_and_void_observed");
  });

  it("refuses an observation for another invoice", () => {
    const s = fold(timeline(W1, { total: 4425, due: 4425, remaining: 4425 }))!;
    expect(() => applyInvoiceObservation(s, { ...s, invoiceId: "in_other" })).toThrow();
  });
});

describe("WP3 duplicate invoice_payment.paid", () => {
  const dupes = Object.entries(
    rows.reduce<Record<string, string[]>>((acc, r) => {
      if (r[1] === "invoice_payment.paid") (acc[r[3]] ??= []).push(r[0]);
      return acc;
    }, {}),
  ).filter(([, ids]) => ids.length > 1);

  it("the sandbox really did deliver more than one event for one invoice payment (2 payments, different event ids)", () => {
    expect(dupes).toHaveLength(2);
    for (const [, ids] of dupes) expect(new Set(ids).size).toBe(ids.length);
  });

  it("the money is recorded once per invoice payment id, whatever the number of events", () => {
    let ledger = emptyLedger();
    let firstSeen = 0;
    for (const [ref, ids] of dupes) {
      const inpay = ref.split(":")[1];
      for (const _id of ids) {
        const r = recordInvoicePayment(ledger, { invoicePaymentId: inpay, invoiceId: "in_1", status: "paid", amountPaid: 187575 });
        ledger = r.ledger;
        if (!r.duplicate) firstSeen++;
      }
    }
    expect(firstSeen).toBe(2);
    expect(Object.keys(ledger.payments)).toHaveLength(2);
    expect(ledger.anomalies).toEqual([]);
  });

  it("a replayed event is a no-op, a conflicting amount is an anomaly, and an open snapshot never downgrades paid", () => {
    const fact = { invoicePaymentId: "inpay_1", invoiceId: "in_1", status: "paid", amountPaid: 187575 } as const;
    const once = recordInvoicePayment(emptyLedger(), fact).ledger;
    expect(recordInvoicePayment(once, fact)).toEqual({ ledger: once, duplicate: true });
    expect(recordInvoicePayment(once, { ...fact, status: "open" }).ledger.payments.inpay_1.status).toBe("paid");
    const conflict = recordInvoicePayment(once, { ...fact, amountPaid: 100 });
    expect(conflict.duplicate).toBe(true);
    expect(conflict.ledger.payments.inpay_1.amountPaid).toBe(187575);
    expect(conflict.ledger.anomalies).toEqual(["invoice_payment_conflict:inpay_1"]);
  });

  it("order of an open event and a paid event for one payment does not matter", () => {
    const open = { invoicePaymentId: "inpay_2", invoiceId: "in_2", status: "open", amountPaid: 500 } as const;
    const paid = { ...open, status: "paid" } as const;
    const a = recordInvoicePayment(recordInvoicePayment(emptyLedger(), open).ledger, paid).ledger;
    const b = recordInvoicePayment(recordInvoicePayment(emptyLedger(), paid).ledger, open).ledger;
    expect(a).toEqual(b);
  });
});

describe("WP5 reconciliation of payments, refunds, credits and invoice state (Stage 2 figures)", () => {
  const paidState = (id: string, total: number): InvoiceState => ({ invoiceId: id, status: "paid", eventCreated: 1, total, amountDue: total, amountPaid: total, amountRemaining: 0, anomalies: [] });

  it("a fully refunded invoice stays paid but nets to zero (ACH invoice A: 187575 paid, 187575 refunded)", () => {
    const ledger = recordInvoicePayment(emptyLedger(), { invoicePaymentId: "inpay_A", invoiceId: "in_A", status: "paid", amountPaid: 187575 }).ledger;
    let refunds: Record<string, RefundFact> = {};
    refunds = recordRefund(refunds, { refundId: "pyr_A", invoiceId: "in_A", amount: 187575, status: "pending" });
    let r = reconcileInvoice({ invoice: paidState("in_A", 187575), payments: ledger, refunds });
    expect(r).toMatchObject({ collected: 187575, refunded: 0, netReceived: 187575 }); // pending is not yet money back
    refunds = recordRefund(refunds, { refundId: "pyr_A", invoiceId: "in_A", amount: 187575, status: "succeeded" });
    r = reconcileInvoice({ invoice: paidState("in_A", 187575), payments: ledger, refunds });
    expect(r).toMatchObject({ collected: 187575, refunded: 187575, netReceived: 0, anomalies: [] });
  });

  it("refund updates are order-independent and never move backwards", () => {
    const pending: RefundFact = { refundId: "pyr_1", invoiceId: "in_1", amount: 5, status: "pending" };
    const done: RefundFact = { ...pending, status: "succeeded" };
    expect(recordRefund(recordRefund({}, pending), done)).toEqual(recordRefund(recordRefund({}, done), pending));
    expect(recordRefund(recordRefund({}, done), pending).pyr_1.status).toBe("succeeded");
  });

  it("a refund larger than the money collected is flagged", () => {
    const ledger = recordInvoicePayment(emptyLedger(), { invoicePaymentId: "inpay_B", invoiceId: "in_B", status: "paid", amountPaid: 1000 }).ledger;
    const refunds = recordRefund({}, { refundId: "pyr_B", invoiceId: "in_B", amount: 1500, status: "succeeded" });
    expect(reconcileInvoice({ invoice: paidState("in_B", 1000), payments: ledger, refunds }).anomalies).toContain("refunded_exceeds_collected");
  });

  it("N1: the 7425 credit was applied before payment, so 180150 stays an open receivable and nothing is collected", () => {
    const n1 = fold(timeline(N1, { total: 187575, due: 180150, remaining: 180150 }))!;
    expect(reconcileInvoice({ invoice: n1, payments: emptyLedger(), refunds: {} })).toEqual({
      collected: 0, refunded: 0, netReceived: 0, openReceivable: 180150, uncollectibleAmount: 0, anomalies: [],
    });
  });

  it("W1 void and W2 uncollectible report separately: void leaves no receivable, uncollectible keeps a written-off amount, neither refunds anything", () => {
    const w1 = reconcileInvoice({ invoice: fold(timeline(W1, { total: 4425, due: 4425, remaining: 4425 }))!, payments: emptyLedger(), refunds: {} });
    const w2 = reconcileInvoice({ invoice: fold(timeline(W2, { total: 4425, due: 4425, remaining: 4425 }))!, payments: emptyLedger(), refunds: {} });
    expect(w1).toMatchObject({ openReceivable: 0, uncollectibleAmount: 0, refunded: 0, netReceived: 0 });
    expect(w2).toMatchObject({ openReceivable: 0, uncollectibleAmount: 4425, refunded: 0, netReceived: 0 });
  });

  it("a void invoice that has collected money is flagged rather than silently erased", () => {
    const ledger = recordInvoicePayment(emptyLedger(), { invoicePaymentId: "inpay_V", invoiceId: "in_V", status: "paid", amountPaid: 900 }).ledger;
    const voided: InvoiceState = { invoiceId: "in_V", status: "void", eventCreated: 1, total: 900, amountDue: 900, amountPaid: 0, amountRemaining: 900, anomalies: [] };
    const r = reconcileInvoice({ invoice: voided, payments: ledger, refunds: {} });
    expect(r.collected).toBe(900);
    expect(r.anomalies).toContain("void_invoice_has_payments");
  });
});
