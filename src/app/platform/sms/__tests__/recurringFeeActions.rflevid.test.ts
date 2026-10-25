import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/platform-assurance", async () => (await import("@/lib/auth/__tests__/stepUpDouble")).stepUpDouble());

vi.mock("server-only", () => ({}));
const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirects.push(url);
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const cookieWrites: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ set: (name: string, value: string) => cookieWrites.push({ name, value }) }) }));
const ADMIN = "a6000000-0000-4000-8000-000000000601";
vi.mock("@/lib/auth/platform", () => ({ requirePlatformAdmin: async () => ({ id: ADMIN }) }));
const rpc: { fn: string; args: Record<string, unknown> }[] = [];
let replies: Record<string, { data?: unknown; error?: { code?: string; message?: string } }> = {};
let clientsBuilt = 0;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    clientsBuilt += 1;
    return {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        rpc.push({ fn, args });
        const r = replies[fn];
        if (!r) return { data: null, error: { code: "42883", message: "missing" } };
        return { data: r.data ?? null, error: r.error ?? null };
      },
    };
  },
}));

import { APPROVAL_REF_MAX, APPROVAL_REF_MIN, EVIDENCE_MAX_AGE_DAYS } from "@/lib/sms/pilotApprovalEvidence";
import { parseOverview } from "@/lib/sms/providerFeeOps";
import RecurringFeesPilot from "../RecurringFeesPilot";
import { rflPilotCoverAction } from "../recurringFeeActions";

const U = (n: number) => `d${String(n).padStart(7, "0")}-0000-4000-8000-000000000001`;
const RES = U(1);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const evidence = (over: Record<string, string> = {}) => ({
  authorizedOn: day(-3), authorizedByRole: "owner_written", scope: "pilot_period_cover", amountUsd: "25.00", documentRef: "AUTH-DOC-2026-10-0001", documentSha256: "b".repeat(64), ...over,
});
const refOf = (n: number) => "R".repeat(n);
const base = (over: Record<string, string> = {}) => ({ resourceId: RES, periodKey: "2026-10", approvalRef: refOf(20), ack: "yes", ...evidence(), ...over });

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
async function run(fields: Record<string, string>): Promise<string> {
  await expect(rflPilotCoverAction(form(fields))).rejects.toThrow("NEXT_REDIRECT");
  return (JSON.parse(cookieWrites[cookieWrites.length - 1].value) as { message: string }).message;
}
const pilotOverview = {
  data: {
    resources: [{
      resource_id: RES, legal_entity_id: U(3), studio_id: U(2), kind: "number", fee_kind: "number", provider_state: "active", df_sending: true,
      current_period: "uncovered:no_pilot_approval", next_period: "uncovered:no_pilot_approval", open_cancel_operation: null,
    }],
    cancel_operations_open: 0,
  },
};
const covers = () => rpc.filter((c) => c.fn === "tw4_rfl_pilot_cover");

beforeEach(() => {
  redirects.length = 0;
  cookieWrites.length = 0;
  rpc.length = 0;
  replies = {};
  clientsBuilt = 0;
});

