import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, useColorScheme, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { CategoryChips, type Category } from "@/components/CategoryChips";
import { ErrorState } from "@/components/ErrorState";
import { EventArt } from "@/components/EventArt";
import { FeatureCard } from "@/components/FeatureCard";
import { LoadingState } from "@/components/LoadingState";
import { Screen } from "@/components/Screen";
import { colorsForScheme, type ThemeColors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { rememberPostSignInRoute } from "@/lib/postSignInRoute";
import { EVENT_ART_ACCENT, EVENT_ART_TEXT, EVENT_ART_TEXT_MUTED } from "@/lib/eventArt";
import {
  getPublicEventsForMobile,
  getPublicJobPostingsForMobile,
  getPublicPartnerProfilesForMobile,
  getPublicStudiosForMobile,
  setPublicFavoriteForMobile,
  type PublicEventItem
} from "@/lib/publicDiscovery";

type RouterPushTarget = Parameters<ReturnType<typeof useRouter>["push"]>[0];
type Styles = ReturnType<typeof createStyles>;

function eventAccessibilityLabel(event: PublicEventItem) {
  return [event.name, event.schedule, event.hostName, event.location].filter(Boolean).join(". ");
}

type SaveProps = { onToggleSave: () => void; saving: boolean };

/** The save heart on an event's art: a toggle, separate from the card's own button. */
function SaveHeart({ event, onToggleSave, saving, styles }: SaveProps & { event: PublicEventItem; styles: Styles }) {
  return (
    <Pressable
      accessibilityHint={event.favorited ? "Removes it from your saved events" : "Adds it to your saved events"}
      accessibilityLabel={`Save ${event.name}`}
      accessibilityRole="togglebutton"
      accessibilityState={{ busy: saving, checked: event.favorited }}
      disabled={saving}
      hitSlop={4}
      onPress={onToggleSave}
      style={({ pressed }) => [styles.heart, pressed && styles.pressed]}
      testID={`discover-save-${event.id}`}
    >
      <Ionicons color={event.favorited ? EVENT_ART_ACCENT : EVENT_ART_TEXT} name={event.favorited ? "heart" : "heart-outline"} size={22} />
    </Pressable>
  );
}

function FeaturedEvent({ event, onPress, styles, ...save }: SaveProps & { event: PublicEventItem; onPress: () => void; styles: Styles }) {
  return (
    <View>
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
    <SaveHeart event={event} styles={styles} {...save} />
    </View>
  );
}

function SmallEvent({ event, onPress, styles, ...save }: SaveProps & { event: PublicEventItem; onPress: () => void; styles: Styles }) {
  return (
    <View style={styles.small}>
    <Pressable
      accessibilityHint="Opens the event"
      accessibilityLabel={eventAccessibilityLabel(event)}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.smallCard, pressed && styles.pressed]}
    >
      <EventArt height={104} imageUrl={event.imageUrl} labels={[event.categoryLabel, event.eventType, event.name]} radius={16} />
      <AppText numberOfLines={2} style={styles.smallName}>
        {event.name}
      </AppText>
      <AppText numberOfLines={1} variant="caption">
        {event.schedule}
      </AppText>
    </Pressable>
    <SaveHeart event={event} styles={styles} {...save} />
    </View>
  );
}

export default function DiscoverScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
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
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    // A guest sees public studios and events only; partner and job listings are for signed-in dancers.
    Promise.all([
      getPublicStudiosForMobile(),
      getPublicEventsForMobile(userId),
      userId ? getPublicPartnerProfilesForMobile() : Promise.resolve([]),
      userId ? getPublicJobPostingsForMobile() : Promise.resolve([])
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
  }, [userId]);

  const go = (href: string) => router.push(href as unknown as RouterPushTarget);
  const isGuest = !userId;
  // Sign in, then come back to the screen the visitor was heading for.
  const signInThen = (returnTo: string) =>
    void rememberPostSignInRoute(returnTo).then(() => go("/(auth)/sign-in"));
  const openCategory = (category: Category) =>
    category.guestAllowed || !isGuest ? go(category.href) : signInThen(category.href);
  const openEvent = (event: PublicEventItem) => go(`/events/${event.id}`);
  const setFavorited = (eventId: string, favorited: boolean) =>
    setEvents((current) => current.map((item) => (item.id === eventId ? { ...item, favorited } : item)));

  // The existing user_favorites write (setPublicFavoriteForMobile), shown at once and undone if it fails.
  async function toggleSave(event: PublicEventItem) {
    setSaveMessage(null);
    if (!userId) {
      signInThen("/(tabs)/discover");
      return;
    }
    const next = !event.favorited;
    setSavingId(event.id);
    setFavorited(event.id, next);
    try {
      setFavorited(event.id, await setPublicFavoriteForMobile({ favorited: next, targetId: event.id, targetType: "event", userId }));
    } catch {
      setFavorited(event.id, !next);
      setSaveMessage(next ? "That event could not be saved. Try again." : "That event could not be removed. Try again.");
    } finally {
      setSavingId(null);
    }
  }
  const saveProps = (event: PublicEventItem) => ({ onToggleSave: () => void toggleSave(event), saving: savingId === event.id });
  const categories: Category[] = [
    { key: "events", label: "Events", count: counts.events, href: "/discover/events", guestAllowed: true },
    { key: "studios", label: "Studios", count: counts.studios, href: "/discover/studios", guestAllowed: true },
    { key: "partners", label: "Partners", count: isGuest ? null : counts.partners, href: "/partners" },
    { key: "jobs", label: "Jobs", count: isGuest ? null : counts.jobs, href: "/jobs" },
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

      <CategoryChips categories={categories} loading={loading} onOpen={openCategory} />

      {isGuest ? (
        <FeatureCard
          detail="Browse public events and studios. Sign in to save events, register, and keep tickets handy."
          title="You are exploring as a guest"
        />
      ) : null}
      {isGuest ? <AppButton label="Sign in or create account" onPress={() => signInThen("/(tabs)/discover")} variant="secondary" /> : null}

      {loading ? <LoadingState label="Loading events" rows={2} /> : null}
      {errorMessage ? <ErrorState error={errorMessage} title="Discovery update" /> : null}

      {!loading && featured ? (
        <>
          <FeaturedEvent event={featured} onPress={() => openEvent(featured)} styles={styles} {...saveProps(featured)} />
          {saveMessage ? <ErrorState error={saveMessage} title="Saved events" /> : null}
          {more.length > 0 ? (
            <View style={styles.moreRow}>
              {more.map((event) => (
                <SmallEvent event={event} key={event.id} onPress={() => openEvent(event)} styles={styles} {...saveProps(event)} />
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
    featuredWhen: { color: EVENT_ART_ACCENT, fontSize: 13, fontWeight: "700" },
    featuredName: { color: EVENT_ART_TEXT, fontSize: 27, fontWeight: "800", letterSpacing: -0.5, lineHeight: 31 },
    featuredWhere: { color: EVENT_ART_TEXT_MUTED, fontSize: 14 },
    moreRow: { flexDirection: "row", gap: 12 },
    small: { flex: 1 },
    smallCard: { gap: 6 },
    heart: {
      alignItems: "center",
      backgroundColor: "rgba(24,12,27,0.55)",
      borderRadius: 22,
      height: 44,
      justifyContent: "center",
      position: "absolute",
      right: 8,
      top: 8,
      width: 44
    },
    smallName: { color: colors.text, fontSize: 15, fontWeight: "700", lineHeight: 20 },
    pressed: { opacity: 0.88 }
  });
}
