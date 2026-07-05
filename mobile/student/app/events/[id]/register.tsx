import { useEffect, useMemo, useState } from "react";
import { Linking, StyleSheet, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { createStudentEventCheckout } from "@/lib/eventCheckout";
import { useAuth } from "@/lib/auth";
import {
  getPublicEventDetailForMobile,
  type PublicEventDetail,
  type PublicEventTicketType
} from "@/lib/publicDiscovery";

function formatCurrency(value: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    currency: currency || "USD",
    style: "currency"
  }).format(value);
}

function attendeeRequestCount(ticket: PublicEventTicketType, quantity: number) {
  return Math.max(0, quantity * ticket.attendeesPerTicket - 1);
}

function eventCheckoutReturnUrl() {
  return "danceflow://events/orders/pending?checkout=event";
}

function earlyBirdLabel(ticket: PublicEventTicketType) {
  if (!ticket.isEarlyBird) return null;

  if (!ticket.earlyBirdEndsAt) return "Early bird";

  const date = new Date(ticket.earlyBirdEndsAt);
  if (Number.isNaN(date.getTime())) return "Early bird";

  return `Early bird ends ${date.toLocaleDateString()}`;
}

function remainingSpotsLabel(ticket: PublicEventTicketType) {
  if (ticket.remainingAdmissionSpots === null) return "Admission spots available";
  if (ticket.remainingAdmissionSpots === 0) return "Sold out";

  return `${ticket.remainingAdmissionSpots} admission spot${ticket.remainingAdmissionSpots === 1 ? "" : "s"} left`;
}

