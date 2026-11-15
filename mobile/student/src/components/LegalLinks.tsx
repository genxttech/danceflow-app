import { Linking, StyleSheet, Text, useColorScheme } from "react-native";
import { AppText } from "@/components/AppText";
import { colorsForScheme } from "@/constants/theme";

const LEGAL_PATHS = { privacy: "/privacy", terms: "/terms", accountDeletion: "/account-deletion", help: "/knowledgebase", dpa: "/dpa", security: "/security" } as const;

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

/** Public help and trust pages (no sign-in): the knowledge base, the data processing agreement and security. */
export function HelpLinks() {
  const colors = colorsForScheme(useColorScheme());
  const linkStyle = [styles.link, { color: colors.primary }];
  const open = (page: keyof typeof LEGAL_PATHS) => () => void Linking.openURL(legalUrl(page));
  return (
    <AppText variant="caption">
      <Text accessibilityRole="link" onPress={open("help")} style={linkStyle}>
        Help Center
      </Text>
      {" · "}
      <Text accessibilityRole="link" onPress={open("security")} style={linkStyle}>
        Security
      </Text>
      {" · "}
      <Text accessibilityRole="link" onPress={open("dpa")} style={linkStyle}>
        Data Processing Agreement
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
