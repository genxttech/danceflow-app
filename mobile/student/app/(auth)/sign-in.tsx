import { Link, router } from "expo-router";
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
  const { signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);

    try {
      await signIn(email.trim(), password);
      router.replace("/(tabs)/home");
    } catch (err) {
      setError("We could not sign you in. Check your email and password, then try again.");
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
          <AppText variant="title">Student sign in</AppText>
          <AppText variant="caption">
            Access your schedule, lesson recaps, syllabus progress, favorite studios,
            tickets, balances, and LUMI.
          </AppText>
        </View>

        <View style={styles.form}>
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
          <TextInput
            autoCapitalize="none"
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor={colors.muted}
            secureTextEntry
            style={styles.input}
            textContentType="password"
            value={password}
          />
          {error ? <AppText style={styles.error}>{error}</AppText> : null}
          <AppButton
            disabled={!email.trim() || !password}
            label="Sign in"
            loading={submitting}
            onPress={handleSubmit}
          />
          <Link href="/(auth)/reset-password" style={styles.link}>
            Forgot password?
          </Link>
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
  error: {
    color: colors.danger
  },
  link: {
    color: colors.primary,
    fontSize: 15,
    fontWeight: "700",
    marginTop: 8,
    textAlign: "center"
  }
});