export default function EventRegisterScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const [event, setEvent] = useState<PublicEventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [buyerFirstName, setBuyerFirstName] = useState("");
  const [buyerLastName, setBuyerLastName] = useState("");
  const [buyerPhone, setBuyerPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [additionalAttendeeNames, setAdditionalAttendeeNames] = useState<string[]>([]);
  const [documentSignatureName, setDocumentSignatureName] = useState("");
  const [documentConsentAccepted, setDocumentConsentAccepted] = useState(false);

  useEffect(() => {
    let mounted = true;

    if (!id) return;

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

  const selectedTickets = useMemo(() => {
    if (!event) return [];
    return event.ticketTypes
      .map((ticket) => ({
        ticket,
        quantity: Math.max(0, Number(quantities[ticket.id] ?? 0) || 0)
      }))
      .filter((selection) => selection.quantity > 0);
  }, [event, quantities]);

  const additionalNameCount = selectedTickets.reduce(
    (sum, selection) => sum + attendeeRequestCount(selection.ticket, selection.quantity),
    0
  );

  const total = selectedTickets.reduce(
    (sum, selection) => sum + selection.ticket.price * selection.quantity,
    0
  );
  const currency = selectedTickets[0]?.ticket.currency ?? "USD";

  function setQuantity(ticketId: string, value: string) {
    const parsed = Number.parseInt(value, 10);
    setQuantities((current) => ({
      ...current,
      [ticketId]: Number.isFinite(parsed) && parsed > 0 ? parsed : 0
    }));
  }

  function setAdditionalName(index: number, value: string) {
    setAdditionalAttendeeNames((current) => {
      const next = [...current];
      next[index] = value;
      return next;
    });
  }

  async function submitCheckout() {
    if (!event || !session) return;

    setSubmitting(true);
    setErrorMessage(null);

    try {
      const trimmedAdditionalNames = Array.from({ length: additionalNameCount }, (_, index) =>
        (additionalAttendeeNames[index] ?? "").trim()
      );

      if (!buyerFirstName.trim() || !buyerLastName.trim()) {
        throw new Error("Enter your first and last name.");
      }

      if (selectedTickets.length === 0) {
        throw new Error("Select at least one ticket.");
      }

      if (trimmedAdditionalNames.some((name) => !name)) {
        throw new Error("Add all additional attendee names.");
      }

      if (event.requiredDocuments.length > 0) {
        if (!documentConsentAccepted || documentSignatureName.trim().length < 2) {
          throw new Error("Review and sign the required event documents.");
        }
      }

      const returnUrl = eventCheckoutReturnUrl();

      const result = await createStudentEventCheckout({
        additionalAttendeeNames: trimmedAdditionalNames,
        buyerFirstName: buyerFirstName.trim(),
        buyerLastName: buyerLastName.trim(),
        buyerPhone: buyerPhone.trim(),
        documentConsentAccepted,
        documentRequirementIds: event.requiredDocuments.map((document) => document.id),
        documentSignatureName: documentSignatureName.trim(),
        eventId: event.id,
        notes: notes.trim(),
        returnUrl,
        ticketSelections: selectedTickets.map((selection) => ({
          ticketTypeId: selection.ticket.id,
          quantity: selection.quantity
        }))
      });

      if (result.completed || !result.checkoutUrl) {
        router.replace(`/events/orders/${result.orderId}`);
        return;
      }

      await Linking.openURL(result.checkoutUrl);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Checkout could not be started.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <Screen>
        <FeatureCard title="Loading checkout" detail="Checking ticket options." />
      </Screen>
    );
  }

  if (!session) {
    return (
      <Screen>
        <FeatureCard
          title="Sign in required"
          detail="Use your DanceFlow account so paid tickets can be saved to Wallet."
        />
        <AppButton label="Sign in" onPress={() => router.push("/(auth)/sign-in")} />
      </Screen>
    );
  }

  if (!event) {
    return (
      <Screen>
        <FeatureCard title="Event unavailable" detail={errorMessage ?? "This event could not be loaded."} />
      </Screen>
    );
  }

  return (
    <Screen>
      <AppText variant="eyebrow">Event Registration</AppText>
      <AppText variant="title">{event.name}</AppText>
      <AppText variant="caption">{session.user.email}</AppText>

      {errorMessage ? <FeatureCard title="Checkout needs attention" detail={errorMessage} /> : null}

      <View style={styles.section}>
        <AppText variant="subtitle">1. Choose tickets</AppText>
        {event.ticketTypes.map((ticket) => {
          const quantity = Math.max(0, quantities[ticket.id] ?? 0);
          const ticketTotal = quantity * ticket.price;

          return (
            <View key={ticket.id} style={styles.ticketCard}>
              <View style={styles.ticketTop}>
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
                      {formatCurrency(ticket.regularPrice, ticket.currency)}
                    </AppText>
                  ) : null}
                  <AppText style={styles.price}>{formatCurrency(ticket.price, ticket.currency)}</AppText>
                  {earlyBirdLabel(ticket) ? (
                    <AppText style={styles.earlyBirdLabel}>{earlyBirdLabel(ticket)}</AppText>
                  ) : null}
                </View>
              </View>
              {ticket.description ? <AppText variant="caption">{ticket.description}</AppText> : null}
              <TextInput
                inputMode="numeric"
                keyboardType="number-pad"
                onChangeText={(value) => setQuantity(ticket.id, value)}
                placeholder="Quantity"
                style={styles.input}
                value={quantity ? String(quantity) : ""}
              />
              {quantity > 0 ? (
                <AppText variant="caption">Ticket subtotal: {formatCurrency(ticketTotal, ticket.currency)}</AppText>
              ) : null}
            </View>
          );
        })}
      </View>

      <View style={styles.section}>
        <AppText variant="subtitle">2. Buyer details</AppText>
        <TextInput
          autoCapitalize="words"
          onChangeText={setBuyerFirstName}
          placeholder="First name"
          style={styles.input}
          value={buyerFirstName}
        />
        <TextInput
          autoCapitalize="words"
          onChangeText={setBuyerLastName}
          placeholder="Last name"
          style={styles.input}
          value={buyerLastName}
        />
        <TextInput
          keyboardType="phone-pad"
          onChangeText={setBuyerPhone}
          placeholder="Phone"
          style={styles.input}
          value={buyerPhone}
        />
      </View>

      {additionalNameCount > 0 ? (
        <View style={styles.section}>
          <AppText variant="subtitle">3. Additional attendees</AppText>
          {Array.from({ length: additionalNameCount }, (_, index) => (
            <TextInput
              autoCapitalize="words"
              key={`additional-${index}`}
              onChangeText={(value) => setAdditionalName(index, value)}
              placeholder={`Additional attendee ${index + 1}`}
              style={styles.input}
              value={additionalAttendeeNames[index] ?? ""}
            />
          ))}
        </View>
      ) : null}

      {event.requiredDocuments.length > 0 ? (
        <View style={styles.section}>
          <AppText variant="subtitle">Required documents</AppText>
          {event.requiredDocuments.map((document) => (
            <View key={document.id} style={styles.documentCard}>
              <AppText style={styles.ticketName}>{document.title}</AppText>
              {document.description ? <AppText variant="caption">{document.description}</AppText> : null}
              <AppText variant="caption">{document.body}</AppText>
            </View>
          ))}
          <TextInput
            autoCapitalize="words"
            onChangeText={setDocumentSignatureName}
            placeholder="Type your full name to sign"
            style={styles.input}
            value={documentSignatureName}
          />
          <AppButton
            label={documentConsentAccepted ? "Documents accepted" : "I accept and electronically sign"}
            onPress={() => setDocumentConsentAccepted((current) => !current)}
            variant={documentConsentAccepted ? "primary" : "secondary"}
          />
        </View>
      ) : null}

      <View style={styles.section}>
        <AppText variant="subtitle">Notes</AppText>
        <TextInput
          multiline
          onChangeText={setNotes}
          placeholder="Optional notes"
          style={[styles.input, styles.notes]}
          value={notes}
        />
      </View>

      <View style={styles.totalCard}>
        <AppText variant="eyebrow">Total</AppText>
        <AppText variant="title">{formatCurrency(total, currency)}</AppText>
        <AppText variant="caption">
          After Stripe confirms payment, your tickets and QR codes will appear in Wallet.
        </AppText>
      </View>

      <AppButton
        disabled={selectedTickets.length === 0 || total <= 0}
        label="Continue to secure checkout"
        loading={submitting}
        onPress={submitCheckout}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  documentCard: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 12,
    gap: 6,
    maxHeight: 180,
    padding: 12
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 10
  },
  notes: {
    minHeight: 92,
    textAlignVertical: "top"
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
  section: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 10,
    padding: 16
  },
  ticketCard: {
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
    padding: 12
  },
  ticketName: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "800"
  },
  ticketTop: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12
  },
  totalCard: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    gap: 6,
    padding: 16
  }
});
