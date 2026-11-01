
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- mocks (the DB rules themselves are proven against real Postgres by scripts/qa/d24-m3c-sql.sh; here we prove the application seams) ----
const ctx = vi.hoisted(() => ({
  studio: { studioId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", studioRole: "studio_owner", isPlatformAdmin: false, email: null as string | null },
  rpc: vi.fn(),
}));
vi.mock("@/lib/auth/studio", () => ({ getCurrentStudioContext: vi.fn(async () => ctx.studio) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({ rpc: ctx.rpc })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`REDIRECT:${to}`);
  }),
}));

import { authorizeClientInvoiceActor } from "../authorize";
import { getClientInvoiceCreationPort } from "../creationPort";
import { CLIENT_INVOICE_BUSINESS_OBJECT_TYPE, clientInvoiceErrorMessage, formatCents, isClientInvoiceCreationEnabled, parseDollarsToCents, parseDraftForm } from "../model";
import { resolveClientInvoiceSpec } from "../resolver";
import { requestClientInvoiceProviderDraftAction, saveClientInvoiceDraftAction } from "@/app/app/payments/invoices/actions";

const UUID_A = "33333333-3333-4333-8333-333333333333";
const UUID_B = "44444444-4444-4444-8444-444444444444";
const FOREIGN_STUDIO = "99999999-9999-4999-8999-999999999999";

function form(entries: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}
const goodForm = (extra: Record<string, string> = {}) =>
  form({ requestKey: UUID_A, clientId: UUID_B, line_description_0: "Private lesson", line_quantity_0: "2", line_price_0: "75.00", ...extra });

beforeEach(() => {
  ctx.rpc.mockReset();
  ctx.studio = { studioId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", studioRole: "studio_owner", isPlatformAdmin: false, email: null };
  delete process.env.D24_HOSTED_INVOICE_CREATION;
});

describe("money parsing", () => {
  it("parses dollars to integer cents without floating point", () => {
    expect(parseDollarsToCents("75")).toBe(7500);
    expect(parseDollarsToCents("75.5")).toBe(7550);
    expect(parseDollarsToCents("$1,200.05")).toBe(120005);
    expect(parseDollarsToCents("0.07")).toBe(7);
    expect(parseDollarsToCents("19.99")).toBe(1999);
  });
  it("refuses negatives, 3 decimals, exponents, empties and absurd sizes", () => {
    for (const bad of ["-1", "1.234", "1e3", "", "abc", "12345678", "1.", ".5", "NaN", "Infinity"]) expect(parseDollarsToCents(bad), bad).toBeNull();
  });
  it("formats cents", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(7)).toBe("$0.07");
    expect(formatCents(123456789)).toBe("$1,234,567.89");
  });
});

