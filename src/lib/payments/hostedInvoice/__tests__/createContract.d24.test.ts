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

  it("no application code references the orchestrator, its flag or the intent functions", () => {
    const hits = src.filter((f) =>
      /hostedInvoice\/create|createHostedInvoice|resumeIntent|sweepRecoverableIntents|D24_HOSTED_INVOICE_CREATION|d24_intent_/.test(readFileSync(f, "utf8")),
    );
    expect(hits.map(norm)).toEqual([]);
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
});
