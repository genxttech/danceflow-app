import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, useColorScheme, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { EventArt } from "@/components/EventArt";
import { FeatureCard } from "@/components/FeatureCard";
import { LoadingState } from "@/components/LoadingState";
import { ErrorState } from "@/components/ErrorState";
import { Screen } from "@/components/Screen";
import { colorsForScheme, type ThemeColors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  getPublicEventDetailForMobile,
  type PublicEventDetail
} from "@/lib/publicDiscovery";

type RouterPushTarget = Parameters<ReturnType<typeof useRouter>["push"]>[0];

function ticketPrice(ticket: PublicEventDetail["ticketTypes"][number]) {
  return new Intl.NumberFormat(undefined, {
    currency: ticket.currency || "USD",
    style: "currency"
  }).format(ticket.price);
}

function earlyBirdLabel(ticket: PublicEventDetail["ticketTypes"][number]) {
  if (!ticket.isEarlyBird) return null;

  if (!ticket.earlyBirdEndsAt) return "Early bird";

  const date = new Date(ticket.earlyBirdEndsAt);
  if (Number.isNaN(date.getTime())) return "Early bird";

  return `Early bird ends ${date.toLocaleDateString()}`;
}

function remainingSpotsLabel(ticket: PublicEventDetail["ticketTypes"][number]) {
  if (ticket.remainingAdmissionSpots === null) return "Admission spots available";
  if (ticket.remainingAdmissionSpots === 0) return "Sold out";

  return `${ticket.remainingAdmissionSpots} admission spot${ticket.remainingAdmissionSpots === 1 ? "" : "s"} left`;
}

/** The lowest ticket price, formatted, for the bottom bar. */
function fromPrice(event: PublicEventDetail) {
  const available = event.ticketTypes.filter((ticket) => ticket.remainingAdmissionSpots !== 0);
  const cheapest = (available.length ? available : event.ticketTypes).reduce<PublicEventDetail["ticketTypes"][number] | null>(
    (best, ticket) => (best === null || ticket.price < best.price ? ticket : best),
    null
  );
  return cheapest ? ticketPrice(cheapest) : null;
}

