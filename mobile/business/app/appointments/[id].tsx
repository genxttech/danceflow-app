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

  // The detail response has no time zone, so Today passes the studio's along (see the PR's API notes).
  return <AppointmentScreen appointmentId={id} studioId={studioId} timeZone={tz || undefined} />;
}
