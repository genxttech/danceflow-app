import { Link, router } from "expo-router";
import { useMemo, useState } from "react";
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

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export default function SignUpScreen() {
  const { signUp } = useAuth();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = useMemo(() => {
    return (
      firstName.trim().length > 0 &&
      lastName.trim().length > 0 &&
      normalizeEmail(email).includes("@") &&
      password.length >= 8 &&
      confirmPassword.length >= 8 &&
      password === confirmPassword
    );
  }, [confirmPassword, email, firstName, lastName, password]);

  async function handleSubmit() {
    setError(null);
    setNotice(null);

    if (password.length < 8) {
      setError("Use at least 8 characters for your password.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Passwords do not match yet.");
      return;
    }

    setSubmitting(true);

    try {
      const result = await signUp({
        firstName,
        lastName,
        email: normalizeEmail(email),
        password
      });

      if (result.emailConfirmationRequired) {
        setNotice(
          "Check your email to finish creating your DanceFlow account. After confirming, return here and sign in."
        );
        setPassword("");
        setConfirmPassword("");
        return;
      }

      router.replace("/(tabs)/home");
    } catch (err) {
      const message = err instanceof Error ? err.message.toLowerCase() : "";

      if (message.includes("already") || message.includes("registered")) {
        setError("An account may already exist for that email. Try signing in or resetting your password.");
      } else {
        setError("We could not create your account yet. Check your details and try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Screen>
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
          <AppText variant="title">Create your account</AppText>
          <AppText variant="caption">
            Save studios and events, keep tickets handy, and connect with your dance studios.
          </AppText>
        </View>

        <View style={styles.callout}>
          <AppText variant="subtitle">Already taking lessons?</AppText>
          <AppText variant="caption">
            Your studio can connect your DanceFlow account so your schedule, packages,
            membership, lesson notes, and LUMI coaching appear here.
          </AppText>
        </View>

        <View style={styles.form}>
          <View style={styles.nameRow}>
            <TextInput
              autoComplete="given-name"
              onChangeText={setFirstName}
              placeholder="First name"
              placeholderTextColor={colors.muted}
              style={[styles.input, styles.nameInput]}
              textContentType="givenName"
              value={firstName}
            />
            <TextInput
              autoComplete="family-name"
              onChangeText={setLastName}
              placeholder="Last name"
              placeholderTextColor={colors.muted}
              style={[styles.input, styles.nameInput]}
              textContentType="familyName"
              value={lastName}
            />
          </View>

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
            textContentType="newPassword"
            value={password}
          />
          <TextInput
            autoCapitalize="none"
            onChangeText={setConfirmPassword}
            placeholder="Confirm password"
            placeholderTextColor={colors.muted}
            secureTextEntry
            style={styles.input}
            textContentType="newPassword"
            value={confirmPassword}
          />

          {error ? <AppText style={styles.error}>{error}</AppText> : null}
          {notice ? <AppText style={styles.notice}>{notice}</AppText> : null}

          <AppButton
            disabled={!canSubmit}
            label="Create account"
            loading={submitting}
            onPress={handleSubmit}
          />

          <AppText variant="caption" style={styles.terms}>
            By creating an account, you agree to DanceFlow's terms and privacy policy.
          </AppText>

          <Link href="/(auth)/sign-in" style={styles.link}>
            Already have an account? Sign in
          </Link>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    gap: 22,
    justifyContent: "center"
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
  callout: {
    backgroundColor: colors.surfaceGlow,
    borderColor: colors.borderStrong,
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
    padding: 16
  },
  form: {
    gap: 12
  },
  nameRow: {
    flexDirection: "row",
    gap: 10
  },
  nameInput: {
    flex: 1
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
  notice: {
    color: colors.success
  },
  terms: {
    textAlign: "center"
  },
  link: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "800",
    marginTop: 2,
    textAlign: "center"
  }
});
