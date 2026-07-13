import { useEffect, useState } from "react";
import { Alert, StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { NotificationPreferencesCard } from "@/components/NotificationPreferencesCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import { deleteDanceFlowAccount } from "@/lib/accountControls";

export default function SettingsScreen() {
  const { session, signOut } = useAuth();
  const [loading, setLoading] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
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
