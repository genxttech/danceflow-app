import { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, useColorScheme, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colorsForScheme } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess } from "@/lib/studentAccess";
import {
  formatWalletDate,
  loadStudentWallet,
  type StudentDigitalEntitlement
} from "@/lib/studentWallet";

function itemTypeLabel(value: string) {
  if (value === "video_series") return "Video series";
  if (value === "digital_download") return "Download";
  return "Video";
}

export default function DigitalPurchasesPage() {
  const colors = colorsForScheme(useColorScheme());
  const styles = createStyles(colors);
  const { session } = useAuth();
  const router = useRouter();
  const [items, setItems] = useState<StudentDigitalEntitlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) {
      setItems([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setErrorMessage(null);

    try {
      const access = await getStudentAccess(session.user.id);
      const wallet = await loadStudentWallet(
        access.linkedStudios,
        session.user.email,
        { force: true }
      );
      setItems(wallet.digitalEntitlements);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Digital purchases could not be loaded."
      );
    } finally {
      setLoading(false);
    }
  }, [session]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Screen>
      <AppText variant="eyebrow">Wallet</AppText>
      <AppText variant="title">Digital Purchases</AppText>
      <AppText variant="caption">
        Videos, series, and downloads purchased from your connected studios
        appear here. Open a video to watch it securely in DanceFlow.
      </AppText>

      {loading ? (
        <FeatureCard
          title="Loading digital purchases..."
          detail="Checking your active content access."
        />
      ) : null}

      {!loading && errorMessage ? (
        <FeatureCard title="Digital purchases unavailable" detail={errorMessage} />
      ) : null}

      {!loading && !errorMessage && items.length === 0 ? (
        <FeatureCard
          title="No digital purchases yet"
          detail="Purchased videos, series, and downloadable resources will appear here."
        />
      ) : null}

      {!loading && !errorMessage ? (
        <View style={styles.list}>
          {items.map((item) => {
            const playable =
              item.itemType === "digital_video" ||
              item.itemType === "video_series";

            return (
              <Pressable
                key={item.id}
                disabled={!playable}
                onPress={() =>
                  router.push(
                    {
                      pathname: "/learn/digital/[entitlementId]",
                      params: { entitlementId: item.id }
                    } as never
                  )
                }
                style={({ pressed }) => [
                  styles.card,
                  pressed && playable && styles.cardPressed,
                  !playable && styles.cardDisabled
                ]}
              >
                <View style={styles.header}>
                  <AppText variant="eyebrow">
                    {itemTypeLabel(item.itemType)}
                  </AppText>
                  <AppText variant="caption">{item.studioName}</AppText>
                </View>
                <AppText variant="subtitle">{item.name}</AppText>
                <AppText variant="caption">
                  Access granted {formatWalletDate(item.grantedAt)}
                </AppText>
                <AppText variant="caption">
                  {item.expiresAt
                    ? `Access expires ${formatWalletDate(item.expiresAt)}`
                    : "Lifetime access"}
                </AppText>
                <AppText variant="caption">
                  {playable ? "Tap to watch" : "Download access coming next"}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      ) : null}
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
      gap: 6,
      padding: 18
    },
    cardDisabled: {
      opacity: 0.65
    },
    cardPressed: {
      opacity: 0.78
    },
    header: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between"
    },
    list: {
      gap: 12
    }
  });
}
