import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
const norm = (f: string) => f.replace(/\\/g, "/");

describe("D24 M3-B creation contract", { timeout: 300_000 }, () => {
  const src = walk(join(process.cwd(), "src")).filter((f) => !norm(f).includes("/__tests__/") && !norm(f).endsWith("/hostedInvoice/create.ts"));

  // M3-C: the ONLY legitimate call-site seam (the staff client-invoice UI). Everything else stays banned. The seam may mention the flag / intent names but
  // must never import or call the orchestrator or Stripe, only refuses while the flag is not exactly "on", and has no creation port (returns null).
  const SEAM_ALLOW_LIST = [
    "src/app/app/payments/invoices/[id]/ProviderDraftControl.tsx",
    "src/app/app/payments/invoices/actions.ts",
    "src/lib/billing/clientInvoices/creationPort.ts",
    "src/lib/billing/clientInvoices/model.ts",
  ];
  const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const rel = (f: string) => norm(f).slice(norm(process.cwd()).length + 1);
  const referencesCreation = (text: string) =>
    /hostedInvoice\/create|createHostedInvoice|resumeIntent|sweepRecoverableIntents|D24_HOSTED_INVOICE_CREATION|d24_intent_/.test(text);

  it("no application code references the orchestrator, its flag or the intent functions, except the explicit M3-C seam allow-list", () => {
    const hits = src.filter((f) => referencesCreation(readFileSync(f, "utf8"))).map(rel).sort();
    expect(hits).toEqual([...SEAM_ALLOW_LIST].sort());
  });

  it("M3-C seam files never import or call the orchestrator, and never import Stripe", () => {
    for (const f of SEAM_ALLOW_LIST) {
      const code = stripComments(readFileSync(join(process.cwd(), f), "utf8"));
      expect(code, f).not.toMatch(/hostedInvoice\/create|createHostedInvoice|resumeIntent|sweepRecoverableIntents|d24_intent_/);
      expect(code, f).not.toMatch(/from\s+["']stripe["']|require\(["']stripe|new\s+Stripe|getStripe|payments\/stripe|STRIPE_SECRET_KEY|process\.env\.STRIPE/);
      expect(code, f).not.toMatch(/finalizeInvoice|sendInvoice|\.pay\(|voidInvoice|markUncollectible/);
    }
  });

  it("M3-C seam: the flag is read only as an exact 'on' check, actions refuse first when it is not on, and no creation port is wired", () => {
    const read = (f: string) => stripComments(readFileSync(join(process.cwd(), f), "utf8"));
    // only model.ts spells the flag name in code, and only as the exact-"on" comparison
    const model = read("src/lib/billing/clientInvoices/model.ts");
    expect(model).toMatch(/env\[CLIENT_INVOICE_CREATION_FLAG\]\s*===\s*"on"/);
    expect(model.match(/D24_HOSTED_INVOICE_CREATION/g)?.length).toBe(1);
    for (const f of SEAM_ALLOW_LIST.filter((x) => !x.endsWith("/model.ts"))) expect(read(f), f).not.toMatch(/D24_HOSTED_INVOICE_CREATION/);
    // the provider-draft action refuses on the flag before authorization or any database call
    const actions = read("src/app/app/payments/invoices/actions.ts");
    const fn = actions.slice(actions.indexOf("export async function requestClientInvoiceProviderDraftAction"));
    expect(fn.indexOf("if (!isClientInvoiceCreationEnabled())")).toBeGreaterThan(-1);
    expect(fn.indexOf("if (!isClientInvoiceCreationEnabled())")).toBeLessThan(fn.indexOf("authorizeClientInvoiceActor"));
    // no port: the getter returns null and nothing else is exported that could construct one
    const port = read("src/lib/billing/clientInvoices/creationPort.ts");
    expect(port).toMatch(/export function getClientInvoiceCreationPort\(\)[^{]*\{\s*return null;\s*\}/);
    expect(port).not.toMatch(/\bimport\b[^;]*from\s+["'](?!\.\/authorize)/);
  });

  it("only the M3-C seam (not any other file) can reach the intent functions: the global ban holds for every non-allow-listed file", () => {
    const outside = src.filter((f) => !SEAM_ALLOW_LIST.includes(rel(f)) && referencesCreation(stripComments(readFileSync(f, "utf8"))));
    expect(outside.map(rel)).toEqual([]);
  });

  it("vercel config does not schedule it", () => {
    const f = join(process.cwd(), "vercel.json");
    if (existsSync(f)) expect(readFileSync(f, "utf8")).not.toMatch(/hostedInvoice|d24/i);
  });

  it("create.ts constructs no Stripe client and has no finalize / send / pay capability", () => {
    const text = readFileSync(join(process.cwd(), "src/lib/payments/hostedInvoice/create.ts"), "utf8");
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/from\s+["']stripe["']|require\(["']stripe|new\s+Stripe|getStripe|payments\/stripe["']|STRIPE_SECRET_KEY|process\.env\.STRIPE/);
    expect(code).not.toMatch(/finalizeInvoice|sendInvoice|\.pay\(|voidInvoice|markUncollectible|auto_advance:\s*true|payment_intent|charge_automatically/);
  });

  it("the injected Stripe interface has exactly ensureCustomer / createDraftInvoice / addInvoiceLines (no finalize, send, pay, void)", () => {
    const text = readFileSync(join(process.cwd(), "src/lib/payments/hostedInvoice/create.ts"), "utf8");
    const start = text.indexOf("export interface HostedInvoiceStripeClient");
    const body = text.slice(start, text.indexOf("\n}\n", start));
    const methods = [...body.matchAll(/^ {2}([A-Za-z]+)\(/gm)].map((m) => m[1]).sort();
    expect(methods).toEqual(["addInvoiceLines", "createDraftInvoice", "ensureCustomer"]);
  });
});
