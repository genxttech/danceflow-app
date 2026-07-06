import { useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, studentPassQrImageUrl, type LinkedStudioAccess } from "@/lib/studentAccess";

function studentDisplayName(linkedStudios: LinkedStudioAccess[]) {
  const primary = linkedStudios[0];
  const name = [primary?.clientFirstName, primary?.clientLastName].filter(Boolean).join(" ").trim();
  return name || "DanceFlow student";
}

function accountDisplayName(session: ReturnType<typeof useAuth>["session"]) {
  const metadata = session?.user.user_metadata ?? {};
  const firstName = typeof metadata.first_name === "string" ? metadata.first_name : "";
  const lastName = typeof metadata.last_name === "string" ? metadata.last_name : "";
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  const fallbackName =
    typeof metadata.name === "string"
      ? metadata.name
      : typeof metadata.full_name === "string"
        ? metadata.full_name
        : "";

  return fullName || fallbackName || session?.user.email || "DanceFlow dancer";
}

function ProfileActionCard({
  detail,
  icon,
  onPress,
  title
}: {
  detail: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  title: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.actionCard, pressed && styles.cardPressed]}
    >
      <View style={styles.actionIcon}>
        <Ionicons color="#fff" name={icon} size={22} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText variant="subtitle">{title}</AppText>
        <AppText variant="caption">{detail}</AppText>
      </View>
    </Pressable>
  );
}

function ConnectedStudioCard({ studio }: { studio: LinkedStudioAccess }) {
  const studioName = studio.studioPublicName || studio.studioName || "Connected studio";
  const studentName = [studio.clientFirstName, studio.clientLastName].filter(Boolean).join(" ").trim();

  return (
    <View style={styles.passCard}>
      <View style={styles.passTop}>
        <View style={styles.passInfo}>
          <AppText variant="eyebrow">Connected Studio Access</AppText>
          <AppText variant="subtitle">{studioName}</AppText>
          <AppText variant="caption">
            Student name: {studentName || "DanceFlow student"}
          </AppText>
          <AppText variant="caption">
            Show this pass for studio lookup and future student check-ins.
          </AppText>
        </View>
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="contain"
          source={{ uri: studentPassQrImageUrl(studio) }}
          style={styles.passQrImage}
        />
      </View>
      <View style={styles.passActions}>
        <AppButton label="Schedule" onPress={() => router.push("/(tabs)/schedule")} variant="secondary" />
        <AppButton label="Packages" onPress={() => router.push("/wallet/packages")} variant="secondary" />
        <AppButton label="Memberships" onPress={() => router.push("/wallet/memberships")} variant="secondary" />
      </View>
    </View>
  );
}

export default function WalletProfileScreen() {
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
        setErrorMessage("Profile details could not be loaded. Try again in a moment.");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();

    return () => {
      mounted = false;
    };
  }, [session?.user.id]);

  const hasPortalAccess = linkedStudios.length > 0;

  return (
    <Screen>
      <AppText variant="eyebrow">Wallet</AppText>
      <AppText variant="title">Profile</AppText>
      <AppText variant="caption">Your DanceFlow account and connected studio access.</AppText>

      {loading ? <FeatureCard title="Loading profile" detail="Checking your connected studio details." /> : null}
      {errorMessage ? <FeatureCard title="Profile unavailable" detail={errorMessage} /> : null}

      {!loading ? (
        <View style={styles.section}>
          <View style={styles.profileCard}>
            <AppText variant="eyebrow">DanceFlow Account</AppText>
            <AppText variant="title">{accountDisplayName(session)}</AppText>
            {session?.user.email ? <AppText variant="caption">{session.user.email}</AppText> : null}
            <AppText variant="caption">
              Your app-level account for discovery, tickets, favorites, notifications, and future cross-studio features.
            </AppText>
          </View>

          <View style={styles.actionList}>
            <ProfileActionCard
              detail="Update your app-level name and account identity."
              icon="person-outline"
              onPress={() => router.push("/profile")}
              title="DanceFlow Profile"
            />
            <ProfileActionCard
              detail="Manage account preferences and access controls."
              icon="settings-outline"
              onPress={() => router.push("/settings")}
              title="Settings"
            />
          </View>

          {hasPortalAccess ? (
            <View style={styles.studioList}>
              {linkedStudios.map((studio) => (
                <ConnectedStudioCard key={studio.clientId} studio={studio} />
              ))}
            </View>
          ) : (
            <FeatureCard
              title="No studio connected yet"
              detail="Your DanceFlow account is active. Studio access appears here after a studio connects your account."
            />
          )}

          <AppButton label="Sign Out" onPress={signOut} variant="secondary" />
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  actionCard: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 14,
    padding: 16
  },
  actionIcon: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: 16,
    height: 46,
    justifyContent: "center",
    width: 46
  },
  actionList: {
    gap: 10
  },
  cardPressed: {
    opacity: 0.78
  },
  passCard: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 22,
    gap: 12,
    padding: 16
  },
  passActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  passInfo: {
    flex: 1,
    gap: 7
  },
  passQrImage: {
    backgroundColor: "white",
    borderRadius: 14,
    height: 116,
    width: 116
  },
  passTop: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14
  },
  profileCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 7,
    padding: 16
  },
  section: {
    gap: 10
  },
  studioList: {
    gap: 10
  }
});
