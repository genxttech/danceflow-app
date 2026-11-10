import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { StateMessage } from "@/components/StateMessage";
import { useStaffSession } from "@/lib/staff";

export default function ClientsScreen() {
  const { workspace } = useStaffSession();
  const studioWide = workspace?.capabilities?.viewClients === true;

  return (
    <Screen>
      <AppText variant="heading" accessibilityRole="header">
        {studioWide ? "Clients" : "My clients"}
      </AppText>
      <StateMessage
        testID="clients-placeholder"
        title="Client lists are coming"
        body={
          studioWide
            ? "Searching the studio's clients will live here. Until then, use DanceFlow on the web."
            : "The dancers you teach will appear here. Until then, open a lesson from Today to see who it is with."
        }
      />
    </Screen>
  );
}
