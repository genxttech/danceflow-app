import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, useColorScheme, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { ErrorState } from "@/components/ErrorState";
import { EventArt } from "@/components/EventArt";
import { FeatureCard } from "@/components/FeatureCard";
import { LoadingState } from "@/components/LoadingState";
import { Screen } from "@/components/Screen";
import { colorsForScheme, type ThemeColors } from "@/constants/theme";
import { EVENT_ART_ACCENT, EVENT_ART_TEXT, EVENT_ART_TEXT_MUTED } from "@/lib/eventArt";
import {
  getPublicEventsForMobile,
  getPublicJobPostingsForMobile,
  getPublicPartnerProfilesForMobile,
  getPublicStudiosForMobile,
  type PublicEventItem
} from "@/lib/publicDiscovery";

type RouterPushTarget = Parameters<ReturnType<typeof useRouter>["push"]>[0];
type Styles = ReturnType<typeof createStyles>;

type Category = { key: string; label: string; count: number | null; href: string };

function eventAccessibilityLabel(event: PublicEventItem) {
  return [event.name, event.schedule, event.hostName, event.location].filter(Boolean).join(". ");
}

function FeaturedEvent({ event, onPress, styles }: { event: PublicEventItem; onPress: () => void; styles: Styles }) {
  return (
    <Pressable
      accessibilityHint="Opens the event"
      accessibilityLabel={eventAccessibilityLabel(event)}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [pressed && styles.pressed]}
      testID="discover-featured"
    >
      <EventArt height={280} imageUrl={event.imageUrl} labels={[event.categoryLabel, event.eventType, event.name]}>
        <AppText style={styles.featuredWhen}>{event.schedule}</AppText>
        <AppText numberOfLines={2} style={styles.featuredName}>
          {event.name}
        </AppText>
        <AppText numberOfLines={1} style={styles.featuredWhere}>
          {[event.hostName, event.location].filter(Boolean).join(" · ")}
        </AppText>
      </EventArt>
    </Pressable>
  );
}

function SmallEvent({ event, onPress, styles }: { event: PublicEventItem; onPress: () => void; styles: Styles }) {
  return (
    <Pressable
      accessibilityHint="Opens the event"
      accessibilityLabel={eventAccessibilityLabel(event)}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.small, pressed && styles.pressed]}
    >
      <EventArt height={104} imageUrl={event.imageUrl} labels={[event.categoryLabel, event.eventType, event.name]} radius={16} />
      <AppText numberOfLines={2} style={styles.smallName}>
        {event.name}
      </AppText>
      <AppText numberOfLines={1} variant="caption">
        {event.schedule}
      </AppText>
    </Pressable>
  );
}

