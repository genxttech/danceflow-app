import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
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

export default function EventDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const [event, setEvent] = useState<PublicEventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    if (!id) return;

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

  if (loading) {
    return (
      <Screen>
        <FeatureCard title="Loading event" detail="Checking ticket options and registration details." />
      </Screen>
    );
  }

  if (!event || errorMessage) {
    return (
      <Screen>
        <FeatureCard title="Event unavailable" detail={errorMessage ?? "This event could not be found."} />
        <AppButton label="Back to events" onPress={() => router.push("/discover/events" as unknown as RouterPushTarget)} />
      </Screen>
    );
  }

  return (
    <Screen>
      <AppText variant="eyebrow">Event</AppText>
      <AppText variant="title">{event.name}</AppText>
      <AppText variant="caption">{event.hostName}</AppText>
      <AppText>{event.summary ?? "Event details are coming soon."}</AppText>

      <View style={styles.infoCard}>
        <AppText variant="subtitle">When and where</AppText>
        {event.categoryLabel ? (
          <View style={styles.categoryBadge}>
            <AppText style={styles.categoryBadgeText}>{event.categoryLabel}</AppText>
          </View>
        ) : null}
        <AppText variant="caption">{event.schedule}</AppText>
        <AppText variant="caption">{event.location}</AppText>
      </View>

      <View style={styles.infoCard}>
        <AppText variant="subtitle">Tickets</AppText>
        {event.ticketTypes.length === 0 ? (
          <AppText variant="caption">No mobile ticket options are available yet.</AppText>
        ) : (
          event.ticketTypes.map((ticket) => (
            <View key={ticket.id} style={styles.ticketRow}>
              <View style={{ flex: 1 }}>
                <AppText style={styles.ticketName}>{ticket.name}</AppText>
                <AppText variant="caption">
                  {ticket.attendeesPerTicket > 1
                    ? `Admits ${ticket.attendeesPerTicket} attendees`
                    : "Admits 1 attendee"}
                </AppText>
                <AppText style={ticket.remainingAdmissionSpots === 0 ? styles.soldOutText : styles.remainingText}>
                  {remainingSpotsLabel(ticket)}
                </AppText>
              </View>
              <View style={styles.priceBlock}>
                {ticket.isEarlyBird && ticket.regularPrice !== ticket.price ? (
                  <AppText style={styles.regularPrice}>
                    {new Intl.NumberFormat(undefined, {
                      currency: ticket.currency || "USD",
                      style: "currency"
                    }).format(ticket.regularPrice)}
                  </AppText>
                ) : null}
                <AppText style={styles.price}>{ticketPrice(ticket)}</AppText>
                {earlyBirdLabel(ticket) ? (
                  <AppText style={styles.earlyBirdLabel}>{earlyBirdLabel(ticket)}</AppText>
                ) : null}
              </View>
            </View>
          ))
        )}
      </View>

      {event.requiredDocuments.length > 0 ? (
        <View style={styles.infoCard}>
          <AppText variant="subtitle">Required documents</AppText>
          <AppText variant="caption">
            You will review and sign these before checkout.
          </AppText>
          {event.requiredDocuments.map((document) => (
            <AppText key={document.id} style={styles.documentTitle}>
              {document.title}
            </AppText>
          ))}
        </View>
      ) : null}

      {!session ? (
        <FeatureCard
          title="Sign in to register"
          detail="Use your DanceFlow account so tickets can appear in Wallet after payment."
        />
      ) : null}

      <AppButton
        disabled={!session || event.ticketTypes.length === 0}
        label={session ? "Register in app" : "Sign in to register"}
        onPress={() =>
          session
            ? router.push(`/events/${event.id}/register` as unknown as RouterPushTarget)
            : router.push("/(auth)/sign-in" as unknown as RouterPushTarget)
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  categoryBadge: {
    alignSelf: "flex-start",
    backgroundColor: "rgba(244, 63, 142, 0.14)",
    borderColor: "rgba(244, 63, 142, 0.28)",
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  categoryBadgeText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: "900"
  },
  documentTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "800"
  },
  infoCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 8,
    padding: 16
  },
  price: {
    color: colors.primary,
    fontSize: 16,
    fontWeight: "900"
  },
  priceBlock: {
    alignItems: "flex-end",
    gap: 2
  },
  earlyBirdLabel: {
    color: colors.success,
    fontSize: 11,
    fontWeight: "800"
  },
  regularPrice: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: "700",
    textDecorationLine: "line-through"
  },
  remainingText: {
    color: colors.success,
    fontSize: 12,
    fontWeight: "800",
    marginTop: 4
  },
  soldOutText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: "800",
    marginTop: 4
  },
  ticketName: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "800"
  },
  ticketRow: {
    alignItems: "center",
    borderTopColor: colors.border,
    borderTopWidth: 1,
    flexDirection: "row",
    gap: 12,
    paddingTop: 10
  }
});
