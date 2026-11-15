import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { StateMessage } from "@/components/StateMessage";
import { isStaffFeatureEnabled } from "@/lib/features";
import { PulseScreen } from "@/screens/PulseScreen";

/** Until the Pulse screen is device-verified (EXPO_PUBLIC_STAFF_FEATURES=pulse) this stays the placeholder. */
function PulsePlaceholder() {
  return (
    <Screen>
      <AppText variant="heading" accessibilityRole="header">
        Pulse
      </AppText>
      <StateMessage
        testID="pulse-placeholder"
        title="Studio pulse is coming"
        body="A quick read of today's studio activity will live here. Until then, reports stay on DanceFlow for the web."
      />
    </Screen>
  );
}

export default isStaffFeatureEnabled("pulse") ? PulseScreen : PulsePlaceholder;
