import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { StateMessage } from "@/components/StateMessage";
import type { LinkStatus } from "@/lib/auth";
import { colors, space } from "@/theme";

/** How long to wait for a link that never resolves (no code reached the app) before saying so. */
export const CALLBACK_TIMEOUT_MS = 20_000;

/**
 * What danceflow-business://auth/callback shows while the auth provider exchanges the link. Without this route Expo Router
 * opened its "Unmatched Route" page for every sign-in link (found in the emulator walk). The provider does the exchange;
 * this screen only reports it: signing in, done (the caller redirects), or the link didn't work.
 */
export function AuthCallbackScreen({
  signedIn,
  linkStatus,
  onDone,
  onBackToSignIn,
}: {
  signedIn: boolean;
  linkStatus: LinkStatus;
  onDone: () => void;
  onBackToSignIn: () => void;
}) {
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), CALLBACK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (signedIn) onDone();
  }, [signedIn, onDone]);

  if (signedIn) return null;

  if (linkStatus === "failed" || (timedOut && linkStatus !== "processing")) {
    return (
      <Screen>
        <StateMessage
          tone="error"
          testID="callback-failed"
          title="This sign-in link didn't work"
          body="It may have expired, been used already, or been opened on a different device from the one that asked for it. Request a new link from this phone."
          actions={[{ label: "Back to sign in", onPress: onBackToSignIn }]}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={styles.wrap} accessible accessibilityRole="progressbar" accessibilityLabel="Signing you in" testID="callback-progress">
        <ActivityIndicator color={colors.plum} />
        <AppText variant="title">Signing you in…</AppText>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", gap: space.md, paddingTop: space.xxxl },
});
