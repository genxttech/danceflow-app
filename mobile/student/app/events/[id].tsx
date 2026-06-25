import { useEffect, useState } from "react";
import { Linking, Pressable, Share, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  getPublicEventDetailForMobile,
  setPublicFavoriteForMobile,
  type PublicEventDetail
} from "@/lib/publicDiscovery";

function routeId(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default function EventDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const eventId = routeId(id);
  const { session } = useAuth();
  const router = useRouter();
  const [event, setEvent] = useState<PublicEventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [favoriteMessage, setFavoriteMessage] = useState<string | null>(null);
  const [savingFavorite, setSavingFavorite] = useState(false);

  useEffect(() => {
    let mounted = true;

    if (!eventId) {
      setError("We could not find that event.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    getPublicEventDetailForMobile(eventId, session?.user.id ?? null)
      .then((detail) => {
        if (!mounted) return;
        setEvent(detail);
        if (!detail) setError("This event is no longer available.");
      })
      .catch(() => {
        if (!mounted) return;
        setError("We could not load this event yet. Please try again.");
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [eventId, session?.user.id]);

  async function toggleFavorite() {
    const userId = session?.user.id ?? null;

    if (!event || !userId) {
      setFavoriteMessage("Sign in to save events.");
      return;
    }

    setSavingFavorite(true);
    setFavoriteMessage(null);

    try {
      await setPublicFavoriteForMobile({
        favorited: !event.favorited,
        targetId: event.id,
        targetType: "event",
        userId
      });

      setEvent({ ...event, favorited: !event.favorited });
      setFavoriteMessage(
        !event.favorited ? "Event saved to your favorites." : "Event removed from your favorites."
      );
    } catch {
      setFavoriteMessage("We could not update your favorite yet. Please try again.");
    } finally {
      setSavingFavorite(false);
    }
  }

  async function shareEvent() {
    if (!event) return;

    const url = event.registerUrl || event.webUrl;

    await Share.share({
      title: event.name,
      message: `${event.name}\n${url}`,
      url
    });
  }

  async function openRegistration() {
    if (!event?.registerUrl) return;
    setOpening(true);
    try {
      await Linking.openURL(event.registerUrl);
    } finally {
      setOpening(false);
    }
  }

  return (
    <Screen>
      <AppButton label="Back to Discover" variant="ghost" onPress={() => router.back()} />

      {loading ? (
        <FeatureCard title="Loading event" detail="Getting the latest event details." />
      ) : null}

      {error ? <FeatureCard title="Event unavailable" detail={error} /> : null}

      {event ? (
        <>
          <AppText variant="eyebrow">
            {event.registrationRequired ? "Tickets / registration" : "Event"}
          </AppText>
          <AppText variant="title">{event.name}</AppText>
          <AppText variant="caption">{event.hostName}</AppText>

          <View style={styles.iconRow}>
            <Pressable
              accessibilityLabel={event.favorited ? "Remove saved event" : "Save event"}
              disabled={savingFavorite}
              onPress={toggleFavorite}
              style={[styles.iconButton, event.favorited && styles.iconButtonActive]}
            >
              <Ionicons
                color={event.favorited ? "#fff" : colors.primary}
                name={event.favorited ? "heart" : "heart-outline"}
                size={22}
              />
            </Pressable>
            <Pressable accessibilityLabel="Share event" onPress={shareEvent} style={styles.iconButton}>
              <Ionicons color={colors.primary} name="share-outline" size={22} />
            </Pressable>
          </View>

          {favoriteMessage ? <AppText variant="caption">{favoriteMessage}</AppText> : null}

          <View style={styles.details}>
            <FeatureCard title="When" detail={event.schedule} />
            <FeatureCard title="Where" detail={event.location} />
            {event.summary ? (
              <FeatureCard title="About this event" detail={event.summary} />
            ) : (
              <FeatureCard
                title="About this event"
                detail="More details are available on the event registration page."
              />
            )}
          </View>

          <AppButton
            label={event.registrationRequired ? "Register / Buy Tickets" : "View Event Page"}
            loading={opening}
            onPress={openRegistration}
          />
          <AppText variant="caption">
            Registration opens in DanceFlow so your tickets and receipts stay connected.
          </AppText>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  details: {
    gap: 12
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
