// Shared group-class membership benefit resolution, mirroring the exact
// tie-break rule already enforced server-side by GC-2's own triggers
// (enforce_group_class_membership_capacity / deduct_membership_usage_for_class_attendee):
// a membership's applicable group-class benefit is 'unlimited_group_classes'
// if present, else 'included_group_classes' (finite) if present, else the
// membership does not cover group classes at all. Used by both the staff
// roster display and the Add Student eligibility check so the two surfaces
// can never disagree with each other or with the DB's own authority.

export type GroupClassBenefitResolution =
  | { kind: "unlimited" }
  | { kind: "finite"; quantity: number | null }
  | null;

const GROUP_CLASS_BENEFIT_TYPES = new Set(["unlimited_group_classes", "included_group_classes"]);

function appliesToGroupClass(appliesTo: string | null | undefined) {
  return !appliesTo || appliesTo === "" || appliesTo === "all" || appliesTo === "group_class";
}

export function resolveGroupClassBenefit(
  benefits: { benefit_type: string; quantity: number | null; applies_to: string | null }[],
): GroupClassBenefitResolution {
  const applicable = benefits.filter(
    (benefit) =>
      GROUP_CLASS_BENEFIT_TYPES.has(benefit.benefit_type) && appliesToGroupClass(benefit.applies_to),
  );

  if (applicable.length === 0) return null;

  if (applicable.some((benefit) => benefit.benefit_type === "unlimited_group_classes")) {
    return { kind: "unlimited" };
  }

  const finite = applicable.find((benefit) => benefit.benefit_type === "included_group_classes");
  return finite ? { kind: "finite", quantity: finite.quantity } : null;
}
