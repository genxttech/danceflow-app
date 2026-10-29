import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  evaluateProtection,
  legacyProtectedPriceIds,
  loadProtectedRegistry,
} from "../protectedSubscriptions";

describe("evaluateProtection", () => {
  const none = { status: "ok", activeRows: 0, customerIds: [] } as const;

  it("is protected by a registry row alone", () => {
    expect(evaluateProtection({ registry: { status: "ok", activeRows: 1, customerIds: [] }, subscriptions: [], legacyPriceIds: [] })).toEqual({
      protected: true,
      reasons: ["registry"],
    });
  });

  it("is protected by a legacy price on any subscription status, including canceled", () => {
    for (const status of ["active", "canceled", "paused", "incomplete_expired"]) {
      const result = evaluateProtection({
        registry: none,
        subscriptions: [{ status, priceIds: ["price_a", "price_legacy"] }],
        legacyPriceIds: ["price_legacy"],
      });
      expect(result).toEqual({ protected: true, reasons: ["legacy_price"] });
    }
  });

  it("reports both reasons and is unprotected with neither", () => {
    expect(
      evaluateProtection({
        registry: { status: "ok", activeRows: 2, customerIds: [] },
        subscriptions: [{ status: "active", priceIds: ["price_legacy"] }],
        legacyPriceIds: ["price_legacy"],
      }).reasons,
    ).toEqual(["registry", "legacy_price"]);
    expect(
      evaluateProtection({ registry: none, subscriptions: [{ status: "active", priceIds: ["price_x"] }], legacyPriceIds: ["price_legacy"] }).protected,
    ).toBe(false);
  });

  it("ignores the legacy list when it is empty and a missing registry table", () => {
    expect(
      evaluateProtection({ registry: { status: "table_missing" }, subscriptions: [{ status: "active", priceIds: ["price_legacy"] }], legacyPriceIds: [] }).protected,
    ).toBe(false);
  });
});

describe("legacyProtectedPriceIds", () => {
  it("drops a legacy id that equals a current Founder or standard Price (it would block every normal customer)", () => {
    expect(
      legacyProtectedPriceIds({
        STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY: "price_legacy,price_founder_pro",
        STRIPE_PRICE_STUDIO_PRO_FOUNDER: "price_founder_pro",
        STRIPE_PRICE_STUDIO_GROWTH_STANDARD: "price_std",
      }),
    ).toEqual(["price_legacy"]);
    expect(legacyProtectedPriceIds({ STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY: "price_std", STRIPE_PRICE_STUDIO_GROWTH_STANDARD: "price_std" })).toEqual([]);
  });

  it("reads a comma-separated env value and is empty when unset", () => {
    expect(legacyProtectedPriceIds({ STRIPE_PRICE_STUDIO_PRO_FOUNDER_LEGACY: " price_a, price_b ,," })).toEqual(["price_a", "price_b"]);
    expect(legacyProtectedPriceIds({})).toEqual([]);
  });
});

describe("loadProtectedRegistry", () => {
  const calls: unknown[][] = [];
  const client = (result: { data: unknown; error: { code?: string } | null }) =>
    ({
      from: (table: string) => ({
        select: (columns: string) => ({
          eq: async (column: string, value: string) => {
            calls.push([table, columns, column, value]);
            return result;
          },
        }),
      }),
    }) as unknown as Parameters<typeof loadProtectedRegistry>[0];

  it("counts only unreleased rows, returns their customer ids, and filters by the studio", async () => {
    calls.length = 0;
    const result = await loadProtectedRegistry(
      client({
        data: [
          { released_at: null, stripe_customer_id: "cus_old" },
          { released_at: "2026-10-01T00:00:00Z", stripe_customer_id: "cus_released" },
        ],
        error: null,
      }),
      "studio-1",
    );
    expect(result).toEqual({ status: "ok", activeRows: 1, customerIds: ["cus_old"] });
    expect(calls).toEqual([["protected_subscriptions", "released_at, stripe_customer_id", "studio_id", "studio-1"]]);
  });

  it("distinguishes a missing table from an unknown error, and treats malformed data as an error", async () => {
    expect(await loadProtectedRegistry(client({ data: null, error: { code: "42P01" } }), "s")).toEqual({ status: "table_missing" });
    expect(await loadProtectedRegistry(client({ data: null, error: { code: "PGRST205" } }), "s")).toEqual({ status: "table_missing" });
    expect(await loadProtectedRegistry(client({ data: null, error: { code: "57014" } }), "s")).toEqual({ status: "error" });
    expect(await loadProtectedRegistry(client({ data: null, error: null }), "s")).toEqual({ status: "error" });
  });
});

describe("migration 20270201090000 (text checks only; not executed against a database)", () => {
  const sql = readFileSync("src/lib/supabase/migrations/20270201090000_billing_protected_subscriptions.sql", "utf8");
  const rollback = readFileSync("src/lib/supabase/migrations/rollback/20270201090000_billing_protected_subscriptions_rollback.sql", "utf8");

  it("creates the table service-role only, with RLS and no tenant grants or policies", () => {
    expect(sql).toMatch(/enable row level security/i);
    expect(sql).toMatch(/revoke all on public\.protected_subscriptions from public, anon, authenticated/i);
    expect(sql).toMatch(/grant select, insert, update on public\.protected_subscriptions to service_role/i);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/grant [^;]*\b(anon|authenticated)\b/i);
  });

  it("inserts no row, forbids deletes and is not applied by authoring", () => {
    expect(sql).not.toMatch(/insert into/i);
    expect(sql).toMatch(/tg_op = 'DELETE'/);
    expect(sql).toMatch(/NOT APPLIED/);
  });

  it("revokes service_role before the narrow grant and blocks TRUNCATE, DELETE and empty release reasons", () => {
    expect(sql).toMatch(/from public, anon, authenticated, service_role/i);
    expect(sql).toMatch(/before truncate on public\.protected_subscriptions/i);
    expect(sql).toContain("length(btrim(released_reason)) > 0");
  });

  it("also freezes customer, price and created_by, and rejects a release dated before creation", () => {
    expect(sql).toContain("new.stripe_customer_id is distinct from old.stripe_customer_id");
    expect(sql).toContain("new.stripe_price_id is distinct from old.stripe_price_id");
    expect(sql).toContain("released_at >= created_at");
  });

  it("the rollback refuses while rows exist", () => {
    expect(rollback).toMatch(/rollback refused: rows exist/);
  });
});
