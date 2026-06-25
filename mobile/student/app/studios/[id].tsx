import { useEffect, useState } from "react";
import { Pressable, Share, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  getPublicStudioDetailForMobile,
  setPublicFavoriteForMobile,
  type PublicStudioDetail
} from "@/lib/publicDiscovery";

function routeId(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default function StudioDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const studioId = routeId(id);
  const { session } = useAuth();
  const router = useRouter();
  const [studio, setStudio] = useState<PublicStudioDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [favoriteMessage, setFavoriteMessage] = useState<string | null>(null);
  const [savingFavorite, setSavingFavorite] = useState(false);

  useEffect(() => {
    let mounted = true;

    if (!studioId) {
      setError("We could not find that studio.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    getPublicStudioDetailForMobile(studioId, session?.user.id ?? null)
      .then((detail) => {
        if (!mounted) return;
        setStudio(detail);
        if (!detail) setError("This studio is no longer available.");
      })
      .catch(() => {
        if (!mounted) return;
        setError("We could not load this studio yet. Please try again.");
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [studioId, session?.user.id]);

  async function toggleFavorite() {
    const userId = session?.user.id ?? null;

    if (!studio || !userId) {
      setFavoriteMessage("Sign in to save studios.");
      return;
    }

    setSavingFavorite(true);
    setFavoriteMessage(null);

    try {
      await setPublicFavoriteForMobile({
        favorited: !studio.favorited,
        targetId: studio.id,
        targetType: "studio",
        userId
      });

      setStudio({ ...studio, favorited: !studio.favorited });
      setFavoriteMessage(
        !studio.favorited ? "Studio saved to your favorites." : "Studio removed from your favorites."
      );
    } catch {
      setFavoriteMessage("We could not update your favorite yet. Please try again.");
    } finally {
      setSavingFavorite(false);
    }
  }

  async function shareStudio() {
    if (!studio) return;

    await Share.share({
      title: studio.name,
      message: `${studio.name}\n${studio.webUrl}`,
      url: studio.webUrl
    });
  }

  return (
    <Screen>
      <AppButton label="Back to Discover" variant="ghost" onPress={() => router.back()} />

      {loading ? (
        <FeatureCard title="Loading studio" detail="Getting the latest studio details." />
      ) : null}

      {error ? <FeatureCard title="Studio unavailable" detail={error} /> : null}

      {studio ? (
        <>
          <AppText variant="eyebrow">
            {studio.favorited
              ? "Saved studio"
              : studio.beginnerFriendly
                ? "Beginner friendly"
                : "Studio"}
          </AppText>
          <AppText variant="title">{studio.name}</AppText>
          <AppText variant="caption">{studio.location}</AppText>

          <View style={styles.iconRow}>
            <Pressable
              accessibilityLabel={studio.favorited ? "Remove saved studio" : "Save studio"}
              disabled={savingFavorite}
              onPress={toggleFavorite}
              style={[styles.iconButton, studio.favorited && styles.iconButtonActive]}
            >
              <Ionicons
                color={studio.favorited ? "#fff" : colors.primary}
                name={studio.favorited ? "heart" : "heart-outline"}
                size={22}
              />
            </Pressable>
            <Pressable accessibilityLabel="Share studio" onPress={shareStudio} style={styles.iconButton}>
              <Ionicons color={colors.primary} name="share-outline" size={22} />
            </Pressable>
          </View>

          {favoriteMessage ? <AppText variant="caption">{favoriteMessage}</AppText> : null}

          <FeatureCard
            title="About this studio"
            detail={studio.description || "This studio is listed on DanceFlow discovery."}
          />

          <View style={styles.sectionHeading}>
            <AppText style={styles.sectionTitle}>Upcoming events</AppText>
            <AppText variant="caption">Tap an event to see details or register.</AppText>
          </View>

          {studio.upcomingEvents.length ? (
            studio.upcomingEvents.map((event) => (
              <Pressable
                key={event.id}
                onPress={() =>
                  router.push({
                    pathname: "/events/[id]",
                    params: { id: event.id }
                  })
                }
                style={({ pressed }) => [pressed && styles.cardPressed]}
              >
                <FeatureCard
                  label={event.registrationRequired ? "Tickets / registration" : "Event"}
                  title={event.name}
                  detail={`${event.schedule} · ${event.location}`}
                />
              </Pressable>
            ))
          ) : (
            <FeatureCard
              title="No upcoming events listed"
              detail="Check back later or search nearby events in Discover."
            />
          )}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  sectionHeading: {
    gap: 4,
    paddingHorizontal: 2,
    paddingTop: 6
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 18,
    fontWeight: "900"
  },
  cardPressed: {
    opacity: 0.78
  },
  iconRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10
  },
  iconButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border
  },
  iconButtonActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary
  }
});
