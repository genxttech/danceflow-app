import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCTION_BUSINESS_OBJECT_RESOLVERS } from "../register";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("D24 M2-A registration contract", { timeout: 300_000 }, () => {
  it("is referenced by no application code and has no production resolvers (nothing creates hosted invoices yet)", () => {
    const hits = walk(join(process.cwd(), "src")).filter((f) => {
      const norm = f.replace(/\\/g, "/");
      if (norm.includes("/__tests__/") || norm.endsWith("/hostedInvoice/register.ts")) return false;
      const text = readFileSync(f, "utf8");
      return /registerHostedInvoice|d24_register_invoice/.test(text);
    });
    expect(hits).toEqual([]);
    expect(Object.keys(PRODUCTION_BUSINESS_OBJECT_RESOLVERS)).toEqual([]);
  });
});
