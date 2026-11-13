import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { StateMessage } from "@/components/StateMessage";

export default function PulseScreen() {
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