export default function EventDetailScreen() {
  const colors = colorsForScheme(useColorScheme());
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const [event, setEvent] = useState<PublicEventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    if (!id) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect -- loading flag for a fetch keyed on the route id
    setLoading(true);
    getPublicEventDetailForMobile(id, session?.user.id)
      .then((detail) => {
        if (!mounted) return;
        setEvent(detail);
      })
      .catch(() => {
        if (!mounted) return;
        setErrorMessage("This event could not be loaded.");
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [id, session?.user.id]);

  const goBack = () =>
    router.canGoBack() ? router.back() : router.push("/(tabs)/discover" as unknown as RouterPushTarget);

  if (loading) {
    return (
      <Screen>
        <LoadingState label="Loading event" />
      </Screen>
    );
  }

  if (!event || errorMessage) {
    return (
      <Screen>
        <ErrorState error={errorMessage} fallback="This event could not be found." title="Event unavailable" />
        <AppButton label="Back to events" onPress={() => router.push("/discover/events" as unknown as RouterPushTarget)} />
      </Screen>
    );
  }

  const price = fromPrice(event);

  return (
    <View style={styles.page}>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <EventArt height={320} imageUrl={event.imageUrl} labels={[event.categoryLabel, event.eventType, event.name]} radius={0} testID="event-hero" />
        <SafeAreaView edges={["top"]} pointerEvents="box-none" style={styles.heroControls}>
          <Pressable
            accessibilityLabel="Back"
            accessibilityRole="button"
            hitSlop={4}
            onPress={goBack}
            style={({ pressed }) => [styles.roundButton, pressed && styles.pressed]}
            testID="event-back"
          >
            <Ionicons color="#FBF3EE" name="chevron-back" size={22} />
          </Pressable>
        </SafeAreaView>

        <View style={styles.body}>
          <View style={styles.titleBlock}>
            <AppText style={styles.when}>{event.schedule}</AppText>
            <AppText accessibilityRole="header" variant="display">
              {event.name}
            </AppText>
            <AppText style={styles.where}>{[event.location, event.hostName].filter(Boolean).join(" · ")}</AppText>
            {event.categoryLabel ? (
              <View style={styles.categoryBadge}>
                <AppText style={styles.categoryBadgeText}>{event.categoryLabel}</AppText>
              </View>
            ) : null}
          </View>

          <AppText style={styles.summary}>{event.summary ?? "Event details are coming soon."}</AppText>

          <View style={styles.section}>
            <AppText accessibilityRole="header" style={styles.sectionTitle}>
              Tickets
            </AppText>
            {event.ticketTypes.length === 0 ? (
              <AppText variant="caption">No mobile ticket options are available yet.</AppText>
            ) : (
              event.ticketTypes.map((ticket) => (
                <View key={ticket.id} style={styles.ticketRow}>
                  <View style={styles.ticketCopy}>
                    <AppText style={styles.ticketName}>{ticket.name}</AppText>
                    <AppText variant="caption">
                      {ticket.attendeesPerTicket > 1 ? `Admits ${ticket.attendeesPerTicket}` : "Admits 1"}
                      {earlyBirdLabel(ticket) ? ` · ${earlyBirdLabel(ticket)}` : ""}
                    </AppText>
                    <AppText style={ticket.remainingAdmissionSpots === 0 ? styles.soldOutText : styles.remainingText}>
                      {remainingSpotsLabel(ticket)}
                    </AppText>
                  </View>
                  <View style={styles.priceBlock}>
                    <AppText style={styles.price}>{ticketPrice(ticket)}</AppText>
                    {ticket.isEarlyBird && ticket.regularPrice !== ticket.price ? (
                      <AppText accessibilityLabel={`Regular price ${new Intl.NumberFormat(undefined, { currency: ticket.currency || "USD", style: "currency" }).format(ticket.regularPrice)}`} style={styles.regularPrice}>
                        {new Intl.NumberFormat(undefined, {
                          currency: ticket.currency || "USD",
                          style: "currency"
                        }).format(ticket.regularPrice)}
                      </AppText>
                    ) : null}
                  </View>
                </View>
              ))
            )}
          </View>

          {event.requiredDocuments.length > 0 ? (
            <View style={styles.section}>
              <AppText accessibilityRole="header" style={styles.sectionTitle}>
                Before checkout
              </AppText>
              <AppText variant="caption">You will review and sign these first.</AppText>
              {event.requiredDocuments.map((document) => (
                <AppText key={document.id} style={styles.documentTitle}>
                  {document.title}
                </AppText>
              ))}
            </View>
          ) : null}

          {!session ? (
            <FeatureCard detail="Use your DanceFlow account so tickets can appear in Wallet after payment." title="Sign in to register" />
          ) : null}
        </View>
      </ScrollView>

      <SafeAreaView edges={["bottom"]} style={styles.bar} testID="event-bar">
        {price ? (
          <View accessible accessibilityLabel={`Tickets from ${price}`} style={styles.barPrice}>
            <AppText variant="caption">From</AppText>
            <AppText style={styles.barPriceValue}>{price}</AppText>
          </View>
        ) : null}
        <AppButton
          disabled={!session || event.ticketTypes.length === 0}
          label={session ? "Register in app" : "Sign in to register"}
          onPress={() =>
            session
              ? router.push(`/events/${event.id}/register` as unknown as RouterPushTarget)
              : router.push("/(auth)/sign-in" as unknown as RouterPushTarget)
          }
          style={styles.barButton}
        />
      </SafeAreaView>
    </View>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    page: { backgroundColor: colors.background, flex: 1 },
    scroll: { paddingBottom: 24 },
    heroControls: { left: 0, paddingHorizontal: 16, paddingTop: 8, position: "absolute", right: 0, top: 0 },
    roundButton: {
      alignItems: "center",
      backgroundColor: "rgba(24,12,27,0.6)",
      borderRadius: 22,
      height: 44,
      justifyContent: "center",
      width: 44
    },
    body: { gap: 20, paddingHorizontal: 20, paddingTop: 20 },
    titleBlock: { gap: 8 },
    when: { color: colors.primary, fontSize: 15, fontWeight: "700" },
    where: { color: colors.muted, fontSize: 15, lineHeight: 21 },
    categoryBadge: {
      alignSelf: "flex-start",
      borderColor: colors.borderStrong,
      borderRadius: 999,
      borderWidth: 1,
      paddingHorizontal: 12,
      paddingVertical: 6
    },
    categoryBadgeText: { color: colors.text, fontSize: 13, fontWeight: "600" },
    summary: { color: colors.text, fontSize: 16, lineHeight: 24 },
    section: { gap: 4 },
    sectionTitle: { color: colors.text, fontSize: 17, fontWeight: "700", marginBottom: 4 },
    documentTitle: { color: colors.text, fontSize: 15, fontWeight: "600" },
    ticketRow: {
      alignItems: "center",
      borderBottomColor: colors.border,
      borderBottomWidth: 1,
      flexDirection: "row",
      gap: 12,
      paddingVertical: 12
    },
    ticketCopy: { flex: 1, gap: 2 },
    ticketName: { color: colors.text, fontSize: 16, fontWeight: "700" },
    priceBlock: { alignItems: "flex-end", gap: 2 },
    price: { color: colors.primary, fontSize: 17, fontVariant: ["tabular-nums"], fontWeight: "800" },
    regularPrice: { color: colors.muted, fontSize: 13, textDecorationLine: "line-through" },
    remainingText: { color: colors.success, fontSize: 13, fontWeight: "600" },
    soldOutText: { color: colors.danger, fontSize: 13, fontWeight: "700" },
    bar: {
      alignItems: "center",
      backgroundColor: colors.surface,
      borderTopColor: colors.border,
      borderTopWidth: 1,
      flexDirection: "row",
      gap: 16,
      paddingHorizontal: 20,
      paddingTop: 12
    },
    barPrice: { paddingBottom: 12 },
    barPriceValue: { color: colors.text, fontSize: 20, fontVariant: ["tabular-nums"], fontWeight: "800" },
    barButton: { flex: 1, marginBottom: 12 },
    pressed: { opacity: 0.88 }
  });
}
