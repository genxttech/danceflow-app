import { Redirect } from "expo-router";
import { ScheduleSkeleton } from "@/components/Skeleton";
import { Screen } from "@/components/Screen";
import { initialTab } from "@/lib/navigation";
import { useStaffSession } from "@/lib/staff";

export default function Index() {
  const { me, loading, workspace } = useStaffSession();
  // Wait for /me so the redirect lands on a tab this workspace actually has.
  if (loading && !me) {
    return (
      <Screen>
        <ScheduleSkeleton rows={3} label="Loading your studios" />
      </Screen>
    );
  }
  return <Redirect href={`/${initialTab(workspace)}`} />;
}
