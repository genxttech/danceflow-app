import { describe, expect, it } from "vitest";
import { D24_EVENT_TYPES, d24Mode, isD24EventType, kindOf, normalizeD24Object } from "../normalize";

const invoice = (over: Record<string, unknown> = {}) => ({
  id: "in_1", object: "invoice", status: "void", total: 1000, amount_due: 1000, amount_paid: 0, amount_remaining: 1000, currency: "USD",
  customer_email: "pii@example.com", customer_name: "Pat Private", description: "secret", lines: { data: [{ description: "x" }] },
  metadata: { df_registry_id: "11111111-1111-4111-8111-111111111111", df_studio_id: "22222222-2222-4222-8222-222222222222", other: "ignored" }, ...over,
});

describe("D24 event types", () => {
  it("covers exactly the approved six and maps each to a kind", () => {
    expect([...D24_EVENT_TYPES].sort()).toEqual(["credit_note.created", "credit_note.updated", "credit_note.voided", "invoice.marked_uncollectible", "invoice.voided", "invoice_payment.paid"]);
    expect(kindOf("invoice.voided")).toBe("invoice");
    expect(kindOf("invoice.marked_uncollectible")).toBe("invoice");
    expect(kindOf("invoice_payment.paid")).toBe("invoice_payment");
    expect(kindOf("credit_note.voided")).toBe("credit_note");
    expect(isD24EventType("invoice.paid")).toBe(false);
    expect(isD24EventType("invoice.payment_failed")).toBe(false);
  });
  it("is off unless the flag is exactly 'on' or 'defer'", () => {
    expect(d24Mode({})).toBe("off");
    expect(d24Mode({ D24_HOSTED_INVOICE_EVENTS: "true" })).toBe("off");
    expect(d24Mode({ D24_HOSTED_INVOICE_EVENTS: "ON " })).toBe("on");
    expect(d24Mode({ D24_HOSTED_INVOICE_EVENTS: " Defer" })).toBe("defer");
  });
});

describe("invoice normalization", () => {
  it("keeps only whitelisted fields and never forwards personal data", () => {
    const r = normalizeD24Object("invoice.voided", invoice());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.object).toEqual({
      invoice_id: "in_1", status: "void", total: 1000, amount_due: 1000, amount_paid: 0, amount_remaining: 1000, currency: "usd",
      metadata_ref: "11111111-1111-4111-8111-111111111111", metadata_studio: "22222222-2222-4222-8222-222222222222", subscription_evidence: false,
    });
    expect(JSON.stringify(r.value)).not.toMatch(/pii@example|Pat Private|secret/);
  });
  it("records the actual status and refuses an event type that contradicts it", () => {
    expect(normalizeD24Object("invoice.marked_uncollectible", invoice({ status: "uncollectible" })).ok).toBe(true);
    expect(normalizeD24Object("invoice.voided", invoice({ status: "uncollectible" }))).toEqual({ ok: false, reason: "invoice_status_contradicts_event" });
    expect(normalizeD24Object("invoice.marked_uncollectible", invoice({ status: "void" }))).toEqual({ ok: false, reason: "invoice_status_contradicts_event" });
  });
  it.each([
    ["bad invoice id", { id: "evil" }, "invoice_id_invalid"],
    ["negative amount_due", { amount_due: -1 }, "invoice_amounts_invalid"],
    ["fractional amount", { amount_paid: 1.5 }, "invoice_amounts_invalid"],
    ["string amount", { amount_due: "10" }, "invoice_amounts_invalid"],
    ["unsafe integer", { total: 2 ** 60 }, "invoice_amounts_invalid"],
    ["bad currency", { currency: "dollars" }, "currency_invalid"],
  ])("rejects %s", (_n, over, reason) => {
    expect(normalizeD24Object("invoice.voided", invoice(over as Record<string, unknown>))).toEqual({ ok: false, reason });
  });
  it("keeps a signed (negative) invoice total, which Stripe allows", () => {
    const r = normalizeD24Object("invoice.voided", invoice({ total: -250 }));
    expect(r.ok && r.value.object.total).toBe(-250);
  });
  it("keeps subscription invoices as evidence-flagged facts instead of discarding them", () => {
    const flag = (over: Record<string, unknown>) => { const r = normalizeD24Object("invoice.voided", invoice(over)); return r.ok ? r.value.object.subscription_evidence : "rejected"; };
    expect(flag({ subscription: "sub_1" })).toBe(true);
    expect(flag({ billing_reason: "subscription_cycle" })).toBe(true);
    expect(flag({ billing_reason: "manual" })).toBe(false);
    expect(flag({})).toBe(false);
  });
  it("drops metadata references that are not UUIDs instead of storing free text", () => {
    const r = normalizeD24Object("invoice.voided", invoice({ metadata: { df_registry_id: "x".repeat(200), df_studio_id: "not-a-uuid" } }));
    expect(r.ok && r.value.object.metadata_ref).toBeNull();
    expect(r.ok && r.value.object.metadata_studio).toBeNull();
  });
  it("rejects non-objects", () => {
    expect(normalizeD24Object("invoice.voided", null).ok).toBe(false);
    expect(normalizeD24Object("invoice.voided", "in_1").ok).toBe(false);
    expect(normalizeD24Object("invoice.voided", []).ok).toBe(false);
  });
});

