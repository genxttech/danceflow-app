import { useEffect, useMemo, useState } from "react";
import { Pressable, Share, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { useRouter } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  getPublicEventsForMobile,
  setPublicFavoriteForMobile,
  type PublicEventItem
} from "@/lib/publicDiscovery";

type EventWithDistance = PublicEventItem & { distanceMiles: number | null };
type RouterPushTarget = Parameters<ReturnType<typeof useRouter>["push"]>[0];
const RADIUS_OPTIONS = [10, 25, 50, 100];

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function haversineMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
) {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const earthRadiusMiles = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;

  return 2 * earthRadiusMiles * Math.asin(Math.sqrt(a));
}

function formatDistance(distanceMiles: number | null) {
  return distanceMiles !== null ? ` · ${distanceMiles.toFixed(1)} mi` : "";
}

export default function DiscoverEventsScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [events, setEvents] = useState<PublicEventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [radiusMiles, setRadiusMiles] = useState(25);
  const [currentLocation, setCurrentLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);

  async function loadEvents() {
    setLoading(true);
    setErrorMessage(null);

    try {
      setEvents(await getPublicEventsForMobile(userId));
    } catch {
      setErrorMessage("Events are not available yet. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadEvents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const favoriteEvents = useMemo(
    () => events.filter((event) => event.favorited),
    [events]
  );

  const filteredEvents = useMemo<EventWithDistance[]>(() => {
    const search = normalize(query);

    return events
      .map<EventWithDistance>((event) => {
        const distanceMiles =
          currentLocation && event.latitude !== null && event.longitude !== null
            ? haversineMiles(
                currentLocation.latitude,
                currentLocation.longitude,
                event.latitude,
                event.longitude
              )
            : null;

        return { ...event, distanceMiles };
      })
      .filter((event) => {
        if (
          search &&
          ![event.name, event.hostName, event.location, event.schedule, event.summary].some((value) =>
            normalize(value).includes(search)
          )
        ) {
          return false;
        }

        if (currentLocation && event.distanceMiles !== null) {
          return event.distanceMiles <= radiusMiles;
        }

        if (currentLocation && event.distanceMiles === null) {
          return false;
        }

        return true;
      })
      .sort((a, b) => {
        if (a.distanceMiles !== null && b.distanceMiles !== null) {
          return a.distanceMiles - b.distanceMiles;
        }
        if (a.favorited !== b.favorited) return a.favorited ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }, [currentLocation, events, query, radiusMiles]);

  async function useCurrentLocation() {
    setLocationError(null);

    const permission = await Location.requestForegroundPermissionsAsync();
    if (permission.status !== "granted") {
      setLocationError("Location permission was not granted.");
      return;
    }

    const position = await Location.getCurrentPositionAsync({});
    setCurrentLocation({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude
    });
  }

  function clearLocation() {
    setCurrentLocation(null);
    setLocationError(null);
    setRadiusMiles(25);
  }

  async function toggleFavorite(event: PublicEventItem) {
    setMessage(null);
    setErrorMessage(null);

    try {
      const favorited = await setPublicFavoriteForMobile({
        favorited: !event.favorited,
        targetId: event.id,
        targetType: "event",
        userId
      });

      setEvents((current) =>
        current.map((item) => (item.id === event.id ? { ...item, favorited } : item))
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign in to save events.");
    }
  }

  async function shareEvent(event: PublicEventItem) {
    await Share.share({
      message: `${event.name} on DanceFlow: ${event.webUrl}`,
      url: event.webUrl
    });
  }

  return (
    <Screen>
      <View style={styles.hero}>
        <View style={styles.heroIcon}>
          <Ionicons color="#fff" name="ticket-outline" size={24} />
        </View>
        <View style={{ flex: 1 }}>
          <AppText variant="eyebrow">Events</AppText>
          <AppText style={styles.heroTitle}>Find your next dance event</AppText>
          <AppText style={styles.heroDetail}>
            Browse public events, workshops, socials, and classes from DanceFlow studios.
          </AppText>
        </View>
      </View>

      <TextInput
        autoCapitalize="none"
        onChangeText={setQuery}
        placeholder="Search events, hosts, cities, or dates"
        placeholderTextColor={colors.muted}
        style={styles.input}
        value={query}
      />

      <View style={styles.locationRow}>
        <Pressable onPress={useCurrentLocation} style={styles.locationButton}>
          <AppText style={styles.locationButtonText}>Use My Location</AppText>
        </Pressable>
        {currentLocation ? (
          <Pressable onPress={clearLocation} style={styles.clearButton}>
            <AppText style={styles.clearButtonText}>Clear Location</AppText>
          </Pressable>
        ) : null}
      </View>

      {currentLocation ? (
        <View style={styles.segmentRow}>
          {RADIUS_OPTIONS.map((radius) => (
            <Pressable
              key={radius}
              onPress={() => setRadiusMiles(radius)}
              style={[
                styles.radiusButton,
                radiusMiles === radius && styles.radiusButtonActive
              ]}
            >
              <AppText
                style={[
                  styles.radiusText,
                  radiusMiles === radius && styles.radiusTextActive
                ]}
              >
                {radius} mi
              </AppText>
            </Pressable>
          ))}
        </View>
      ) : null}

      {locationError ? <FeatureCard title="Location" detail={locationError} /> : null}

      {loading ? <FeatureCard title="Loading events" detail="Finding public dance events." /> : null}
      {message ? <FeatureCard title="Events" detail={message} /> : null}
      {errorMessage ? <FeatureCard title="Events need attention" detail={errorMessage} /> : null}

      {favoriteEvents.length > 0 ? (
        <View style={styles.sectionHeading}>
          <AppText variant="eyebrow">Favorited Events</AppText>
          <AppText variant="caption">Events you saved to your DanceFlow account.</AppText>
        </View>
      ) : null}

      {favoriteEvents.map((event) => (
        <View key={`favorite-${event.id}`} style={[styles.eventCard, styles.favoriteCard]}>
          <View style={styles.cardTop}>
            <View style={{ flex: 1 }}>
              <AppText style={styles.eventTitle}>{event.name}</AppText>
              <AppText variant="caption">
                {event.hostName} · {event.location}
              </AppText>
            </View>
            <View style={styles.badge}>
              <AppText style={styles.badgeText}>Saved</AppText>
            </View>
          </View>
          <View style={styles.schedulePill}>
            <Ionicons color={colors.primary} name="calendar-outline" size={17} />
            <AppText style={styles.scheduleText}>{event.schedule}</AppText>
          </View>
        </View>
      ))}

      <View style={styles.sectionHeading}>
        <AppText variant="eyebrow">Event Search</AppText>
        <AppText variant="caption">
          {filteredEvents.length} matching event{filteredEvents.length === 1 ? "" : "s"}
          {currentLocation ? ` within ${radiusMiles} miles` : ""}
        </AppText>
      </View>

      {filteredEvents.length ? (
        filteredEvents.map((event) => (
          <View key={event.id} style={styles.eventCard}>
            <View style={styles.cardTop}>
              <View style={{ flex: 1 }}>
                <AppText style={styles.eventTitle}>{event.name}</AppText>
                <AppText variant="caption">
                  {event.hostName} · {event.location}{formatDistance(event.distanceMiles)}
                </AppText>
              </View>
              {event.registrationRequired ? (
                <View style={styles.badge}>
                  <AppText style={styles.badgeText}>Registration</AppText>
                </View>
              ) : null}
            </View>

            <View style={styles.schedulePill}>
              <Ionicons color={colors.primary} name="calendar-outline" size={17} />
              <AppText style={styles.scheduleText}>{event.schedule}</AppText>
            </View>

            {event.summary ? <AppText style={styles.description}>{event.summary}</AppText> : null}

            <View style={styles.actionRow}>
              <AppButton
                label={event.favorited ? "Saved" : "Save"}
                onPress={() => toggleFavorite(event)}
                variant="secondary"
              />
              <AppButton
                label="Open"
                onPress={() => router.push(`/events/${event.id}` as unknown as RouterPushTarget)}
                variant="secondary"
              />
              <Pressable onPress={() => shareEvent(event)} style={styles.iconButton}>
                <Ionicons color={colors.primary} name="share-outline" size={20} />
              </Pressable>
            </View>
          </View>
        ))
      ) : !loading ? (
        <FeatureCard
          title="No events found"
          detail="Try a broader search or check back as more studios publish events."
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  actionRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  badge: {
    backgroundColor: "#fff4e7",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  badgeText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "900"
  },
  cardTop: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 12
  },
  description: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 20
  },
  eventCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    elevation: 2,
    gap: 12,
    padding: 16,
    shadowColor: colors.primaryDark,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.06,
    shadowRadius: 18
  },
  eventTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "900"
  },
  hero: {
    alignItems: "center",
    backgroundColor: colors.primaryDark,
    borderRadius: 22,
    flexDirection: "row",
    gap: 14,
    padding: 18
  },
  heroDetail: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 13,
    lineHeight: 19
  },
  heroIcon: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.16)",
    borderRadius: 999,
    height: 50,
    justifyContent: "center",
    width: 50
  },
  heroTitle: {
    color: "#fff",
    fontSize: 22,
    fontWeight: "900",
    marginBottom: 4
  },
  iconButton: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderRadius: 14,
    height: 44,
    justifyContent: "center",
    width: 48
  },
  clearButton: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  clearButtonText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "800"
  },
  favoriteCard: {
    backgroundColor: colors.surfaceAlt
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 12
  },
  locationButton: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  locationButtonText: {
    color: colors.primary,
    fontSize: 14,
    fontWeight: "800"
  },
  locationRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  radiusButton: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8
  },
  radiusButtonActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary
  },
  radiusText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700"
  },
  radiusTextActive: {
    color: "#fff"
  },
  sectionHeading: {
    gap: 4,
    paddingHorizontal: 2,
    paddingTop: 6
  },
  segmentRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  schedulePill: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: colors.surfaceAlt,
    borderRadius: 999,
    flexDirection: "row",
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 7
  },
  scheduleText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: "900"
  }
});
