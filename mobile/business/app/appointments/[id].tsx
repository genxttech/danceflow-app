import { useLocalSearchParams } from "expo-router";
import { StateMessage } from "@/components/StateMessage";
import { Screen } from "@/components/Screen";
import { AppointmentScreen } from "@/screens/AppointmentScreen";

export default function AppointmentRoute() {
  const { id, studioId, tz } = useLocalSearchParams<{ id: string; studioId?: string; tz?: string }>();

  if (!id || !studioId) {
    return (
      <Screen edges={[]}>
        <StateMessage title="Not found" body="Open the appointment from your schedule." tone="error" />
      </Screen>
    );
  }

  // Slice 2 detail carries the studio zone; the tz param (from Today or the client screen) covers a server without it.
  return <AppointmentScreen appointmentId={id} studioId={studioId} timeZone={tz || undefined} />;
}
