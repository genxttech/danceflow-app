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

  async function loadSettings() {
    const userId = session?.user.id;

    if (!userId) {
      setLinkedStudios([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      const access = await getStudentAccess(userId);
      setLinkedStudios(access.linkedStudios);
    } catch {
      setErrorMessage("Settings could not load connected studio details.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
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
        message: data.report,
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
          text: "Continue",
          style: "destructive",
          onPress: () => {
            Alert.alert(
              "Final confirmation",
              "This cannot be undone. Your DanceFlow login and account-owned data will be permanently removed.",
              [
                { text: "Cancel", style: "cancel" },
                {
                  text: "Permanently Delete",
                  style: "destructive",
                  onPress: async () => {
                    try {
                      await deleteDanceFlowAccount();
                      await signOut();
                    } catch {
                      Alert.alert(
                        "Account deletion failed",
                        "Your account was not deleted. Try again or contact DanceFlow support.",
                      );
                    }
                  },
                },
              ],
            );
          },
        }
      ]
    );
  }

  return (
    <Screen refreshing={loading} onRefresh={loadSettings}>
      <View style={styles.hero}>
        <AppText style={styles.heroEyebrow}>Settings</AppText>
        <AppText style={styles.heroTitle}>Account & preferences</AppText>
        <AppText style={styles.heroDetail}>
          Manage your DanceFlow login, notifications, connected studios, and account data.
        </AppText>

        <View style={styles.accountSummary}>
          <View style={{ flex: 1 }}>
            <AppText style={styles.accountLabel}>Signed in as</AppText>
            <AppText style={styles.accountEmail}>
              {session?.user.email ?? "DanceFlow account"}
            </AppText>
          </View>
          <View style={styles.connectedBadge}>
            <AppText style={styles.connectedBadgeValue}>
              {loading ? "…" : linkedStudios.length}
            </AppText>
            <AppText style={styles.connectedBadgeLabel}>
              {linkedStudios.length === 1 ? "studio" : "studios"}
            </AppText>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <AppText variant="eyebrow">Preferences</AppText>
          <AppText variant="subtitle">Notifications</AppText>
        </View>
        {session?.user.id ? (
          <NotificationPreferencesCard userId={session.user.id} />
        ) : (
          <FeatureCard
            title="Notification preferences"
            detail="Sign in to manage app notification settings."
          />
        )}
      </View>

      {errorMessage ? (
        <View style={styles.stateBlock}>
          <FeatureCard title="Settings update" detail={errorMessage} />
          <AppButton label="Try again" onPress={loadSettings} variant="secondary" />
        </View>
      ) : null}

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <AppText variant="eyebrow">Account</AppText>
          <AppText variant="subtitle">Login & security</AppText>
        </View>
        <View style={styles.securityCard}>
        <AppText variant="eyebrow">Login email</AppText>
        <AppText variant="subtitle">Change your login email</AppText>
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
          label={securityBusy ? "Please wait..." : "Request email change"}
          onPress={submitEmailChange}
          variant="secondary"
        />
        <AppButton
          label="Deactivate Account"
          onPress={confirmDeactivateAccount}
          variant="secondary"
        />
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <AppText variant="eyebrow">Privacy</AppText>
          <AppText variant="subtitle">Your data</AppText>
        </View>
        <View style={styles.securityCard}>
        <AppText variant="eyebrow">Export</AppText>
        <AppText variant="subtitle">Download My Data</AppText>
        <AppText variant="caption">
          Download a copy of your DanceFlow profile, preferences, favorites,
          registrations, and account relationship history.
        </AppText>
        <AppButton
          label={securityBusy ? "Preparing..." : "Download My Data"}
          onPress={shareAccountData}
          variant="secondary"
        />
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <AppText variant="eyebrow">Account controls</AppText>
          <AppText variant="subtitle">Deactivate or delete</AppText>
        </View>
        <View style={styles.dangerCard}>
        <AppText variant="eyebrow">Permanent deletion</AppText>
        <AppText variant="subtitle">Delete DanceFlow account</AppText>
        <AppText variant="caption">
          Permanently removes your DanceFlow login and account-owned profile data.
          Studios may retain their business records.
        </AppText>
        <AppButton label="Delete Account" onPress={confirmDeleteAccount} variant="secondary" />
        </View>
      </View>

      <AppButton label="Sign Out" onPress={signOut} variant="ghost" />
    </Screen>
  );
}

function createStyles(colors: ReturnType<typeof colorsForScheme>) {
  return StyleSheet.create({
  hero: {
    backgroundColor: colors.backgroundSoft,
    borderColor: colors.border,
    borderRadius: 28,
    borderWidth: 1,
    gap: 8,
    padding: 20
  },
  heroEyebrow: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 1.4,
    textTransform: "uppercase"
  },
  heroTitle: {
    color: colors.text,
    fontSize: 28,
    fontWeight: "900",
    lineHeight: 34
  },
  heroDetail: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 21
  },
  accountSummary: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    marginTop: 8,
    padding: 14
  },
  accountLabel: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: "800",
    textTransform: "uppercase"
  },
  accountEmail: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "900",
    marginTop: 3
  },
  connectedBadge: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderRadius: 14,
    minWidth: 62,
    paddingHorizontal: 10,
    paddingVertical: 8
  },
  connectedBadgeValue: {
    color: colors.primary,
    fontSize: 18,
    fontWeight: "900"
  },
  connectedBadgeLabel: {
    color: colors.muted,
    fontSize: 9,
    fontWeight: "800",
    textTransform: "uppercase"
  },
  section: {
    gap: 10
  },
  sectionHeader: {
    gap: 3,
    paddingHorizontal: 2
  },
  stateBlock: {
    gap: 10
  },
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
    borderRadius: 20,
    borderWidth: 1,
    gap: 10,
    padding: 16
  },
  dangerCard: {
    backgroundColor: colors.surface,
    borderColor: colors.danger,
    borderRadius: 20,
    borderWidth: 1,
    gap: 8,
    padding: 16
  }
  });
}