describe("form parsing", () => {
  it("accepts a plain draft and ignores forged studio/total/stripe fields entirely", () => {
    const r = parseDraftForm(goodForm({ studioId: FOREIGN_STUDIO, total_cents: "1", stripe_invoice_id: "in_x", stripe_account_id: "acct_x", status: "provider_draft_created", hosted_invoice_url: "https://evil.example" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.lines).toEqual([{ description: "Private lesson", quantity: 2, unit_price_cents: 7500 }]);
      expect(JSON.stringify(r.value)).not.toMatch(/FOREIGN|evil|in_x|acct_x|provider_draft_created/);
      expect(Object.keys(r.value).sort()).toEqual(["clientId", "expectedVersion", "invoiceId", "lines", "referenceId", "referenceNote", "referenceType", "requestKey"]);
    }
  });
  it.each([
    ["no lines", { line_description_0: "", line_quantity_0: "", line_price_0: "" }],
    ["zero quantity", { line_quantity_0: "0" }],
    ["fractional quantity", { line_quantity_0: "1.5" }],
    ["negative quantity", { line_quantity_0: "-2" }],
    ["bad price", { line_price_0: "abc" }],
    ["zero price", { line_price_0: "0" }],
    ["missing description", { line_description_0: " " }],
    ["description too long", { line_description_0: "x".repeat(201) }],
    ["bad client id", { clientId: "not-a-uuid" }],
    ["bad request key", { requestKey: "nope" }],
    ["unknown reference type", { referenceType: "subscription", referenceId: UUID_A }],
    ["typed reference without id", { referenceType: "event", referenceId: "zzz" }],
    ["other reference without note", { referenceType: "other", referenceNote: "  " }],
    ["edit without a version", { invoiceId: UUID_A }],
  ])("rejects %s", (_name, extra) => {
    expect(parseDraftForm(goodForm(extra as Record<string, string>)).ok).toBe(false);
  });
  it("bounds the number of lines at 25", () => {
    const entries: Record<string, string> = { requestKey: UUID_A, clientId: UUID_B };
    for (let i = 0; i < 26; i += 1) Object.assign(entries, { [`line_description_${i}`]: `l${i}`, [`line_quantity_${i}`]: "1", [`line_price_${i}`]: "5.00" });
    expect(parseDraftForm(form(entries)).ok).toBe(false);
    delete entries.line_description_25;
    delete entries.line_quantity_25;
    delete entries.line_price_25;
    expect(parseDraftForm(form(entries)).ok).toBe(true);
  });
  it("strips control characters from descriptions", () => {
    const r = parseDraftForm(goodForm({ line_description_0: "Les\u0007son​" }));
    expect(r.ok && r.value.lines[0].description).toBe("Lesson");
  });
});

describe("model facts", () => {
  it("the business object type never contains 'subscription'", () => {
    expect(CLIENT_INVOICE_BUSINESS_OBJECT_TYPE).toBe("studio_client_invoice");
    expect(CLIENT_INVOICE_BUSINESS_OBJECT_TYPE).not.toMatch(/subscription/i);
  });
  it("creation flag: only the exact string 'on'", () => {
    for (const v of [undefined, "", "true", "1", " on", "ON", "On", "yes"]) expect(isClientInvoiceCreationEnabled({ D24_HOSTED_INVOICE_CREATION: v }), String(v)).toBe(false);
    expect(isClientInvoiceCreationEnabled({ D24_HOSTED_INVOICE_CREATION: "on" })).toBe(true);
  });
  it("database refusal codes map to fixed messages and unknown text is never echoed", () => {
    expect(clientInvoiceErrorMessage("client_invoice_forbidden")).toMatch(/owner or an admin/);
    expect(clientInvoiceErrorMessage("boom: select * from secrets", null)).toBe("The draft could not be saved. Nothing was changed.");
    expect(clientInvoiceErrorMessage("x", "40001")).toMatch(/Someone else changed/);
  });
});

describe("authorizeClientInvoiceActor", () => {
  it("returns a verified actor only when the database helper says true, using the SESSION studio and user", async () => {
    ctx.rpc.mockResolvedValue({ data: true, error: null });
    const a = await authorizeClientInvoiceActor("draft");
    expect(a).toEqual({ verified: true, studioId: ctx.studio.studioId, userId: ctx.studio.userId, canManageBilling: true });
    expect(ctx.rpc).toHaveBeenCalledWith("studio_billing_permission", { p_studio_id: ctx.studio.studioId, p_permission: "client_invoice.draft" });
  });
  it.each([[{ data: false, error: null }], [{ data: null, error: { message: "x" } }], [{ data: "true", error: null }], [{ data: 1, error: null }]])("refuses %j", async (res) => {
    ctx.rpc.mockResolvedValue(res);
    expect(await authorizeClientInvoiceActor("view")).toBeNull();
  });
  it("a platform admin is asked to the database like anyone else (no implicit grant)", async () => {
    ctx.studio = { ...ctx.studio, studioRole: "platform_admin", isPlatformAdmin: true };
    ctx.rpc.mockResolvedValue({ data: false, error: null });
    expect(await authorizeClientInvoiceActor("draft")).toBeNull();
    expect(ctx.rpc).toHaveBeenCalledTimes(1);
  });
});

describe("saveClientInvoiceDraftAction", () => {
  it("refuses before any write when not authorized", async () => {
    ctx.rpc.mockResolvedValue({ data: false, error: null });
    const r = await saveClientInvoiceDraftAction({ error: "" }, goodForm());
    expect(r.error).toMatch(/owner or an admin/);
    expect(ctx.rpc).toHaveBeenCalledTimes(1);
    expect(ctx.rpc.mock.calls[0][0]).toBe("studio_billing_permission");
  });
  it("sends the SESSION studio (never a form value) and the parsed lines to the database function", async () => {
    ctx.rpc.mockImplementation(async (fn: string) => (fn === "studio_billing_permission" ? { data: true, error: null } : { data: { invoice_id: UUID_A }, error: null }));
    await expect(saveClientInvoiceDraftAction({ error: "" }, goodForm({ studioId: FOREIGN_STUDIO, p_studio_id: FOREIGN_STUDIO, total_cents: "1" }))).rejects.toThrow(`REDIRECT:/app/payments/invoices/${UUID_A}?saved=1`);
    const call = ctx.rpc.mock.calls.find((c) => c[0] === "studio_client_invoice_save_draft")!;
    expect(call[1].p_studio_id).toBe(ctx.studio.studioId);
    expect(call[1].p_lines).toEqual([{ description: "Private lesson", quantity: 2, unit_price_cents: 7500 }]);
    expect(JSON.stringify(call[1])).not.toContain(FOREIGN_STUDIO);
    expect(Object.keys(call[1]).some((k) => /total|actor|user|status|stripe/.test(k))).toBe(false);
  });
  it("returns a fixed message for a database refusal (no raw database text)", async () => {
    ctx.rpc.mockImplementation(async (fn: string) =>
      fn === "studio_billing_permission" ? { data: true, error: null } : { data: null, error: { message: "client_invoice_client_not_in_studio: secret detail", code: "42501" } },
    );
    const r = await saveClientInvoiceDraftAction({ error: "" }, goodForm());
    expect(r.error).toBe("Choose one of your studio's clients.");
    expect(r.error).not.toMatch(/secret/);
  });
  it("a malformed form never reaches the database function", async () => {
    ctx.rpc.mockResolvedValue({ data: true, error: null });
    const r = await saveClientInvoiceDraftAction({ error: "" }, goodForm({ line_quantity_0: "0" }));
    expect(r.error).toMatch(/quantity/);
    expect(ctx.rpc.mock.calls.every((c) => c[0] === "studio_billing_permission")).toBe(true);
  });
  it("an edit passes the expected version for optimistic concurrency", async () => {
    ctx.rpc.mockImplementation(async (fn: string) => (fn === "studio_billing_permission" ? { data: true, error: null } : { data: { invoice_id: UUID_A }, error: null }));
    await expect(saveClientInvoiceDraftAction({ error: "" }, goodForm({ invoiceId: UUID_A, expectedVersion: "3" }))).rejects.toThrow("REDIRECT");
    const call = ctx.rpc.mock.calls.find((c) => c[0] === "studio_client_invoice_save_draft")!;
    expect(call[1].p_invoice_id).toBe(UUID_A);
    expect(call[1].p_expected_version).toBe(3);
  });
});

describe("provider draft request is gated and unwired", () => {
  it("flag off (default): refuses with NO authorization and NO database call", async () => {
    const r = await requestClientInvoiceProviderDraftAction({ error: "" }, form({ invoiceId: UUID_A, requestKey: UUID_B }));
    expect(r.error).toMatch(/not available yet/);
    expect(ctx.rpc).not.toHaveBeenCalled();
  });
  it.each(["true", "1", " on", "ON"])("flag %j is still off", async (v) => {
    process.env.D24_HOSTED_INVOICE_CREATION = v;
    const r = await requestClientInvoiceProviderDraftAction({ error: "" }, form({ invoiceId: UUID_A, requestKey: UUID_B }));
    expect(r.error).toMatch(/not available yet/);
    expect(ctx.rpc).not.toHaveBeenCalled();
  });
  it("flag on but no creation port wired: still unavailable, nothing is created or called", async () => {
    process.env.D24_HOSTED_INVOICE_CREATION = "on";
    ctx.rpc.mockResolvedValue({ data: true, error: null });
    const r = await requestClientInvoiceProviderDraftAction({ error: "" }, form({ invoiceId: UUID_A, requestKey: UUID_B }));
    expect(r.error).toMatch(/not available yet/);
    expect(getClientInvoiceCreationPort()).toBeNull();
    expect(ctx.rpc.mock.calls.every((c) => c[0] === "studio_billing_permission")).toBe(true);
  });
  it("flag on, unauthorized actor: refused", async () => {
    process.env.D24_HOSTED_INVOICE_CREATION = "on";
    ctx.rpc.mockResolvedValue({ data: false, error: null });
    const r = await requestClientInvoiceProviderDraftAction({ error: "" }, form({ invoiceId: UUID_A, requestKey: UUID_B }));
    expect(r.error).toMatch(/owner or an admin/);
  });
});

describe("creation spec resolver (trusted records only)", () => {
  const rawSpec = {
    invoice_id: UUID_A,
    client_id: UUID_B,
    currency: "usd",
    total_cents: 15000 + 1999,
    lines: [
      { description: "Private lesson", quantity: 2, unit_price_cents: 7500, line_total_cents: 15000 },
      { description: "Registration", quantity: 1, unit_price_cents: 1999, line_total_cents: 1999 },
    ],
  };
  const sb = (spec: unknown, client: unknown, rpcError: { message: string } | null = null) => ({
    rpc: vi.fn(async () => ({ data: spec, error: rpcError })),
    from: vi.fn(() => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: client, error: null }) }) }) }) })),
  });
  const client = { id: UUID_B, first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" };

  it("maps a trusted spec; quantity is folded into the line description and amounts are the database's", async () => {
    const supabase = sb(rawSpec, client);
    const spec = await resolveClientInvoiceSpec({ supabase, studioId: ctx.studio.studioId, businessObjectId: UUID_A });
    expect(spec).toEqual({
      customerProfile: { clientRef: UUID_B, name: "Ada Lovelace", email: "ada@example.com" },
      currency: "usd",
      daysUntilDue: 30,
      lines: [
        { description: "Private lesson (2 x $75.00)", amountCents: 15000 },
        { description: "Registration", amountCents: 1999 },
      ],
    });
    expect(supabase.rpc).toHaveBeenCalledWith("studio_client_invoice_creation_spec", { p_invoice_id: UUID_A, p_studio_id: ctx.studio.studioId });
  });
  it("null when the database says not creatable / not this studio's", async () => {
    expect(await resolveClientInvoiceSpec({ supabase: sb(null, client), studioId: ctx.studio.studioId, businessObjectId: UUID_A })).toBeNull();
    expect(await resolveClientInvoiceSpec({ supabase: sb(rawSpec, client, { message: "x" }), studioId: ctx.studio.studioId, businessObjectId: UUID_A })).toBeNull();
  });
  it("null when the spec is for a different object than asked (response swap)", async () => {
    expect(await resolveClientInvoiceSpec({ supabase: sb({ ...rawSpec, invoice_id: UUID_B }, client), studioId: ctx.studio.studioId, businessObjectId: UUID_A })).toBeNull();
  });
  it("null when the client is not found in the studio, or has no name", async () => {
    expect(await resolveClientInvoiceSpec({ supabase: sb(rawSpec, null), studioId: ctx.studio.studioId, businessObjectId: UUID_A })).toBeNull();
    expect(await resolveClientInvoiceSpec({ supabase: sb(rawSpec, { ...client, first_name: null, last_name: " " }), studioId: ctx.studio.studioId, businessObjectId: UUID_A })).toBeNull();
  });
  it("null when the lines do not add up to the stored total", async () => {
    expect(await resolveClientInvoiceSpec({ supabase: sb({ ...rawSpec, total_cents: 1 }, client), studioId: ctx.studio.studioId, businessObjectId: UUID_A })).toBeNull();
  });
});

