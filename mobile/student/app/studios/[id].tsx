import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  getPublicStudioDetailForMobile,
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

          <FeatureCard
            title="About this studio"
            detail={studio.description || "This studio is listed on DanceFlow discovery."}
          />

          <View style={styles.sectionHeading}>
            <AppText style={styles.sectionTitle}>Upcoming events</AppText>
            <AppText variant="caption">
              Tap an event to see details or register.
            </AppText>
          </View>

          {studio.upcomingEvents.length ? (
            studio.upcomingEvents.map((event) => (
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
  }
});
