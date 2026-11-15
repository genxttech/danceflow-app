import { useState } from "react";
import { isStaffFeatureEnabled } from "@/lib/features";
import { isStudioWideRole } from "@/lib/navigation";
import { useStaffSession } from "@/lib/staff";
import { DayModeSwitch, StudioScheduleScreen, type DayMode } from "@/screens/StudioScheduleScreen";
import { TodayScreen } from "@/screens/TodayScreen";

/**
 * Owner, admin and front desk can switch between their own day and the studio's (EXPO_PUBLIC_STAFF_FEATURES=studioSchedule); an instructor, or a build with the
 * flag off, gets Today exactly as before. Each mode keeps its own date, and a switch re-opens the other mode on today.
 */
export default function TodayTab() {
  const { workspace } = useStaffSession();
  const [mode, setMode] = useState<DayMode>("mine");

  if (!isStaffFeatureEnabled("studioSchedule") || !isStudioWideRole(workspace?.role)) return <TodayScreen />;

  const modeSwitch = <DayModeSwitch mode={mode} onChange={setMode} />;
  return mode === "studio" ? <StudioScheduleScreen modeSwitch={modeSwitch} /> : <TodayScreen modeSwitch={modeSwitch} />;
}
