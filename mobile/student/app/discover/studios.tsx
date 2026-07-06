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
  getPublicStudiosForMobile,
  setPublicFavoriteForMobile,
  type PublicStudioItem
} from "@/lib/publicDiscovery";

type StudioWithDistance = PublicStudioItem & { distanceMiles: number | null };
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

export default function DiscoverStudiosScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [studios, setStudios] = useState<PublicStudioItem[]>([]);
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

  async function loadStudios() {
    setLoading(true);
    setErrorMessage(null);

    try {
      setStudios(await getPublicStudiosForMobile(userId));
    } catch {
      setErrorMessage("Studios are not available yet. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStudios();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const favoriteStudios = useMemo(
    () => studios.filter((studio) => studio.favorited),
    [studios]
  );

  const filteredStudios = useMemo<StudioWithDistance[]>(() => {
    const search = normalize(query);

    return studios
      .map<StudioWithDistance>((studio) => {
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
        if (
          search &&
          ![studio.name, studio.description, studio.location, studio.city, studio.state].some((value) =>
            normalize(value).includes(search)
          )
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
  }, [currentLocation, query, radiusMiles, studios]);

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

  async function toggleFavorite(studio: PublicStudioItem) {
    setMessage(null);
    setErrorMessage(null);

    try {
      const favorited = await setPublicFavoriteForMobile({
        favorited: !studio.favorited,
        targetId: studio.id,
        targetType: "studio",
        userId
      });

      setStudios((current) =>
        current.map((item) => (item.id === studio.id ? { ...item, favorited } : item))
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Sign in to save studios.");
    }
  }

  async function shareStudio(studio: PublicStudioItem) {
    await Share.share({
      message: `${studio.name} on DanceFlow: ${studio.webUrl}`,
      url: studio.webUrl
    });
  }

  return (
    <Screen>
      <View style={styles.hero}>
        <View style={styles.heroIcon}>
          <Ionicons color="#fff" name="business-outline" size={24} />
        </View>
        <View style={{ flex: 1 }}>
          <AppText variant="eyebrow">Studios</AppText>
          <AppText style={styles.heroTitle}>Find your dance home</AppText>
          <AppText style={styles.heroDetail}>
            Search public DanceFlow studios by name, city, and beginner-friendly profile details.
          </AppText>
        </View>
      </View>

      <TextInput
        autoCapitalize="none"
        onChangeText={setQuery}
        placeholder="Search studios, cities, or states"
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

      {loading ? <FeatureCard title="Loading studios" detail="Finding public studio profiles." /> : null}
      {message ? <FeatureCard title="Studios" detail={message} /> : null}
      {errorMessage ? <FeatureCard title="Studios need attention" detail={errorMessage} /> : null}

      {favoriteStudios.length > 0 ? (
        <View style={styles.sectionHeading}>
          <AppText variant="eyebrow">Favorited Studios</AppText>
          <AppText variant="caption">Studios you saved to your DanceFlow account.</AppText>
        </View>
      ) : null}

      {favoriteStudios.map((studio) => (
        <View key={`favorite-${studio.id}`} style={[styles.studioCard, styles.favoriteCard]}>
          <View style={styles.cardTop}>
            <View style={{ flex: 1 }}>
              <AppText style={styles.studioTitle}>{studio.name}</AppText>
              <AppText variant="caption">{studio.location}</AppText>
            </View>
            <Pressable
              accessibilityLabel="Remove studio from favorites"
              accessibilityRole="button"
              onPress={() => toggleFavorite(studio)}
              style={({ pressed }) => [
                styles.heartButton,
                styles.heartButtonActive,
                pressed && styles.cardPressed
              ]}
            >
              <Ionicons color="#EF4444" name="heart" size={22} />
            </Pressable>
          </View>
          {studio.description ? <AppText style={styles.description}>{studio.description}</AppText> : null}
        </View>
      ))}

      <View style={styles.sectionHeading}>
        <AppText variant="eyebrow">Studio Search</AppText>
        <AppText variant="caption">
          {filteredStudios.length} matching studio{filteredStudios.length === 1 ? "" : "s"}
          {currentLocation ? ` within ${radiusMiles} miles` : ""}
        </AppText>
      </View>

      {filteredStudios.length ? (
        filteredStudios.map((studio) => (
          <View key={studio.id} style={styles.studioCard}>
            <View style={styles.cardTop}>
              <View style={{ flex: 1 }}>
                <AppText style={styles.studioTitle}>{studio.name}</AppText>
                <AppText variant="caption">{studio.location}{formatDistance(studio.distanceMiles)}</AppText>
              </View>
              <View style={styles.cardActions}>
                {studio.beginnerFriendly ? (
                  <View style={styles.badge}>
                    <AppText style={styles.badgeText}>Beginner friendly</AppText>
                  </View>
                ) : null}
                <Pressable
                  accessibilityLabel={studio.favorited ? "Remove studio from favorites" : "Add studio to favorites"}
                  accessibilityRole="button"
                  onPress={() => toggleFavorite(studio)}
                  style={({ pressed }) => [
                    styles.heartButton,
                    studio.favorited && styles.heartButtonActive,
                    pressed && styles.cardPressed
                  ]}
                >
                  <Ionicons
                    color={studio.favorited ? "#EF4444" : colors.muted}
                    name={studio.favorited ? "heart" : "heart-outline"}
                    size={22}
                  />
                </Pressable>
              </View>
            </View>

            {studio.description ? (
              <AppText style={styles.description}>{studio.description}</AppText>
            ) : null}

            <View style={styles.actionRow}>
              <AppButton
                label="Open"
                onPress={() => router.push(`/studios/${studio.id}` as unknown as RouterPushTarget)}
                variant="secondary"
              />
              <Pressable onPress={() => shareStudio(studio)} style={styles.iconButton}>
                <Ionicons color={colors.primary} name="share-outline" size={20} />
              </Pressable>
            </View>
          </View>
        ))
      ) : !loading ? (
        <FeatureCard
          title="No studios found"
          detail="Try a broader search or check back as more studios publish public profiles."
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
  cardActions: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8
  },
  cardPressed: {
    opacity: 0.78
  },
  description: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 20
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
  heartButton: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    height: 42,
    justifyContent: "center",
    width: 42
  },
  heartButtonActive: {
    backgroundColor: "rgba(239, 68, 68, 0.12)",
    borderColor: "rgba(239, 68, 68, 0.35)"
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
  studioCard: {
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
  studioTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "900"
  }
});
