import { useEffect, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  getPublicEventDetailForMobile,
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
  }
});
