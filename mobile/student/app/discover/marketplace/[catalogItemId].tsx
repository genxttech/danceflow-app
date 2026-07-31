import { useEffect, useState } from "react";
import { Image, StyleSheet, useColorScheme, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colorsForScheme } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  loadStudentMarketplaceItem,
  type StudentMarketplaceItem
} from "@/lib/studentMarketplace";

function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}



export default function MarketplaceDetailScreen() {
  const { catalogItemId: rawId } = useLocalSearchParams<{ catalogItemId: string }>();
  const catalogItemId = normalizeParam(rawId);
  const router = useRouter();
  const { session } = useAuth();
  const colors = colorsForScheme(useColorScheme());
  const styles = createStyles(colors);
  const [item, setItem] = useState<StudentMarketplaceItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!catalogItemId) return;
    let mounted = true;

    loadStudentMarketplaceItem(catalogItemId)
      .then((nextItem) => {
        if (mounted) setItem(nextItem);
      })
      .catch((error) => {
        if (mounted) {
          setErrorMessage(error instanceof Error ? error.message : "Content could not be loaded.");
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [catalogItemId]);


  if (loading) {
    return (
      <Screen>
        <FeatureCard title="Loading content" detail="Checking availability and ownership." />
      </Screen>
    );
  }

  if (!item) {
    return (
      <Screen>
        <FeatureCard title="Content unavailable" detail={errorMessage ?? "This item could not be found."} />
      </Screen>
    );
  }

  return (
    <Screen>
      {item.imageUrl ? (
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="cover"
          accessibilityLabel={`${item.name} cover`}
          source={{ uri: item.imageUrl }}
          style={styles.cover}
        />
      ) : (
        <View style={styles.coverFallback}>
          <AppText style={styles.coverFallbackText}>DanceFlow Learning</AppText>
        </View>
      )}

      <AppText variant="eyebrow">
        {item.itemType === "video_series" ? "Video Series" : "Digital Video"}
      </AppText>
      <AppText variant="title">{item.name}</AppText>
      <AppText variant="caption">{item.studioName}</AppText>

      <View style={styles.card}>
        {item.description ? <AppText variant="caption">{item.description}</AppText> : null}
        {item.instructorName ? (
          <AppText variant="caption">Instructor: {item.instructorName}</AppText>
        ) : null}
        <View style={styles.metaRow}>
          {item.danceStyle ? (
            <View style={styles.metaChip}>
              <AppText variant="caption">{item.danceStyle}</AppText>
            </View>
          ) : null}
          {item.skillLevel ? (
            <View style={styles.metaChip}>
              <AppText variant="caption">
                {item.skillLevel.replace(/_/g, " ")}
              </AppText>
            </View>
          ) : null}
        </View>
        {item.owned ? (
          <AppText variant="subtitle">Owned</AppText>
        ) : (
          <AppText variant="caption">
            This item is available from the studio, but digital purchases are not sold inside the mobile app.
          </AppText>
        )}
      </View>

      {errorMessage ? (
        <FeatureCard title="Content needs attention" detail={errorMessage} />
      ) : null}

      {!session ? (
        <FeatureCard
          title="Sign in to check access"
          detail="Sign in to see whether this content is already available in your DanceFlow account."
        />
      ) : item.owned ? (
        <AppButton
          label="Open Digital Purchases"
          onPress={() => router.push("/wallet/digital-purchases" as never)}
        />
      ) : (
        <>
          <FeatureCard
            title="Mobile purchase unavailable"
            detail="DanceFlow does not sell digital videos or series inside the mobile app. Content already owned through your studio or DanceFlow account remains available here."
          />
          <AppButton
            label="Back to Marketplace"
            onPress={() => router.back()}
            variant="secondary"
          />
        </>
      )}
    </Screen>
  );
}

function createStyles(colors: ReturnType<typeof colorsForScheme>) {
  return StyleSheet.create({
    cover: {
      aspectRatio: 16 / 9,
      borderRadius: 20,
      width: "100%"
    },
    coverFallback: {
      alignItems: "center",
      aspectRatio: 16 / 9,
      backgroundColor: colors.surfaceAlt,
      borderRadius: 20,
      justifyContent: "center",
      width: "100%"
    },
    coverFallbackText: {
      color: colors.primary,
      fontWeight: "900"
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 20,
      borderWidth: 1,
      gap: 10,
      padding: 18
    },
    metaChip: {
      backgroundColor: colors.surfaceAlt,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 6
    },
    metaRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8
    }
  });
}
