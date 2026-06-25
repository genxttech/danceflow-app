import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import * as Location from "expo-location";
import { Pressable, StyleSheet, TextInput, View } from "react-native";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  getPublicEventsForMobile,
  getPublicStudiosForMobile,
  type PublicEventItem,
  type PublicStudioItem
} from "@/lib/publicDiscovery";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";

type ResultMode = "all" | "studios" | "events";

type ResultWithDistance<T> = T & { distanceMiles: number | null };

const RADIUS_OPTIONS = [10, 25, 50, 100];
const DEFAULT_PREVIEW_LIMIT = 5;
const ACTIVE_RESULT_LIMIT = 25;

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function matchesText(values: Array<string | null | undefined>, query: string) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return true;

  return values.some((value) => normalize(value).includes(normalizedQuery));
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

function SectionHeading({
  detail,
  title
}: {
  detail?: string;
  title: string;
}) {
  return (
    <View style={styles.sectionHeading}>
      <AppText style={styles.sectionTitle}>{title}</AppText>
      {detail ? <AppText variant="caption">{detail}</AppText> : null}
    </View>
  );
}

export default function DiscoverScreen() {
  const { session } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [studios, setStudios] = useState<PublicStudioItem[]>([]);
  const [events, setEvents] = useState<PublicEventItem[]>([]);
  const [query, setQuery] = useState("");
  const [cityState, setCityState] = useState("");
  const [mode, setMode] = useState<ResultMode>("all");
  const [beginnerOnly, setBeginnerOnly] = useState(false);
  const [radiusMiles, setRadiusMiles] = useState(25);
  const [currentLocation, setCurrentLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);

  useEffect(() => {
    let mounted = true;
    const userId = session?.user.id ?? null;

    setLoading(true);
    setError(null);

    Promise.all([
      userId ? getStudentAccess(userId) : Promise.resolve(null),
      getPublicStudiosForMobile(userId),
      getPublicEventsForMobile(userId)
    ])
      .then(([access, publicStudios, publicEvents]) => {
        if (!mounted) return;
        setLinkedStudios(access?.linkedStudios ?? []);
        setStudios(publicStudios);
        setEvents(publicEvents);
      })
      .catch((err) => {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : "Could not load discovery.");
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [session?.user.id]);

  const favoriteStudios = studios.filter((studio) => studio.favorited);
  const favoriteEvents = events.filter((event) => event.favorited);
  const manualLocation = normalize(cityState);
  const hasActiveDiscoveryIntent =
    normalize(query).length > 0 ||
    manualLocation.length > 0 ||
    currentLocation !== null ||
    mode !== "all" ||
    beginnerOnly;

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

  function clearFilters() {
    setQuery("");
    setCityState("");
    setMode("all");
    setBeginnerOnly(false);
    setCurrentLocation(null);
    setLocationError(null);
    setRadiusMiles(25);
  }

  const filteredStudios = studios
    .map<ResultWithDistance<PublicStudioItem>>((studio) => {
      const distanceMiles =
        currentLocation && studio.latitude !== null && studio.longitude !== null
          ? haversineMiles(
              currentLocation.latitude,
              currentLocation.longitude,
              studio.latitude,
              studio.longitude
            )
          : null;

      return { ...studio, distanceMiles };
    })
    .filter((studio) => {
      if (mode === "events") return false;
      if (beginnerOnly && !studio.beginnerFriendly) return false;
      if (!matchesText([studio.name, studio.description, studio.city, studio.state], query)) {
        return false;
      }
      if (
        manualLocation &&
        !matchesText([studio.city, studio.state, studio.location], manualLocation)
      ) {
        return false;
      }
      if (currentLocation && studio.distanceMiles !== null) {
        return studio.distanceMiles <= radiusMiles;
      }
      if (currentLocation && studio.distanceMiles === null) {
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

  const filteredEvents = events
    .map<ResultWithDistance<PublicEventItem>>((event) => {
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
      if (mode === "studios") return false;
      if (beginnerOnly && !event.beginnerFriendly) return false;
      if (
        !matchesText(
          [event.name, event.hostName, event.summary, event.location, event.schedule],
          query
        )
      ) {
        return false;
      }
      if (manualLocation && !matchesText([event.location], manualLocation)) {
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

  const visibleStudios = filteredStudios.slice(
    0,
    hasActiveDiscoveryIntent ? ACTIVE_RESULT_LIMIT : DEFAULT_PREVIEW_LIMIT
  );
  const visibleEvents = filteredEvents.slice(
    0,
    hasActiveDiscoveryIntent ? ACTIVE_RESULT_LIMIT : DEFAULT_PREVIEW_LIMIT
  );
  const resultSummary = `${filteredStudios.length} studio${
    filteredStudios.length === 1 ? "" : "s"
  } · ${filteredEvents.length} event${filteredEvents.length === 1 ? "" : "s"}`;

  return (
    <Screen>
      <AppText variant="eyebrow">Discover</AppText>
      <AppText variant="title">Find dance near you</AppText>
      <AppText variant="caption">
        Search by city, studio, event, organizer, or dance style. Discovery stays open
        whether you already dance with a studio or are exploring on your own.
      </AppText>

      <View style={styles.filters}>
        <TextInput
          autoCapitalize="none"
          onChangeText={setQuery}
          placeholder="Search studio, event, organizer, or style"
          placeholderTextColor={colors.muted}
          style={styles.input}
          value={query}
        />
        <TextInput
          autoCapitalize="words"
          onChangeText={setCityState}
          placeholder="City or state"
          placeholderTextColor={colors.muted}
          style={styles.input}
          value={cityState}
        />

        <View style={styles.segmentRow}>
          {(["all", "studios", "events"] as ResultMode[]).map((item) => (
            <Pressable
              key={item}
              onPress={() => setMode(item)}
              style={[styles.segmentButton, mode === item && styles.segmentButtonActive]}
            >
              <AppText style={[styles.segmentText, mode === item && styles.segmentTextActive]}>
                {item === "all" ? "All" : item === "studios" ? "Studios" : "Events"}
              </AppText>
            </Pressable>
          ))}
          <Pressable
            onPress={() => setBeginnerOnly((value) => !value)}
            style={[styles.segmentButton, beginnerOnly && styles.segmentButtonActive]}
          >
            <AppText
              style={[styles.segmentText, beginnerOnly && styles.segmentTextActive]}
            >
              Beginner-friendly
            </AppText>
          </Pressable>
        </View>

        <View style={styles.locationRow}>
          <Pressable onPress={useCurrentLocation} style={styles.locationButton}>
            <AppText style={styles.locationButtonText}>Use current location</AppText>
          </Pressable>
          {hasActiveDiscoveryIntent ? (
            <Pressable onPress={clearFilters} style={styles.clearButton}>
              <AppText style={styles.clearButtonText}>Clear filters</AppText>
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
                  radiusMiles === radius && styles.segmentButtonActive
                ]}
              >
                <AppText
                  style={[
                    styles.segmentText,
                    radiusMiles === radius && styles.segmentTextActive
                  ]}
                >
                  {radius} mi
                </AppText>
              </Pressable>
            ))}
          </View>
        ) : null}

        {locationError ? (
          <AppText style={styles.errorText}>{locationError}</AppText>
        ) : null}
      </View>

      {loading ? (
        <FeatureCard title="Loading discovery" detail="Finding studios and events." />
      ) : null}

      {error ? <FeatureCard title="Discovery needs attention" detail={error} /> : null}

      {!loading && !error ? (
        <>
          {linkedStudios.length ? (
            <FeatureCard
              label="Your studios"
              title="Your studios"
              detail={linkedStudios
                .map((studio) => studio.studioPublicName || studio.studioName)
                .join(", ")}
            />
          ) : null}

          {favoriteStudios.length || favoriteEvents.length ? (
            <FeatureCard
              label="Saved"
              title="Favorites"
              detail={[
                favoriteStudios.length
                  ? `${favoriteStudios.length} saved studio${favoriteStudios.length === 1 ? "" : "s"}`
                  : null,
                favoriteEvents.length
                  ? `${favoriteEvents.length} saved event${favoriteEvents.length === 1 ? "" : "s"}`
                  : null
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          ) : null}

          <FeatureCard
            label={hasActiveDiscoveryIntent ? "Results" : "Start here"}
            title={hasActiveDiscoveryIntent ? "Matching discovery results" : "Search-first discovery"}
            detail={
              hasActiveDiscoveryIntent
                ? resultSummary
                : "Use search, city/state, current location, or filters to see the full matching catalog. A small preview is shown below."
            }
          />

          {visibleStudios.length ? (
            <>
              <SectionHeading
                title={hasActiveDiscoveryIntent ? "Studios" : "Featured studios"}
                detail={
                  hasActiveDiscoveryIntent
                    ? `${filteredStudios.length} matching studio${filteredStudios.length === 1 ? "" : "s"}`
                    : "A short preview. Search or use your location to see more."
                }
              />
              {visibleStudios.map((studio) => (
                <Pressable
                  key={studio.id}
                  onPress={() =>
  router.push({
    pathname: "/studios/[id]",
    params: { id: studio.id },
  })
}
                  style={({ pressed }) => [pressed && styles.cardPressed]}
                >
                  <FeatureCard
                    label={
                      studio.favorited
                        ? "Saved studio"
                        : studio.beginnerFriendly
                          ? "Beginner friendly"
                          : "Studio"
                    }
                    title={studio.name}
                    detail={`${studio.location}${formatDistance(studio.distanceMiles)}${
                      studio.description ? ` · ${studio.description}` : ""
                    } · Tap for details`}
                  />
                </Pressable>
              ))}
            </>
          ) : null}

          {visibleEvents.length ? (
            <>
              <SectionHeading
                title={hasActiveDiscoveryIntent ? "Events" : "Upcoming events"}
                detail={
                  hasActiveDiscoveryIntent
                    ? `${filteredEvents.length} matching event${filteredEvents.length === 1 ? "" : "s"}`
                    : "A short preview. Search or use your location to see more."
                }
              />
              {visibleEvents.map((event) => (
                <Pressable
                  key={event.id}
                  onPress={() =>
  router.push({
    pathname: "/events/[id]",
    params: { id: event.id },
  })
}
                  style={({ pressed }) => [pressed && styles.cardPressed]}
                >
                  <FeatureCard
                    label={
                      event.favorited
                        ? "Saved event"
                        : event.registrationRequired
                          ? "Tickets / registration"
                          : "Event"
                    }
                    title={event.name}
                    detail={`${event.hostName} · ${event.schedule} · ${event.location}${formatDistance(
                      event.distanceMiles
                    )}${event.summary ? ` · ${event.summary}` : ""} · Tap for details`}
                  />
                </Pressable>
              ))}
            </>
          ) : null}

          {hasActiveDiscoveryIntent && !visibleStudios.length && !visibleEvents.length ? (
            <FeatureCard
              title="No matches yet"
              detail="Try a broader city, remove beginner-friendly, increase the radius, or clear filters."
            />
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  filters: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 12,
    padding: 14
  },
  input: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 12
  },
  segmentRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  segmentButton: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9
  },
  segmentButtonActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary
  },
  segmentText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "700"
  },
  segmentTextActive: {
    color: "#fff"
  },
  locationRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
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
  radiusButton: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8
  },
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
  errorText: {
    color: colors.danger,
    fontSize: 14
  }
});
