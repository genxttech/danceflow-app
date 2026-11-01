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

type Phase = Record<string, unknown> & { start_date: number; end_date: number | null; items: Array<Record<string, unknown> & { price: string; quantity: number }> };

/** A stateful fake of the Stripe schedule API: create yields one phase carrying CARRY, update replaces phases as given. */
export function statefulStripe(options: { dropCarryOnUpdate?: boolean; failUpdate?: boolean; loseCreateResponse?: boolean; failRelease?: boolean } = {}) {
  const calls: string[] = [];
  let phases: Phase[] = [];
  let attached: string | null = null;
  const stripe: ScheduleStripe = {
    subscriptionSchedules: {
      create: vi.fn(async () => {
        calls.push("create");
        attached = "sub_sched_1";
        phases = [{ ...CARRY, start_date: u(PERIOD_START), end_date: u(BOUNDARY), items: [{ price: "price_legacy129", quantity: 1, metadata: { k: "v" } }] }];
        if (options.loseCreateResponse) throw new Error("connection reset");
        return { id: "sub_sched_1" };
      }),
      update: vi.fn(async (_id: string, params: Parameters<ScheduleStripe["subscriptionSchedules"]["update"]>[1]) => {
        calls.push("update");
        if (options.failUpdate) throw new Error("stripe down");
        phases = params.phases.map((p: (typeof params.phases)[number]) => {
          const copy = { ...p, end_date: p.end_date ?? null } as unknown as Phase;
          if (options.dropCarryOnUpdate) delete copy.metadata;
          return copy;
        });
        return {};
      }),
      retrieve: vi.fn(async () => ({ id: "sub_sched_1", status: "not_started", subscription: "sub_ABC123", phases })),
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
