import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Regression coverage for the membership benefit-type/usage-period
 * silent-discard bug: BENEFIT_TYPES and USAGE_PERIODS in actions.ts used to
 * be independently-maintained allowlists that drifted from both the Create/
 * Edit UI dropdowns and the live DB CHECK constraints
 * (membership_plan_benefits_type_check /
 * membership_plan_benefits_usage_period_check). unlimited_group_classes,
 * unlimited_practice_parties, and included_group_classes were all offered in
 * the UI but silently coerced to "" (and then filtered out entirely) on
 * save; "monthly"/"unlimited" usage periods were silently coerced to
 * "billing_cycle". All three now derive from the single shared list in
 * src/lib/memberships/benefitTypes.ts, which mirrors the live DB constraints
 * exactly -- this suite proves both createMembershipPlanAction and
 * updateMembershipPlanAction actually persist every supported combination.
 */

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT");
    (error as unknown as { digest: string }).digest = `NEXT_REDIRECT;replace;${url};307;`;
    throw error;
  },
}));

class UnexpectedQueryError extends Error {
  constructor(detail: string) {
    super(`UNEXPECTED_QUERY:${detail}`);
  }
}

let insertedBenefitRows: Array<{ benefit_type: string; usage_period: string }> = [];
let existingBenefitRowsBeforeUpdate: Array<{ id: string }> = [];

function makeThenable<T>(value: T) {
  return {
    then(onFulfilled: (v: T) => unknown, onRejected?: (r: unknown) => unknown) {
      return Promise.resolve(value).then(onFulfilled, onRejected);
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: string) {
      if (table === "membership_plans") {
        return {
          insert: () => ({
            select: () => ({
              single: () => Promise.resolve({ data: { id: "plan-1" }, error: null }),
            }),
          }),
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: { id: "plan-1" }, error: null }),
              }),
            }),
          }),
          update: () => ({
            eq: () => ({
              eq: () => makeThenable({ error: null }),
            }),
          }),
        };
      }

      if (table === "membership_plan_benefits") {
        return {
          insert: (rows: Array<{ benefit_type: string; usage_period: string }>) => {
            insertedBenefitRows = rows;
            return makeThenable({ error: null });
          },
          delete: () => ({
            eq: () => ({
              select: () => Promise.resolve({ data: existingBenefitRowsBeforeUpdate, error: null }),
            }),
          }),
          select: () => ({
            eq: () => Promise.resolve({ data: [], error: null }),
          }),
        };
      }

      throw new UnexpectedQueryError(table);
    },
  }),
}));

vi.mock("@/lib/auth/studio", () => ({
  getCurrentStudioContext: async () => ({
    studioId: "studio-1",
    studioRole: "studio_owner",
    isPlatformAdmin: false,
    userId: "user-1",
    email: "owner@example.test",
  }),
}));

const { createMembershipPlanAction, updateMembershipPlanAction } = await import("../actions");

function benefitsFormData(
  benefits: Array<{ benefitType: string; usagePeriod: string; quantity?: string }>,
  extra: Record<string, string> = {},
) {
  const fd = new FormData();
  fd.set("name", "Test Plan");
  fd.set("billingInterval", "monthly");
  fd.set("price", "50");
  fd.set("visibility", "public");
  fd.set(
    "benefitsJson",
    JSON.stringify(
      benefits.map((b) => ({
        benefitType: b.benefitType,
        usagePeriod: b.usagePeriod,
        quantity: b.quantity ?? "",
        discountPercent: "",
        discountAmount: "",
        appliesTo: "",
      })),
    ),
  );
  for (const [key, value] of Object.entries(extra)) fd.set(key, value);
  return fd;
}

async function runToRedirect(promise: Promise<unknown>) {
  try {
    await promise;
    throw new Error("expected redirect");
  } catch (error) {
    if (error instanceof UnexpectedQueryError) throw error;
    return error as { digest?: string };
  }
}

const SUPPORTED_BENEFIT_TYPES = [
  "unlimited_group_classes",
  "unlimited_practice_parties",
  "included_group_classes",
  "included_private_lessons",
  "event_discount_percent",
  "floor_rental_discount_percent",
];

const SUPPORTED_USAGE_PERIODS = ["billing_cycle", "monthly", "unlimited"];

describe("membership benefit-type/usage-period persistence", () => {
  beforeEach(() => {
    insertedBenefitRows = [];
    existingBenefitRowsBeforeUpdate = [];
  });

  describe.each(SUPPORTED_BENEFIT_TYPES)("benefit type: %s", (benefitType) => {
    it("createMembershipPlanAction persists it (not silently dropped)", async () => {
      const fd = benefitsFormData([{ benefitType, usagePeriod: "billing_cycle", quantity: "5" }]);
      const result = await runToRedirect(createMembershipPlanAction({ error: "" }, fd));
      expect(result.digest).toContain("/app/memberships");
      expect(insertedBenefitRows).toHaveLength(1);
      expect(insertedBenefitRows[0].benefit_type).toBe(benefitType);
    });

    it("updateMembershipPlanAction persists it (not silently dropped)", async () => {
      const fd = benefitsFormData(
        [{ benefitType, usagePeriod: "billing_cycle", quantity: "5" }],
        { id: "plan-1" },
      );
      const result = await runToRedirect(updateMembershipPlanAction({ error: "" }, fd));
      expect(result.digest).toContain("/app/memberships/plan-1");
      expect(insertedBenefitRows).toHaveLength(1);
      expect(insertedBenefitRows[0].benefit_type).toBe(benefitType);
    });
  });

  describe.each(SUPPORTED_USAGE_PERIODS)("usage period: %s", (usagePeriod) => {
    it("createMembershipPlanAction persists it verbatim (not coerced to billing_cycle)", async () => {
      const fd = benefitsFormData([{ benefitType: "included_group_classes", usagePeriod, quantity: "5" }]);
      await runToRedirect(createMembershipPlanAction({ error: "" }, fd));
      expect(insertedBenefitRows).toHaveLength(1);
      expect(insertedBenefitRows[0].usage_period).toBe(usagePeriod);
    });

    it("updateMembershipPlanAction persists it verbatim (not coerced to billing_cycle)", async () => {
      const fd = benefitsFormData(
        [{ benefitType: "included_group_classes", usagePeriod, quantity: "5" }],
        { id: "plan-1" },
      );
      await runToRedirect(updateMembershipPlanAction({ error: "" }, fd));
      expect(insertedBenefitRows).toHaveLength(1);
      expect(insertedBenefitRows[0].usage_period).toBe(usagePeriod);
    });
  });

  it("createMembershipPlanAction still drops a genuinely unsupported benefit type", async () => {
    const fd = benefitsFormData([{ benefitType: "not_a_real_benefit_type", usagePeriod: "billing_cycle" }]);
    await runToRedirect(createMembershipPlanAction({ error: "" }, fd));
    expect(insertedBenefitRows).toHaveLength(0);
  });
});
