import { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, Share, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
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

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

export default function DiscoverEventsScreen() {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [events, setEvents] = useState<PublicEventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

  const filteredEvents = useMemo(() => {
    const search = normalize(query);
    if (!search) return events;

    return events.filter((event) =>
      [event.name, event.hostName, event.location, event.schedule, event.summary].some((value) =>
        normalize(value).includes(search)
      )
    );
  }, [events, query]);

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

      {loading ? <FeatureCard title="Loading events" detail="Finding public dance events." /> : null}
      {message ? <FeatureCard title="Events" detail={message} /> : null}
      {errorMessage ? <FeatureCard title="Events need attention" detail={errorMessage} /> : null}

      {filteredEvents.length ? (
        filteredEvents.map((event) => (
          <View key={event.id} style={styles.eventCard}>
            <View style={styles.cardTop}>
              <View style={{ flex: 1 }}>
                <AppText style={styles.eventTitle}>{event.name}</AppText>
                <AppText variant="caption">
                  {event.hostName} · {event.location}
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
              <AppButton label="Open" onPress={() => Linking.openURL(event.webUrl)} variant="secondary" />
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
