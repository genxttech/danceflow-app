import { Linking, StyleSheet, Text, useColorScheme } from "react-native";
import { AppText } from "@/components/AppText";
import { colorsForScheme } from "@/constants/theme";

const LEGAL_PATHS = { privacy: "/privacy", terms: "/terms", accountDeletion: "/account-deletion" } as const;

export function legalUrl(page: keyof typeof LEGAL_PATHS) {
  return new URL(LEGAL_PATHS[page], process.env.EXPO_PUBLIC_DANCEFLOW_WEB_URL).toString();
}

export function LegalLinks({ prefix }: { prefix?: string }) {
  const colors = colorsForScheme(useColorScheme());
  const linkStyle = [styles.link, { color: colors.primary }];

  return (
    <AppText variant="caption">
      {prefix ? `${prefix} ` : ""}
      <Text
        accessibilityRole="link"
        onPress={() => void Linking.openURL(legalUrl("terms"))}
        style={linkStyle}
      >
        Terms
      </Text>
      {" and "}
      <Text
        accessibilityRole="link"
        onPress={() => void Linking.openURL(legalUrl("privacy"))}
        style={linkStyle}
      >
        Privacy Policy
      </Text>
    </AppText>
  );
}

/** The public page Google Play and App Store reviewers read; shown beside the in-app delete button. */
export function AccountDeletionLink() {
  const colors = colorsForScheme(useColorScheme());
  return (
    <AppText variant="caption">
      <Text
        accessibilityRole="link"
        onPress={() => void Linking.openURL(legalUrl("accountDeletion"))}
        style={[styles.link, { color: colors.primary }]}
      >
        How account deletion works
      </Text>
    </AppText>
  );
}

const styles = StyleSheet.create({
  link: {
    fontWeight: "700",
    textDecorationLine: "underline",
  },
});