describe("one shared approval-reference length (10 to 200)", () => {
  it("the shared constants are 10 and 200", () => {
    expect([APPROVAL_REF_MIN, APPROVAL_REF_MAX]).toEqual([10, 200]);
  });

  it("the form uses the shared min and max, and collects the evidence fields without ever asking for the text", () => {
    const overview = parseOverview(pilotOverview.data);
    const html = renderToStaticMarkup(createElement(RecurringFeesPilot, { overview, now: Date.parse("2026-10-21T12:00:00Z"), prices: { number: 2500 } }));
    const input = /<input[^>]*name="approvalRef"[^>]*>/.exec(html)?.[0] ?? "";
    expect(input).toContain(`minLength="${APPROVAL_REF_MIN}"`);
    expect(input).toContain(`maxLength="${APPROVAL_REF_MAX}"`);
    expect(html).toContain(`${APPROVAL_REF_MIN} to ${APPROVAL_REF_MAX} characters`);
    for (const name of ["authorizedOn", "authorizedByRole", "scope", "amountUsd", "documentRef", "documentSha256"]) expect(html).toContain(`name="${name}"`);
    // the role select defaults to blank; both roles are offered; the reference alone is said not to be authorization; the text is never stored
    expect(html).toContain("Choose who authorized");
    expect(html).toContain('value="founder_written"');
    expect(html).toContain('value="owner_written"');
    expect(html).toContain("The reference alone is not authorization");
    expect(html).toContain("never entered here and never stored");
    expect(html).not.toMatch(/<textarea/i);
    expect(html).toContain("Record period approval");
    expect(html).toContain(`older than ${EVIDENCE_MAX_AGE_DAYS} days`);
    expect(html).not.toMatch(/auth[_ ]?token|api[_ ]?key|secret|whsec_|sk_live|sk_test/i);
    expect(html).not.toMatch(/\bcents\b/i);
  });

  it("refuses 9 and 201 characters before any client or RPC, and accepts 10, 120, 121 and 200", async () => {
    for (const n of [9, 201]) {
      const message = await run(base({ approvalRef: refOf(n) }));
      expect(message).toContain("10 to 200 characters");
    }
    expect(rpc).toHaveLength(0);
    expect(clientsBuilt).toBe(0);
    replies.tw4_rfl_admin_overview = pilotOverview;
    replies.tw4_rfl_pilot_cover = { data: { cover_id: U(7), evidence_id: U(8) } };
    for (const n of [10, 120, 121, 200]) {
      rpc.length = 0;
      expect(await run(base({ approvalRef: refOf(n) }))).toContain("does not renew");
      expect(covers()).toHaveLength(1);
      expect(covers()[0].args.p_approval_ref).toBe(refOf(n));
    }
  });

  it("counts characters (code points) like the database, not UTF-16 units", async () => {
    expect(await run(base({ approvalRef: "\u{1F600}".repeat(5) }))).toContain("10 to 200 characters");
    expect(rpc).toHaveLength(0);
  });
});

describe("U-4 evidence is validated server-side before any RPC", () => {
  const refusals: [string, Record<string, string>][] = [
    ["missing date", { authorizedOn: "" }],
    ["not a real date", { authorizedOn: "2026-02-31" }],
    ["future date", { authorizedOn: day(5) }],
    ["too old", { authorizedOn: day(-(EVIDENCE_MAX_AGE_DAYS + 5)) }],
    ["wrong role", { authorizedByRole: "policy_lapse" }],
    ["blank role", { authorizedByRole: "" }],
    ["missing scope", { scope: "" }],
    ["invalid scope", { scope: "standing_authorization" }],
    ["missing amount", { amountUsd: "" }],
    ["negative amount", { amountUsd: "-25.00" }],
    ["zero amount", { amountUsd: "0" }],
    ["amount with three decimals", { amountUsd: "25.001" }],
    ["missing document reference", { documentRef: "" }],
    ["document reference with a space", { documentRef: "AUTH DOC 0001" }],
    ["link that is not https", { documentRef: "http://example.com/doc/1" }],
    ["link with a query string (could carry a token)", { documentRef: "https://example.com/doc/1?token=abc" }],
    ["link with credentials", { documentRef: "https://user:pw@example.com/doc/1" }],
    ["short sha", { documentSha256: "abc" }],
    ["tomorrow's date (later than the UTC date)", { authorizedOn: day(1) }],
    ["link with a semicolon", { documentRef: "https://example.com/doc;1" }],
    ["link with an ampersand", { documentRef: "https://example.com/doc&1" }],
    ["link with an equals sign", { documentRef: "https://example.com/doc=1" }],
    ["link with a percent escape", { documentRef: "https://example.com/doc%201" }],
    ["link with a fragment", { documentRef: "https://example.com/doc1#frag" }],
    ["javascript-style id", { documentRef: "javascript:alert1" }],
    ["id with an equals sign", { documentRef: "AUTH=DOC-0001" }],
    ["non-hex sha", { documentSha256: "z".repeat(64) }],
    ["missing sha", { documentSha256: "" }],
  ];
  for (const [name, over] of refusals) {
    it(`refuses ${name}`, async () => {
      replies.tw4_rfl_admin_overview = pilotOverview;
      const message = await run(base(over));
      expect(message).toContain("Nothing changed");
      expect(covers()).toHaveLength(0);
      expect(clientsBuilt).toBe(0);
    });
  }

  it("accepts an opaque id, a plain https link, both roles, a 400-day-old and today's date, an upper-case sha256 (stored lower-case), and passes dollars as cents", async () => {
    replies.tw4_rfl_admin_overview = pilotOverview;
    replies.tw4_rfl_pilot_cover = { data: { cover_id: U(7) } };
    for (const over of [
      { documentRef: "https://docs.example.com/authorizations/2026-10/confidance-1" }, { authorizedByRole: "founder_written" }, { authorizedOn: day(-EVIDENCE_MAX_AGE_DAYS) },
      { authorizedOn: day(0) }, { documentSha256: "ABCDEF0123456789".repeat(4) }, { amountUsd: "25" }, { amountUsd: "25.5" },
    ] as Record<string, string>[]) {
      rpc.length = 0;
      expect(await run(base(over))).toContain("does not renew");
      const a = covers()[0].args;
      expect(a.p_amount_cents).toBe(over.amountUsd === "25.5" ? 2550 : 2500);
      expect(a.p_evidence_period_key).toBe("2026-10");
      expect(a.p_scope).toBe("pilot_period_cover");
      expect(a.p_document_sha256).toBe((over.documentSha256 ?? "b".repeat(64)).toLowerCase());
    }
  });

  it("a client-sent amount in cents is ignored: only the dollars field counts, and the database compares it with the price", async () => {
    replies.tw4_rfl_admin_overview = pilotOverview;
    replies.tw4_rfl_pilot_cover = { error: { code: "TW008" } };
    const message = await run({ ...base(), amountCents: "1" });
    expect(covers()[0].args.p_amount_cents).toBe(2500);
    expect(message).toContain("No published price");
  });

  it("maps the database's evidence refusal to a fixed sentence without echoing any text", async () => {
    replies.tw4_rfl_admin_overview = pilotOverview;
    replies.tw4_rfl_pilot_cover = { error: { code: "TW052", message: "pilot approval evidence: the authorization is older than 400 days" } };
    const message = await run(base());
    expect(message).toContain("approval evidence was refused");
    expect(message).not.toContain("400 days");
    expect(message).not.toContain("b".repeat(64));
  });
});