export default function DiscoverScreen() {
  const router = useRouter();
  const colors = colorsForScheme(useColorScheme());
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState({
    events: 0,
    jobs: 0,
    partners: 0,
    studios: 0
  });
  const [events, setEvents] = useState<PublicEventItem[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    Promise.all([
      getPublicStudiosForMobile(),
      getPublicEventsForMobile(),
      getPublicPartnerProfilesForMobile(),
      getPublicJobPostingsForMobile()
    ])
      .then(([studios, nextEvents, partners, jobs]) => {
        if (!mounted) return;
        setCounts({
          events: nextEvents.length,
          jobs: jobs.length,
          partners: partners.length,
          studios: studios.length
        });
        // Same response as the counts: the first few events, in the order the API returns them.
        setEvents(nextEvents.slice(0, 3));
      })
      .catch(() => {
        if (!mounted) return;
        setErrorMessage("Discovery counts are not available yet. You can still browse categories.");
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const go = (href: string) => router.push(href as unknown as RouterPushTarget);
  const openEvent = (event: PublicEventItem) => go(`/events/${event.id}`);
  const categories: Category[] = [
    { key: "events", label: "Events", count: counts.events, href: "/discover/events" },
    { key: "studios", label: "Studios", count: counts.studios, href: "/discover/studios" },
    { key: "partners", label: "Partners", count: counts.partners, href: "/partners" },
    { key: "jobs", label: "Jobs", count: counts.jobs, href: "/jobs" },
    { key: "marketplace", label: "Marketplace", count: null, href: "/discover/marketplace" }
  ];
  const [featured, ...more] = events;

  return (
    <Screen>
      <View style={styles.header}>
        <AppText accessibilityRole="header" variant="display">
          Discover
        </AppText>
        <AppText style={styles.lead}>Socials, classes and studios to dance at next.</AppText>
      </View>

      <Pressable
        accessibilityHint="Opens event search"
        accessibilityLabel="Search events, studios and styles"
        accessibilityRole="search"
        onPress={() => go("/discover/events")}
        style={({ pressed }) => [styles.search, pressed && styles.pressed]}
        testID="discover-search"
      >
        <Ionicons color={colors.muted} name="search-outline" size={20} />
        <AppText style={styles.searchText}>Events, studios, styles</AppText>
      </Pressable>

      <ScrollView contentContainerStyle={styles.chips} horizontal showsHorizontalScrollIndicator={false}>
        {categories.map((category) => (
          <Pressable
            accessibilityLabel={category.count === null ? category.label : `${category.label}, ${category.count}`}
            accessibilityRole="button"
            key={category.key}
            onPress={() => go(category.href)}
            style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
            testID={`discover-chip-${category.key}`}
          >
            <AppText style={styles.chipLabel}>{category.label}</AppText>
            {category.count !== null && !loading ? <AppText style={styles.chipCount}>{category.count}</AppText> : null}
          </Pressable>
        ))}
      </ScrollView>

      {loading ? <LoadingState label="Loading events" rows={2} /> : null}
      {errorMessage ? <ErrorState error={errorMessage} title="Discovery update" /> : null}

      {!loading && featured ? (
        <>
          <FeaturedEvent event={featured} onPress={() => openEvent(featured)} styles={styles} />
          {more.length > 0 ? (
            <View style={styles.moreRow}>
              {more.map((event) => (
                <SmallEvent event={event} key={event.id} onPress={() => openEvent(event)} styles={styles} />
              ))}
            </View>
          ) : null}
          <AppButton label={`All ${counts.events} events`} onPress={() => go("/discover/events")} variant="secondary" />
        </>
      ) : null}

      {!loading && !errorMessage && !featured ? (
        <>
          <FeatureCard detail="Public events appear here as studios publish them." title="No public events yet" />
          <AppButton label="Browse studios" onPress={() => go("/discover/studios")} variant="secondary" />
        </>
      ) : null}
    </Screen>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    header: { gap: 6 },
    lead: { color: colors.muted, fontSize: 17, lineHeight: 24 },
    search: {
      alignItems: "center",
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: 1,
      flexDirection: "row",
      gap: 10,
      minHeight: 48,
      paddingHorizontal: 14
    },
    searchText: { color: colors.muted, fontSize: 15 },
    chips: { gap: 8, paddingRight: 8 },
    chip: {
      alignItems: "center",
      borderColor: colors.borderStrong,
      borderRadius: 22,
      borderWidth: 1,
      flexDirection: "row",
      gap: 6,
      minHeight: 44,
      paddingHorizontal: 16
    },
    chipLabel: { color: colors.text, fontSize: 14, fontWeight: "600" },
    chipCount: { color: colors.muted, fontSize: 13, fontWeight: "600" },
    featuredWhen: { color: EVENT_ART_ACCENT, fontSize: 13, fontWeight: "700" },
    featuredName: { color: EVENT_ART_TEXT, fontSize: 27, fontWeight: "800", letterSpacing: -0.5, lineHeight: 31 },
    featuredWhere: { color: EVENT_ART_TEXT_MUTED, fontSize: 14 },
    moreRow: { flexDirection: "row", gap: 12 },
    small: { flex: 1, gap: 6 },
    smallName: { color: colors.text, fontSize: 15, fontWeight: "700", lineHeight: 20 },
    pressed: { opacity: 0.88 }
  });
}
