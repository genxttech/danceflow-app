export type PackageItemSummary = {
  usage_type: string;
  quantity_remaining: number | null;
  quantity_total?: number | null;
  is_unlimited: boolean;
};

function usageLabel(value: string) {
  if (value === "private_lesson") return "Private";
  if (value === "group_class") return "Group";
  if (value === "practice_party") return "Practice";
  return value;
}

export function summarizeClientPackageItems(items: PackageItemSummary[]) {
  if (!items || items.length === 0) return "No balances";

  return items
    .map((item) => {
      const label = usageLabel(item.usage_type);
      return item.is_unlimited
        ? `${label}: Unlimited`
        : `${label}: ${item.quantity_remaining}`;
    })
    .join(" | ");
}