describe("contract: no finalize / send / pay / Stripe surface in this package", () => {
  const files = [
    "src/app/app/payments/invoices/actions.ts",
    "src/app/app/payments/invoices/InvoiceEditor.tsx",
    "src/app/app/payments/invoices/page.tsx",
    "src/app/app/payments/invoices/new/page.tsx",
    "src/app/app/payments/invoices/[id]/page.tsx",
    "src/app/app/payments/invoices/[id]/ProviderDraftControl.tsx",
    "src/lib/billing/clientInvoices/model.ts",
    "src/lib/billing/clientInvoices/authorize.ts",
    "src/lib/billing/clientInvoices/resolver.ts",
    "src/lib/billing/clientInvoices/creationPort.ts",
  ];
  const code = (f: string) =>
    readFileSync(f, "utf8")
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
  it("imports no Stripe SDK and constructs no Stripe client", () => {
    for (const f of files) expect(code(f), f).not.toMatch(/from "stripe"|new Stripe\(|getStripe|stripe\.(invoices|customers)/);
  });
  it("has no finalize/send/pay/void actions or payment URL handling", () => {
    for (const f of files) expect(code(f), f).not.toMatch(/finalizeInvoice|\.finalize\(|sendInvoice|send_invoice|payInvoice|voidInvoice|markUncollectible|hosted_invoice_url|invoice_pdf|collection_method/i);
  });
  it("no button in the UI offers send/finalize/pay", () => {
    for (const f of files.filter((x) => x.endsWith(".tsx"))) expect(code(f), f).not.toMatch(/>\s*(Send|Finalize|Pay|Charge|Collect|Void)\b[^<]*</);
  });
  it("the draft detail page shows no payment URL and the status copy denies one", () => {
    expect(readFileSync("src/lib/billing/clientInvoices/model.ts", "utf8")).toMatch(/there is no payment link/);
  });
  it("the provider-draft control is reached only through the gated action", () => {
    expect(code("src/app/app/payments/invoices/actions.ts")).toMatch(/isClientInvoiceCreationEnabled\(\)/);
    expect(getClientInvoiceCreationPort()).toBeNull();
  });
  it("nothing outside this package references the resolver map or the client-invoice SQL functions", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) return e.name === "__tests__" || e.name === "migrations" || e.name === "node_modules" ? [] : walk(p);
        return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
      });
    const out = walk("src")
      .filter((p) => /CLIENT_INVOICE_SPEC_RESOLVERS|studio_client_invoice_link_registration|studio_client_invoice_creation_spec/.test(readFileSync(p, "utf8")))
      .sort();
    expect(out).toEqual(["src/lib/billing/clientInvoices/creationPort.ts", "src/lib/billing/clientInvoices/resolver.ts"]);
  }, 60_000);
});
