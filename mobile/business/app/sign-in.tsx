import { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { useAuth } from "@/lib/auth";
import { colors, radius, space, type } from "@/theme";

export default function SignInScreen() {
  const { signInWithPassword, sendSignInLink } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | "link" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handlePassword() {
    setBusy("password");
    setError(null);
    setMessage(null);
    try {
      await signInWithPassword(email, password);
    } catch {
      setError("That email and password did not match. Try again, or email yourself a sign-in link.");
    } finally {
      setBusy(null);
    }
  }

  async function handleLink() {
    setBusy("link");
    setError(null);
    setMessage(null);
    try {
      await sendSignInLink(email);
      setMessage("If this email belongs to studio staff, a sign-in link is on its way. Open it on this device.");
    } catch {
      setError("We could not send a link right now. Check the address and try again.");
    } finally {
      setBusy(null);
    }
  }

  const hasEmail = email.trim().length > 0;

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.wrap}>
        <View style={styles.header}>
          <AppText variant="label" tone="plum">
            DanceFlow Business
          </AppText>
          <AppText variant="heading" accessibilityRole="header">
            Sign in to your studio
          </AppText>
          <AppText tone="muted">Use the email and password you use for DanceFlow on the web.</AppText>
        </View>

        <View style={styles.form}>
          <View style={styles.field}>
            <AppText variant="label" nativeID="email-label">
              Email
            </AppText>
            <TextInput
              accessibilityLabel="Email"
              accessibilityLabelledBy="email-label"
              autoCapitalize="none"
              autoComplete="email"
              autoCorrect={false}
              inputMode="email"
              keyboardType="email-address"
              onChangeText={setEmail}
              style={styles.input}
              textContentType="username"
              value={email}
            />
          </View>
          <View style={styles.field}>
            <AppText variant="label" nativeID="password-label">
              Password
            </AppText>
            <TextInput
              accessibilityLabel="Password"
              accessibilityLabelledBy="password-label"
              autoCapitalize="none"
              autoComplete="current-password"
              onChangeText={setPassword}
              onSubmitEditing={() => hasEmail && password && void handlePassword()}
              secureTextEntry
              style={styles.input}
              textContentType="password"
              value={password}
            />
          </View>

          {error ? (
            <AppText tone="error" accessibilityRole="alert">
              {error}
            </AppText>
          ) : null}
          {message ? (
            <AppText tone="success" accessibilityLiveRegion="polite">
              {message}
            </AppText>
          ) : null}

          <AppButton
            label="Sign in"
            onPress={() => void handlePassword()}
            disabled={!hasEmail || !password || busy !== null}
            loading={busy === "password"}
          />
          <AppButton
            label="Email me a sign-in link"
            variant="secondary"
            onPress={() => void handleLink()}
            disabled={!hasEmail || busy !== null}
            loading={busy === "link"}
          />
          <AppText variant="caption" tone="muted">
            Accounts are created by your studio on the web. Dancers use the DanceFlow app instead.
          </AppText>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.xl, paddingTop: space.xxl },
  header: { gap: space.sm },
  form: { gap: space.lg },
  field: { gap: space.xs },
  input: {
    fontSize: type.body.fontSize, // no fixed lineHeight: Android would not scale it with the system text size
    minHeight: 48,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    borderRadius: radius.control,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.raised,
    color: colors.text,
  },
});
