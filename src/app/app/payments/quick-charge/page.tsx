import { redirect } from "next/navigation";

export default function QuickChargeCompatibilityPage() {
  redirect("/app/sell?type=quick_charge");
}