describe("invoice_payment normalization", () => {
  const pay = (over: Record<string, unknown> = {}) => ({ id: "inpay_1", object: "invoice_payment", invoice: "in_9", status: "paid", amount_requested: 500, amount_paid: 500, currency: "usd", payment: { type: "payment_intent", payment_intent: "pi_secret" }, ...over });
  it("keys on the invoice-payment id and accepts an expanded invoice", () => {
    const a = normalizeD24Object("invoice_payment.paid", pay());
    const b = normalizeD24Object("invoice_payment.paid", pay({ invoice: { id: "in_9" } }));
    expect(a).toEqual(b);
    expect(a.ok && a.value.object).toEqual({ invoice_id: "in_9", object_id: "inpay_1", status: "paid", amount_requested: 500, amount_paid: 500, currency: "usd" });
    expect(JSON.stringify(a)).not.toContain("pi_secret");
  });
  it("treats a null amount_paid as zero (Stripe reports null until paid)", () => {
    const r = normalizeD24Object("invoice_payment.paid", pay({ status: "open", amount_paid: null }));
    expect(r.ok && r.value.object.amount_paid).toBe(0);
  });
  it.each([
    ["bad payment id", { id: "pay_1" }, "invoice_payment_id_invalid"],
    ["missing invoice", { invoice: null }, "invoice_id_invalid"],
    ["unknown status", { status: "refunded" }, "invoice_payment_status_invalid"],
    ["negative requested", { amount_requested: -5 }, "invoice_payment_amounts_invalid"],
  ])("rejects %s", (_n, over, reason) => {
    expect(normalizeD24Object("invoice_payment.paid", pay(over as Record<string, unknown>))).toEqual({ ok: false, reason });
  });
});

describe("credit_note normalization", () => {
  const cn = (over: Record<string, unknown> = {}) => ({ id: "cn_1", object: "credit_note", invoice: "in_2", status: "issued", total: 750, currency: "usd", type: "post_payment", refund: "re_1", memo: "private", ...over });
  it("keeps the note and its invoice relationship only; no refund link is carried", () => {
    const r = normalizeD24Object("credit_note.created", cn());
    expect(r.ok && r.value.object).toEqual({ invoice_id: "in_2", object_id: "cn_1", status: "issued", credit_note_type: "post_payment", amount: 750, currency: "usd" });
    expect(JSON.stringify(r)).not.toMatch(/re_1|private/);
  });
  it("credit_note.voided requires a void note", () => {
    expect(normalizeD24Object("credit_note.voided", cn({ status: "void" })).ok).toBe(true);
    expect(normalizeD24Object("credit_note.voided", cn())).toEqual({ ok: false, reason: "credit_note_status_contradicts_event" });
  });
  it("tolerates a missing or unknown type and rejects bad ids and amounts", () => {
    const r = normalizeD24Object("credit_note.updated", cn({ type: "weird" }));
    expect(r.ok && r.value.object.credit_note_type).toBeNull();
    expect(normalizeD24Object("credit_note.created", cn({ id: "x" }))).toEqual({ ok: false, reason: "credit_note_id_invalid" });
    expect(normalizeD24Object("credit_note.created", cn({ total: -1 }))).toEqual({ ok: false, reason: "credit_note_amount_invalid" });
  });
});
