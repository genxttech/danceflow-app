import { vi } from "vitest";
import type { ScheduleStripe } from "../priceTransition";

export const PERIOD_START = new Date("2027-06-09T04:00:00Z");
export const BOUNDARY = new Date("2027-07-09T04:00:00Z");
export const u = (d: Date) => d.getTime() / 1000;

export const CARRY = {
  metadata: { studio: "st_1" },
  default_tax_rates: ["txr_1"],
  collection_method: "charge_automatically",
};

/** What Stripe really returns for an unset phase: nulls, empty arrays and the read-only automatic_tax.disabled_reason. */
const STRIPE_UNSET = { add_invoice_items: [], application_fee_percent: null, automatic_tax: { disabled_reason: null, enabled: false, liability: null }, billing_cycle_anchor: null, billing_thresholds: null, currency: "usd", default_payment_method: null, description: null, discounts: [], invoice_settings: null, on_behalf_of: null, transfer_data: null, trial_end: null };

function rejectInvalidInput(value: unknown, path = "phases"): void {
  if (value === null) throw new Error(`Invalid null for ${path}`);
  if (Array.isArray(value)) return value.forEach((v, i) => rejectInvalidInput(v, `${path}[${i}]`));
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "disabled_reason" || k === "currency" || k === "plan") throw new Error(`Received unknown parameter: ${path}[${k}]`);
      rejectInvalidInput(v, `${path}[${k}]`);
    }
  }
}

/** Recurring terms of the Prices the fake knows; unknown Prices are monthly USD. Stripe rejects mixed intervals/currencies in one phase. */
export type FakePriceTerms = Record<string, { interval: string; currency: string }>;

export type FakeItem = Record<string, unknown> & { price: string; quantity: number };

/** Stripe-style validation of the phases an update sends: things the real API refuses, so a wrong construction fails the test. */
function rejectInvalidPhases(phases: Array<Record<string, unknown>>, terms: FakePriceTerms): void {
  let previousEnd: number | null = null;
  phases.forEach((phase, index) => {
    const items = phase.items as FakeItem[] | undefined;
    if (!Array.isArray(items) || items.length === 0) throw new Error(`phases[${index}].items: at least one item is required`);
    const seen = new Set<string>();
    for (const item of items) {
      if (typeof item.price !== "string") throw new Error(`phases[${index}].items: price is required`);
      if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new Error(`phases[${index}].items: invalid quantity`);
      if (seen.has(item.price)) throw new Error(`phases[${index}].items: duplicate price ${item.price}`);
      seen.add(item.price);
    }
    const kinds = new Set(
      items.map((i) => {
        const t = terms[i.price] ?? { interval: "month", currency: "usd" };
        return `${t.interval}/${t.currency}`;
      }),
    );
    if (kinds.size > 1) throw new Error(`phases[${index}].items: prices in one phase must share the same interval and currency`);
    if (index > 0 && phase.start_date !== previousEnd) throw new Error(`phases[${index}].start_date must equal the previous phase end_date`);
    previousEnd = (phase.end_date as number | undefined) ?? null;
  });
}

type Phase = Record<string, unknown> & { start_date: number; end_date: number | null; items: FakeItem[] };

export type StatefulStripeOptions = {
  dropCarryOnUpdate?: boolean;
  failUpdate?: boolean;
  loseCreateResponse?: boolean;
  failRelease?: boolean;
  withAddInvoiceItems?: boolean;
  /** The subscription's items as the created schedule's first phase shows them (default: one legacy item). */
  items?: FakeItem[];
  priceTerms?: FakePriceTerms;
  /** Simulate Stripe dropping this Price from the SECOND phase, or changing its quantity there. */
  dropFromSecondPhase?: string;
  changeQuantityInSecondPhase?: { price: string; quantity: number };
  /** Simulate Stripe altering an item setting (not its Price or quantity) in the SECOND phase only. */
  patchSecondPhaseItem?: { price: string; patch: Record<string, unknown> };
  /** Simulate an item added to the subscription after scheduling: it shows up in the FIRST phase on read-back. */
  extraItemOnReadBack?: FakeItem;
};

/** A stateful fake of the Stripe schedule API: create yields one phase carrying CARRY, update replaces phases as given. */
export function statefulStripe(options: StatefulStripeOptions = {}) {
  const calls: string[] = [];
  let phases: Phase[] = [];
  let attached: string | null = null;
  let reads = 0;
  const stripe: ScheduleStripe = {
    subscriptionSchedules: {
      create: vi.fn(async () => {
        calls.push("create");
        attached = "sub_sched_1";
        const items = (options.items ?? [{ price: "price_legacy129", quantity: 1, metadata: { k: "v" } }]).map((i) => ({ plan: i.price, billing_thresholds: null, discounts: [], tax_rates: [], ...i }));
        phases = [{ ...STRIPE_UNSET, ...(options.withAddInvoiceItems ? { add_invoice_items: [{ price: "price_setup_fee" }] } : {}), ...CARRY, start_date: u(PERIOD_START), end_date: u(BOUNDARY), items }];
        if (options.loseCreateResponse) throw new Error("connection reset");
        return { id: "sub_sched_1" };
      }),
      update: vi.fn(async (_id: string, params: Parameters<ScheduleStripe["subscriptionSchedules"]["update"]>[1]) => {
        calls.push("update");
        if (options.failUpdate) throw new Error("stripe down");
        rejectInvalidInput(params.phases);
        rejectInvalidPhases(params.phases as unknown as Array<Record<string, unknown>>, options.priceTerms ?? {});
        phases = params.phases.map((p: (typeof params.phases)[number], index: number) => {
          const copy = { ...p, end_date: p.end_date ?? null } as unknown as Phase;
          if (options.dropCarryOnUpdate) delete copy.metadata;
          if (index === 1) {
            if (options.dropFromSecondPhase) copy.items = copy.items.filter((i) => i.price !== options.dropFromSecondPhase);
            const patch = options.patchSecondPhaseItem;
            if (patch) copy.items = copy.items.map((i) => (i.price === patch.price ? { ...i, ...patch.patch } : i));
            const change = options.changeQuantityInSecondPhase;
            if (change) copy.items = copy.items.map((i) => (i.price === change.price ? { ...i, quantity: change.quantity } : i));
          }
          return copy;
        });
        return {};
      }),
      retrieve: vi.fn(async () => {
        reads += 1;
        // The first retrieve is the executor's check of the created schedule; the extra item shows up on later reads.
        const shown =
          options.extraItemOnReadBack && reads > 1 && phases.length === 2
            ? phases.map((p, i) => (i === 0 ? { ...p, items: [...p.items, options.extraItemOnReadBack!] } : p))
            : phases;
        return { id: "sub_sched_1", status: "not_started", subscription: "sub_ABC123", phases: shown };
      }),
      release: vi.fn(async () => {
        calls.push("release");
        if (options.failRelease) throw new Error("release failed");
        attached = null;
        return {};
      }),
    },
    subscriptions: { retrieve: vi.fn(async () => ({ schedule: attached })) },
  };
  return { stripe, calls, state: () => ({ phases, attached }) };
}
