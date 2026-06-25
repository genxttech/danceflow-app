import { Link } from "expo-router";
import { useState } from "react";
import { StyleSheet, TextInput, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";

export default function ResetPasswordScreen() {
  const { sendPasswordReset } = useAuth();
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);
    setMessage(null);
    setSubmitting(true);

    try {
      await sendPasswordReset(email.trim());
      setMessage("Password reset instructions were sent if the account exists.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Password reset failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen scroll={false}>
      <View style={styles.wrap}>
        <View style={styles.header}>
          <AppText variant="title">Reset password</AppText>
          <AppText variant="caption">
            Enter the email connected to your DanceFlow student account.
          </AppText>
        </View>
        <View style={styles.form}>
          <TextInput
            autoCapitalize="none"
            keyboardType="email-address"
            onChangeText={setEmail}
            placeholder="Email"
            placeholderTextColor={colors.muted}
            style={styles.input}
            value={email}
          />
          {message ? <AppText style={styles.success}>{message}</AppText> : null}
          {error ? <AppText style={styles.error}>{error}</AppText> : null}
          <AppButton
            disabled={!email.trim()}
            label="Send reset email"
            loading={submitting}
            onPress={handleSubmit}
          />
          <Link href="/(auth)/sign-in" style={styles.link}>
            Back to sign in
          </Link>
        </View>
      </View>
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
    gap: 10
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
  error: {
    color: colors.danger
  },
  success: {
    color: colors.success
  },
  link: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: "700",
    marginTop: 8,
    textAlign: "center"
  }
});
