import { useEffect, useState } from "react";
import { Alert, Share, StyleSheet, TextInput, useColorScheme, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { NotificationPreferencesCard } from "@/components/NotificationPreferencesCard";
import { Screen } from "@/components/Screen";
import { colorsForScheme } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import {
  deactivateDanceFlowAccount,
  deleteDanceFlowAccount,
  downloadDanceFlowAccountData,
  requestLoginEmailChange,
} from "@/lib/accountControls";

export default function SettingsScreen() {
  const { session, signOut } = useAuth();
  const colors = colorsForScheme(useColorScheme());
  const styles = createStyles(colors);
  const [loading, setLoading] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [newLoginEmail, setNewLoginEmail] = useState("");
  const [securityBusy, setSecurityBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    const userId = session?.user.id;

    async function load() {
      if (!userId) {
        setLinkedStudios([]);
        setLoading(false);
        return;
      }

      setLoading(true);
      setErrorMessage(null);

      try {
        const access = await getStudentAccess(userId);
        if (!mounted) return;
        setLinkedStudios(access.linkedStudios);
      } catch {
        if (!mounted) return;
        setErrorMessage("Settings could not load connected studio details.");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();

    return () => {
      mounted = false;
    };
  }, [session?.user.id]);

  async function submitEmailChange() {
    const email = newLoginEmail.trim().toLowerCase();

    if (!email || !email.includes("@")) {
      Alert.alert("Valid email required", "Enter the new login email address.");
      return;
    }

    setSecurityBusy(true);
    try {
      const result = await requestLoginEmailChange(email);
      setNewLoginEmail("");
      Alert.alert("Check your email", result.message);
    } catch (error) {
      Alert.alert(
        "Email change failed",
        error instanceof Error ? error.message : "Try again in a moment.",
      );
    } finally {
      setSecurityBusy(false);
    }
  }

  function confirmDeactivateAccount() {
    Alert.alert(
      "Deactivate DanceFlow account?",
      "This signs you out and makes your dancer profile private. Studio records and relationships remain intact.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Deactivate",
          style: "destructive",
          onPress: async () => {
            setSecurityBusy(true);
            try {
              await deactivateDanceFlowAccount();
              await signOut();
            } catch (error) {
              Alert.alert(
                "Account deactivation failed",
                error instanceof Error ? error.message : "Try again in a moment.",
              );
              setSecurityBusy(false);
            }
          }
        }
      ]
    );
  }

  async function shareAccountData() {
    setSecurityBusy(true);
    try {
      const data = await downloadDanceFlowAccountData();
      await Share.share({
        title: "DanceFlow Account Data",
        message: JSON.stringify(data, null, 2),
      });
    } catch (error) {
      Alert.alert(
        "Data export failed",
        error instanceof Error ? error.message : "Try again in a moment.",
      );
    } finally {
      setSecurityBusy(false);
    }
  }

  function confirmDeleteAccount() {
    Alert.alert(
      "Delete DanceFlow account?",
      "This permanently removes your DanceFlow login, dancer profile, favorites, preferences, and account-owned data. Studios may retain business records such as billing, attendance, documents, payments, and communications.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete Account",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteDanceFlowAccount();
              await signOut();
            } catch {
              Alert.alert(
                "Account deletion failed",
                "Your account was not deleted. Try again or contact DanceFlow support."
              );
            }
          }
        }
      ]
    );
  }

  return (
    <Screen>
      <AppText variant="eyebrow">Settings</AppText>
      <AppText variant="title">Account Settings</AppText>
      <AppText variant="caption">Manage account access and app preferences.</AppText>

      <View style={styles.card}>
        <AppText variant="eyebrow">Signed in as</AppText>
        <AppText variant="subtitle">{session?.user.email ?? "DanceFlow account"}</AppText>
        <AppText variant="caption">
          {loading
            ? "Checking connected studios..."
            : linkedStudios.length === 1
              ? "1 connected studio"
              : `${linkedStudios.length} connected studios`}
        </AppText>
      </View>

      {session?.user.id ? (
        <NotificationPreferencesCard userId={session.user.id} />
      ) : (
        <FeatureCard title="Notification preferences" detail="Sign in to manage app notification settings." />
      )}

      {errorMessage ? <FeatureCard title="Settings update" detail={errorMessage} /> : null}

      <View style={styles.securityCard}>
        <AppText variant="eyebrow">Account &amp; Security</AppText>
        <AppText variant="subtitle">Login email</AppText>
        <AppText variant="caption">
          Current login: {session?.user.email ?? "DanceFlow account"}
        </AppText>
        <TextInput
          autoCapitalize="none"
          autoCorrect={false}
          editable={!securityBusy}
          keyboardType="email-address"
          onChangeText={setNewLoginEmail}
          placeholder="New login email"
          placeholderTextColor={colors.muted}
          style={styles.input}
          value={newLoginEmail}
        />
        <AppButton
          label={securityBusy ? "Please wait..." : "Request Email Change"}
          onPress={submitEmailChange}
          variant="secondary"
        />
        <AppButton
          label="Deactivate Account"
          onPress={confirmDeactivateAccount}
          variant="secondary"
        />
      </View>

      <View style={styles.securityCard}>
        <AppText variant="eyebrow">Your Data</AppText>
        <AppText variant="subtitle">Download My Data</AppText>
        <AppText variant="caption">
          Create a copy of your DanceFlow profile, preferences, favorites,
          registrations, and account relationship history.
        </AppText>
        <AppButton
          label={securityBusy ? "Preparing..." : "Share My Data"}
          onPress={shareAccountData}
          variant="secondary"
        />
      </View>

      <View style={styles.dangerCard}>
        <AppText variant="eyebrow">Account Controls</AppText>
        <AppText variant="subtitle">Delete DanceFlow account</AppText>
        <AppText variant="caption">
          Permanently removes your DanceFlow login and account-owned profile data.
          Studios may retain their business records.
        </AppText>
        <AppButton label="Delete Account" onPress={confirmDeleteAccount} variant="secondary" />
      </View>

      <AppButton label="Sign Out" onPress={signOut} variant="secondary" />
    </Screen>
  );
}

function createStyles(colors: ReturnType<typeof colorsForScheme>) {
  return StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
    padding: 16
    },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 12,
    paddingVertical: 11
  },
  securityCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 10,
    padding: 16
  },
  dangerCard: {
    backgroundColor: colors.surface,
    borderColor: "#fecaca",
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
    padding: 16
  }
  });
}
