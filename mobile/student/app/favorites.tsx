import { useEffect, useState } from "react";
import { Pressable, Share, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  getPublicEventsForMobile,
  getPublicStudiosForMobile,
  setPublicFavoriteForMobile,
  type PublicEventItem,
  type PublicStudioItem
} from "@/lib/publicDiscovery";

export default function FavoritesScreen() {
  const { session } = useAuth();
  const router = useRouter();
  const [studios, setStudios] = useState<PublicStudioItem[]>([]);
  const [events, setEvents] = useState<PublicEventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function loadFavorites() {
    const userId = session?.user.id ?? null;

    if (!userId) {
      setStudios([]);
      setEvents([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    setMessage(null);

    try {
      const [studioRows, eventRows] = await Promise.all([
        getPublicStudiosForMobile(userId),
        getPublicEventsForMobile(userId)
      ]);

      setStudios(studioRows.filter((studio) => studio.favorited));
      setEvents(eventRows.filter((event) => event.favorited));
    } catch {
      setMessage("We could not load your saved items yet. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadFavorites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user.id]);

  async function toggleFavorite(targetType: "studio" | "event", targetId: string) {
    const userId = session?.user.id ?? null;

    if (!userId) {
      setMessage("Sign in to save favorites.");
      return;
    }

    const key = `${targetType}:${targetId}`;
    setBusyKey(key);
    setMessage(null);

    try {
      await setPublicFavoriteForMobile({
        favorited: false,
        targetId,
        targetType,
        userId
      });

      if (targetType === "studio") {
        setStudios((items) => items.filter((item) => item.id !== targetId));
      } else {
        setEvents((items) => items.filter((item) => item.id !== targetId));
      }
    } catch {
      setMessage("We could not update your saved item yet.");
    } finally {
      setBusyKey(null);
    }
  }

  async function shareItem(title: string, url: string) {
    await Share.share({ message: `${title}\n${url}`, title, url });
  }

  const hasItems = studios.length > 0 || events.length > 0;

  return (
    <Screen>
      <AppButton label="Back" onPress={() => router.back()} variant="secondary" />
      <FeatureCard
        label="Saved"
        title="Your favorites"
        detail="Studios and events you save from Discover appear here."
      />

      {loading ? <FeatureCard title="Loading saved items" detail="Getting your favorites." /> : null}
      {message ? <FeatureCard title="Saved items" detail={message} /> : null}

      {!loading && !hasItems ? (
        <FeatureCard
          title="No favorites yet"
          detail="Tap the heart on studios and events in Discover to save them here."
        />
      ) : null}

      {studios.length ? (
        <View style={styles.section}>
          <AppText variant="subtitle">Studios</AppText>
          {studios.map((studio) => {
            const key = `studio:${studio.id}`;
            return (
              <View key={studio.id} style={styles.item}>
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: "/studios/[id]",
                      params: { id: studio.id }
                    })
                  }
                  style={({ pressed }) => [pressed && styles.cardPressed]}
                >
                  <FeatureCard title={studio.name} detail={`${studio.location} · Tap for details`} />
                </Pressable>
                <View style={styles.iconRow}>
                  <Pressable
                    accessibilityLabel="Remove saved studio"
                    disabled={busyKey === key}
                    onPress={() => toggleFavorite("studio", studio.id)}
                    style={[styles.iconButton, styles.iconButtonActive]}
                  >
                    <Ionicons color="#fff" name="heart" size={20} />
                  </Pressable>
                  <Pressable
                    accessibilityLabel="Share studio"
                    onPress={() => shareItem(studio.name, studio.webUrl)}
                    style={styles.iconButton}
                  >
                    <Ionicons color={colors.primary} name="share-outline" size={20} />
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}

      {events.length ? (
        <View style={styles.section}>
          <AppText variant="subtitle">Events</AppText>
          {events.map((event) => {
            const key = `event:${event.id}`;
            return (
              <View key={event.id} style={styles.item}>
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: "/events/[id]",
                      params: { id: event.id }
                    })
                  }
                  style={({ pressed }) => [pressed && styles.cardPressed]}
                >
                  <FeatureCard
                    title={event.name}
                    detail={`${event.hostName} · ${event.schedule} · Tap for details`}
                  />
                </Pressable>
                <View style={styles.iconRow}>
                  <Pressable
                    accessibilityLabel="Remove saved event"
                    disabled={busyKey === key}
                    onPress={() => toggleFavorite("event", event.id)}
                    style={[styles.iconButton, styles.iconButtonActive]}
                  >
                    <Ionicons color="#fff" name="heart" size={20} />
                  </Pressable>
                  <Pressable
                    accessibilityLabel="Share event"
                    onPress={() => shareItem(event.name, event.webUrl)}
                    style={styles.iconButton}
                  >
                    <Ionicons color={colors.primary} name="share-outline" size={20} />
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardPressed: {
    opacity: 0.78
  },
  iconButton: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    height: 42,
    justifyContent: "center",
    width: 42
  },
  iconButtonActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary
  },
  iconRow: {
    flexDirection: "row",
    gap: 10
  },
  item: {
    gap: 8
  },
  section: {
    gap: 10
  }
});
