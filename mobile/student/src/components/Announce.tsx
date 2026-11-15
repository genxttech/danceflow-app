import { useEffect } from "react";
import { AccessibilityInfo, Platform } from "react-native";

/*
  VoiceOver does not read live regions (accessibilityLiveRegion is Android-only), so a message that
  appears after the screen is open (an error, a payment status) would be silent on iOS. Render this next
  to the message: it announces it once when it appears or changes, on iOS only; Android keeps its live region.
*/
export function Announce({ message, os = Platform.OS }: { message: string | null | undefined; os?: string }) {
  useEffect(() => {
    if (os === "ios" && message) AccessibilityInfo.announceForAccessibility(message);
  }, [message, os]);
  return null;
}
