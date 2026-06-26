import { router } from "expo-router";
import { useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  TextInput,
  View
} from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";

const danceFlowLogo = require("../../assets/danceflow-logo.png");

export default function SignInScreen() {
  const { continueWithEmail } = useAuth();
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleContinue() {
    setError(null);
    setMessage(null);
    setSubmitting(true);

    try {
      await continueWithEmail(email);
      setMessage("Check your email. Open the secure link to continue in DanceFlow.");
    } catch (_err) {
      setError("We could not send that link yet. Check your email address and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen scroll={false}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.wrap}
      >
        <View style={styles.header}>
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="contain"
            source={danceFlowLogo}
            style={styles.logo}
          />
          <AppText variant="eyebrow">DanceFlow</AppText>
          <AppText variant="title">Find your next dance moment</AppText>
          <AppText variant="caption">
            Discover studios and events without an account. Continue with email when you want to save favorites, keep tickets handy, or connect with your studio.
          </AppText>
        </View>

        <View style={styles.form}>
          <AppButton
            label="Start exploring"
            onPress={() => router.replace("/(tabs)/discover")}
          />

          <View style={styles.dividerRow}>
            <View style={styles.divider} />
            <AppText style={styles.dividerText}>or</AppText>
            <View style={styles.divider} />
          </View>

          <AppText variant="subtitle">Continue with email</AppText>
          <AppText variant="caption">
            New or returning, use your email and we’ll send a secure link. No password needed.
          </AppText>

          <TextInput
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            onChangeText={setEmail}
            placeholder="Email"
            placeholderTextColor={colors.muted}
            style={styles.input}
            textContentType="emailAddress"
            value={email}
          />

          {message ? <AppText style={styles.success}>{message}</AppText> : null}
          {error ? <AppText style={styles.error}>{error}</AppText> : null}

          <AppButton
            disabled={!email.trim()}
            label="Send secure link"
            loading={submitting}
            onPress={handleContinue}
            variant="secondary"
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    justifyContent: "center",
    gap: 28
  },
  header: {
    alignItems: "flex-start",
    gap: 10
  },
  logo: {
    height: 70,
    marginBottom: 8,
    width: 190
  },
  form: {
    gap: 12
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    minHeight: 52,
    paddingHorizontal: 14
  },
  dividerRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    marginVertical: 6
  },
  divider: {
    backgroundColor: colors.border,
    flex: 1,
    height: 1
  },
  dividerText: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: "700"
  },
  success: {
    color: colors.success
  },
  error: {
    color: colors.danger
  }
});
