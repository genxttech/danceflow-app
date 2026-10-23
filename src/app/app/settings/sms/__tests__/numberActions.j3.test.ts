import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const STUDIO = "0f0f0000-0000-4000-8000-0000000000aa";
const OFFER = "0f0f0000-0000-4000-8000-000000000001";
const SEL = "0f0f0000-0000-4000-8000-000000000002";
let role: string | null = "studio_owner";
let offers: Record<string, unknown>;
let rpcResult: { data: unknown; error: { code: string } | null };
const calls: { fn: string; args: Record<string, unknown> }[] = [];
const supabase = {
  rpc: async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (fn === "get_studio_sms_number_offers") return { data: offers, error: null };
    return rpcResult;
  },
};
vi.mock("@/lib/auth/serverRoleGuard", () => ({ getCurrentUserStudioContext: async () => ({ supabase, user: { id: "u1" }, studioId: STUDIO, studioRole: role, isPlatformAdmin: false }) }));

import { approveNumberAction, withdrawNumberAction } from "../numberActions";

const baseOffers = (over: Record<string, unknown> = {}) => ({
  available: true, version: 1, step_open: true, price: { published: true, monthly_cents: 115 }, funding_mode: "credit_recurring", pilot_ceiling_reached: false,
  offer: { offer_id: OFFER, expires_at: "2026-10-23T12:00:00Z", numbers: [{ e164: "+15035550101", locality: null, region: null }] }, approval: null, blocker: "none", ...over,
});
const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};
const good = { e164: "+15035550101", offer_id: OFFER, ack_price_cents: "115", confirm: "yes" };
const mutations = () => calls.filter((c) => c.fn !== "get_studio_sms_number_offers");

beforeEach(() => {
  calls.length = 0;
  role = "studio_owner";
  offers = baseOffers();
  rpcResult = { data: { selection_id: SEL }, error: null };
});

describe("approveNumberAction (J3)", () => {
  it("owner: approves through the owner RPC with the server-side studio, the CURRENT offer id and the published price", async () => {
    const out = await approveNumberAction({}, form({ ...good, studio_id: "e2220000-0000-4000-8000-00000000ffff" }));
    expect(out.ok).toBe(true);
    expect(mutations()).toEqual([{ fn: "tw4_num_select_as_owner", args: { p_studio_id: STUDIO, p_offer_id: OFFER, p_e164: "+15035550101", p_ack_price_cents: 115 } }]);
  });
  it("a forged studio id in the form is ignored (the studio comes from the session)", async () => {
    await approveNumberAction({}, form({ ...good, studio_id: "other", p_studio_id: "other" }));
    expect(calls.every((c) => c.args.p_studio_id === STUDIO)).toBe(true);
  });
  it("non-owners never reach the database", async () => {
    for (const r of ["studio_admin", "front_desk", null]) {
      role = r;
      calls.length = 0;
      expect((await approveNumberAction({}, form(good))).ok).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });
  it("refused without sending: no confirmation, stale offer, changed price, number not offered, unpublished price, pilot ceiling, step closed, open approval (replay)", async () => {
    const cases: [Record<string, string>, Record<string, unknown>][] = [
      [{ ...good, confirm: "" }, baseOffers()],
      [{ ...good, offer_id: "0f0f0000-0000-4000-8000-000000000009" }, baseOffers()],
      [{ ...good, ack_price_cents: "100" }, baseOffers()],
      [{ ...good, e164: "+15035550199" }, baseOffers()],
      [good, baseOffers({ price: { published: false, monthly_cents: null }, blocker: "unpriced" })],
      [good, baseOffers({ funding_mode: "pilot", pilot_ceiling_reached: true, blocker: "pilot_ceiling" })],
      [good, baseOffers({ step_open: false, blocker: "not_open" })],
      [good, baseOffers({ approval: { selection_id: SEL, e164: "+15035550101", status: "open", expires_at: "2026-10-24T00:00:00Z", statement: "x" } })],
      [good, { available: false }],
    ];
    for (const [fields, o] of cases) {
      offers = o;
      calls.length = 0;
      const out = await approveNumberAction({}, form(fields));
      expect(out.ok, JSON.stringify(fields) + JSON.stringify(o)).toBe(false);
      expect(mutations()).toHaveLength(0);
    }
  });
  it("database refusals become owner language; internal detail never leaks", async () => {
    for (const code of ["TW008", "TW040", "23505", "42501"]) {
      rpcResult = { data: null, error: { code } };
      const out = await approveNumberAction({}, form(good));
      expect(out.ok).toBe(false);
      expect(out.error).not.toMatch(/TW0|23505|42501|sql|exception/i);
    }
  });
});

describe("withdrawNumberAction (J3)", () => {
  const open = { selection_id: SEL, e164: "+15035550101", status: "open", expires_at: "2026-10-24T00:00:00Z", statement: "x" };
  it("withdraws only the owner's current approval of this studio", async () => {
    offers = baseOffers({ approval: open });
    rpcResult = { data: { status: "withdrawn" }, error: null };
    expect((await withdrawNumberAction({}, form({ selection_id: SEL }))).ok).toBe(true);
    expect(mutations()).toEqual([{ fn: "tw4_num_withdraw_as_owner", args: { p_studio_id: STUDIO, p_selection_id: SEL, p_note: "withdrawn by the studio owner" } }]);
  });
  it("a different selection id, no open approval or a non-owner is refused without sending", async () => {
    offers = baseOffers({ approval: open });
    expect((await withdrawNumberAction({}, form({ selection_id: "0f0f0000-0000-4000-8000-000000000003" }))).ok).toBe(false);
    offers = baseOffers();
    expect((await withdrawNumberAction({}, form({ selection_id: SEL }))).ok).toBe(false);
    role = "studio_admin";
    offers = baseOffers({ approval: open });
    expect((await withdrawNumberAction({}, form({ selection_id: SEL }))).ok).toBe(false);
    expect(mutations()).toHaveLength(0);
  });
  it("a used approval (purchase started) is explained, not retried", async () => {
    offers = baseOffers({ approval: open });
    rpcResult = { data: null, error: { code: "22023" } };
    expect((await withdrawNumberAction({}, form({ selection_id: SEL }))).error).toMatch(/already being secured/);
  });
});
