import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../../..");
const D = "docs/events/event-registration-claim-release";
const bundlePath = path.join(root, D, "gate1_bundle_claim_function.sql");
const builder = path.join(root, D, "build-gate1-bundle.mjs");
const code = (s: string) => s.replace(/--[^\n]*/g, "").toLowerCase();

describe("Gate 1 bundle (function + exclusion + execute withheld in ONE transaction)", () => {
  const bundle = readFileSync(bundlePath, "utf8");

  it("is exactly what the committed deterministic builder produces from the three reviewed files (--check)", () => {
    const out = execFileSync(process.execPath, [builder, "--check"], { encoding: "utf8" });
    expect(out).toMatch(/up to date/);
    expect(execFileSync(process.execPath, [builder, "--print-sha"], { encoding: "utf8" }).trim()).toBe(
      createHash("sha256").update(readFileSync(bundlePath)).digest("hex"),
    );
  });

  it("has exactly one transaction: a single begin; first and a single commit; last, none inside", () => {
    const lines = bundle.split("\n").filter((l) => /^(begin|commit);\s*$/i.test(l));
    expect(lines).toEqual(["begin;", "commit;"]);
    const c = code(bundle).trim();
    expect(c.startsWith("begin;")).toBe(true);
    expect(c.endsWith("commit;")).toBe(true);
    expect(c).not.toMatch(/concurrently|\bset session\b|\\\\/);
  });

  it("applies the three files in order and ends with the execute revoke (nothing granted after it)", () => {
    const order = [
      "20270221090000_event_registration_claim_function.sql",
      "20270222090000_event_registration_claim_buyer_sources_only.sql",
      "20270222090500_claim_function_execute_withheld.sql",
    ].map((f) => bundle.indexOf(`-- ===== ${f}`));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const c = code(bundle);
    const lastRevoke = c.lastIndexOf("revoke all on function public.claim_my_event_registrations() from public, anon, authenticated, service_role");
    const lastGrant = c.lastIndexOf("grant execute on function public.claim_my_event_registrations()");
    expect(lastRevoke).toBeGreaterThan(lastGrant);
    expect(c.slice(lastRevoke)).not.toMatch(/\bgrant\b/);
  });
});
