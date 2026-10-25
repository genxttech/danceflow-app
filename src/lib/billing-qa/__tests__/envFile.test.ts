import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { qaEnvironment } from "@/lib/billing-qa/envFile";

describe("BILLING-QA env file precedence", () => {
  it("values in --env-file win over the shell; the shell fills in the rest; process.env is untouched", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "bqa-env-")), "qa.env");
    writeFileSync(file, "STRIPE_PRICE_STUDIO_PRO_FOUNDER=price_fromFile\nFOUNDER_PRICING_ACTIVE=true\n");
    const shell = { STRIPE_PRICE_STUDIO_PRO_FOUNDER: "price_staleShell", OTHER: "kept" };
    expect(qaEnvironment(file, shell)).toMatchObject({ STRIPE_PRICE_STUDIO_PRO_FOUNDER: "price_fromFile", FOUNDER_PRICING_ACTIVE: "true", OTHER: "kept" });
    expect(shell.STRIPE_PRICE_STUDIO_PRO_FOUNDER).toBe("price_staleShell");
  });

  it("without a file, the shell environment is used as is", () => {
    const shell = { A: "1" };
    expect(qaEnvironment(null, shell)).toBe(shell);
  });
});