describe("pilot approval amount is the published price, never typed", () => {
  const NOW = Date.parse("2026-10-21T12:00:00Z");
  const html = (prices?: Record<string, number>) => renderToStaticMarkup(createElement(RecurringFeesPilot, { overview: parseOverview(pilotOverview.data), now: NOW, prices }));

  it("shows the published price read-only and submits exactly that amount, with no free entry", () => {
    const out = html({ number: 2500 });
    expect(out).toContain('data-testid="published-price"');
    expect(out).toContain("$25.00");
    expect(out).toMatch(/<input[^>]*type="hidden"[^>]*name="amountUsd"[^>]*value="25.00"|<input[^>]*name="amountUsd"[^>]*type="hidden"[^>]*value="25.00"/);
    expect(out).not.toMatch(/<input(?![^>]*type="hidden")[^>]*name="amountUsd"/);
    expect(out).not.toContain("no-published-price");
    expect(out).not.toMatch(/<button[^>]*[ ]disabled=""[^>]*>Record period approval/);
  });

  it("uses the price of this resource's own fee kind and renders non-round cents", () => {
    expect(html({ number: 105, monthly: 9900 })).toContain("$1.05");
  });

  it("fails closed without a published price: message shown, submit disabled, no amount field", () => {
    for (const prices of [undefined, {}, { monthly: 1000 }, { number: 0 }, { number: -5 }, { number: 12.5 }, { number: 10_000_000 }]) {
      const out = html(prices as Record<string, number> | undefined);
      expect(out).toContain('data-testid="no-published-price"');
      expect(out).toContain("No published price could be read for this fee");
      expect(out).not.toContain('name="amountUsd"');
      expect(out).toMatch(/<button[^>]*[ ]disabled=""[^>]*>Record period approval/);
    }
  });

  it("the other evidence fields are unchanged", () => {
    const out = html({ number: 2500 });
    for (const name of ["authorizedOn", "authorizedByRole", "scope", "documentRef", "documentSha256", "approvalRef", "periodKey", "ack"]) expect(out).toContain(`name="${name}"`);
  });

  it("a tampered amount is still refused server-side (shape check, then the database's equality rule)", async () => {
    for (const amountUsd of ["", "0", "-25.00", "25.001", "abc", "1e3"]) {
      rpc.length = 0;
      expect(await run(base({ amountUsd }))).toContain("Nothing changed");
      expect(rpc.filter((c) => c.fn === "tw4_rfl_pilot_cover")).toHaveLength(0);
    }
    // a well-formed but different amount passes the shape check and reaches the database, whose TW008 equality rule refuses it
    replies.tw4_rfl_admin_overview = pilotOverview;
    replies.tw4_rfl_pilot_cover = { error: { code: "TW008", message: "must equal the published price" } };
    rpc.length = 0;
    expect(await run(base({ amountUsd: "1.00" }))).toContain("does not equal it");
    expect(rpc.find((c) => c.fn === "tw4_rfl_pilot_cover")?.args.p_amount_cents).toBe(100);
  });
});
