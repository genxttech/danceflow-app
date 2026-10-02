import { router } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { bindAccountPassword } from "@/lib/emailVerification";

const MIN_PASSWORD_LENGTH = 8;

/*
  LAUNCH-SEC-1C-A: shown right after the first email verification on this
  account. Saving a password finishes securing the account and signs out every
  device, so the student signs in again with a fresh email link.
*/
export default function SecureAccountScreen() {
  const { signOut, clearEmailBindingRequired } = useAuth();
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSave() {
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Choose a password with at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    if (password !== confirmPassword) {
      setError("Those passwords do not match.");
      return;
    }

    setSaving(true);

    try {
      await bindAccountPassword(password);
      clearEmailBindingRequired();
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "We could not save your password. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleLater() {
    clearEmailBindingRequired();
    router.replace("/(tabs)/home");
  }

  return (
    <Screen scroll={false}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.wrap}
      >
        {done ? (
          <View style={styles.form}>
            <AppText variant="eyebrow">Account secured</AppText>
            <AppText variant="title">You are all set</AppText>
            <AppText variant="caption">
              For your security we signed you out everywhere. Sign in again with a new email link to continue.
            </AppText>
            <AppButton label="Sign in again" onPress={() => void signOut()} />
          </View>
        ) : (
          <View style={styles.form}>
            <AppText variant="eyebrow">Email confirmed</AppText>
            <AppText variant="title">Create your password</AppText>
            <AppText variant="caption">
              One last step keeps your DanceFlow account and studio connections safe. You will keep signing in with email links in the app.
            </AppText>

            <TextInput
              autoCapitalize="none"
              autoComplete="new-password"
              onChangeText={setPassword}
              placeholder={`Password (at least ${MIN_PASSWORD_LENGTH} characters)`}
              placeholderTextColor={colors.muted}
              secureTextEntry
              style={styles.input}
              textContentType="newPassword"
              value={password}
            />
            <TextInput
              autoCapitalize="none"
              autoComplete="new-password"
              onChangeText={setConfirmPassword}
              placeholder="Confirm password"
              placeholderTextColor={colors.muted}
              secureTextEntry
              style={styles.input}
              textContentType="newPassword"
              value={confirmPassword}
            />

            {error ? <AppText style={styles.error}>{error}</AppText> : null}

            <AppButton
              disabled={!password || !confirmPassword}
              label="Save password"
              loading={saving}
              onPress={handleSave}
            />
            <AppButton label="Not now" onPress={() => void handleLater()} variant="ghost" />
          </View>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    justifyContent: "center"
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
  }
});
