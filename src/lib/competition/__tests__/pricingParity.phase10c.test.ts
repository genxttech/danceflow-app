import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  calculateCompetitionRegistrationQuote,
  percentageOfCents,
  toCents,
  type CompetitionRegistrationCatalog,
  type CompetitionRegistrationDraft,
} from "@/lib/competition/registrationPricing";
import { generateParitySql, materialize, SCENARIOS } from "./fixtures/pricingParity.mjs";

const ROOT = join(__dirname, "..", "..", "..", "..");

type Scenario = { name: string; now: string; expected: { valid: boolean; subtotalCents?: number; discountCents?: number; totalCents?: number; lines?: string[] } };

describe("Phase 10C pricing parity: TypeScript display quote == hand-computed expectations == SQL suite", () => {
  (SCENARIOS as Scenario[]).forEach((scenario, index) => {
    it(`${index}: ${scenario.name}`, () => {
      const { catalog, draft } = materialize(index) as { catalog: CompetitionRegistrationCatalog; draft: CompetitionRegistrationDraft };
      const quote = calculateCompetitionRegistrationQuote(catalog, draft, new Date(scenario.now));
      expect(quote.valid, quote.errors.join("; ")).toBe(scenario.expected.valid);
      if (!scenario.expected.valid) return;
      expect(quote.subtotalCents).toBe(scenario.expected.subtotalCents);
      expect(quote.discountCents).toBe(scenario.expected.discountCents);
      expect(quote.totalCents).toBe(scenario.expected.totalCents);
      expect(quote.lines.map((line) => `${line.lineType}:${line.unitCents}:${line.quantity}:${line.lineCents}`)).toEqual(scenario.expected.lines);
    });
  });

  it("the committed SQL parity suite is exactly what the shared fixtures generate", () => {
    const committed = readFileSync(join(ROOT, "src/lib/supabase/migrations/sql-tests/test_T_phase10c_pricing_parity.sql"), "utf8").replace(/\r/g, "");
    expect(committed).toBe(generateParitySql());
  });

  it("duplicate entry ids are refused (they key per-entry lines and order items), like the database", () => {
    const { catalog, draft } = materialize(1) as { catalog: CompetitionRegistrationCatalog; draft: CompetitionRegistrationDraft };
    const duplicated = { ...draft, entries: draft.entries.map((entry) => ({ ...entry, clientId: "same" })) };
    const quote = calculateCompetitionRegistrationQuote(catalog, duplicated, new Date("2026-06-01T00:00:00Z"));
    expect(quote.valid).toBe(false);
    expect(quote.errors).toContain("Each entry needs a unique id.");
  });

  it("integer-cent helpers round half-up exactly like the database", () => {
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(0.29)).toBe(29);
    expect(toCents(-5)).toBe(0);
    expect(percentageOfCents(11999, 3.3333)).toBe(400);
    expect(percentageOfCents(12499, 3.3333)).toBe(417);
    expect(percentageOfCents(1, 50)).toBe(1); // 0.5 cent rounds up
    expect(percentageOfCents(3, 50)).toBe(2); // 1.5 cents rounds up
    expect(percentageOfCents(1000, -10)).toBe(0);
  });
});
