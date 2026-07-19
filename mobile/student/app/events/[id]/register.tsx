import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Linking, StyleSheet, TextInput, View } from "react-native";
import { type Href, useLocalSearchParams, useRouter } from "expo-router";
import { useStripe } from "@stripe/stripe-react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import {
  assertSafeEventCheckoutUrl,
  confirmStudentEventOrder,
  createStudentEventCheckout,
  getStudentEventOrderStatus
} from "@/lib/eventCheckout";
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
  return "danceflow://wallet?checkout=event";
}

function walletCheckoutPath(orderId: string): Href {
  return {
    pathname: "/wallet",
    params: {
      checkout: "event",
      orderId
    }
  };
}

function nativePaymentsEnabled() {
  return Boolean(process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY);
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const { session } = useAuth();
  const [event, setEvent] = useState<PublicEventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [checkoutStatusMessage, setCheckoutStatusMessage] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [buyerFirstName, setBuyerFirstName] = useState("");
  const [buyerLastName, setBuyerLastName] = useState("");
  const [buyerPhone, setBuyerPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [additionalAttendeeNames, setAdditionalAttendeeNames] = useState<string[]>([]);
  const [signingOrderId, setSigningOrderId] = useState<string | null>(null);

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
    setCheckoutStatusMessage(null);

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

      const returnUrl = eventCheckoutReturnUrl();

      const checkoutInput = {
        additionalAttendeeNames: trimmedAdditionalNames,
        buyerFirstName: buyerFirstName.trim(),
        buyerLastName: buyerLastName.trim(),
        buyerPhone: buyerPhone.trim(),
        eventId: event.id,
        notes: notes.trim(),
        returnUrl,
        ticketSelections: selectedTickets.map((selection) => ({
          ticketTypeId: selection.ticket.id,
          quantity: selection.quantity
        }))
      };

      const result = await createStudentEventCheckout({
        ...checkoutInput,
        paymentMode: nativePaymentsEnabled() ? "payment_sheet" : "checkout"
      });

      if (result.completed) {
        router.replace(walletCheckoutPath(result.orderId));
        return;
      }

      if (result.requiresSignature && result.signingUrl) {
        setSigningOrderId(result.orderId);
        setCheckoutStatusMessage(
          "Opening secure document signing. Return to DanceFlow after the final document.",
        );
        await Linking.openURL(
          assertSafeEventCheckoutUrl(result.signingUrl),
        );
        return;
      }

      if (result.clientSecret) {
        const initialized = await initPaymentSheet({
          defaultBillingDetails: {
            email: session.user.email ?? undefined,
            name: [buyerFirstName.trim(), buyerLastName.trim()].filter(Boolean).join(" ")
          },
          merchantDisplayName: "DanceFlow",
          paymentIntentClientSecret: result.clientSecret,
          returnURL: returnUrl
        });

        if (initialized.error) {
          const fallback = await createStudentEventCheckout({
            ...checkoutInput,
            paymentMode: "checkout"
          });

          if (!fallback.checkoutUrl) {
            throw new Error(initialized.error.message || "Native checkout could not be started.");
          }

          await Linking.openURL(
            assertSafeEventCheckoutUrl(fallback.checkoutUrl),
          );
          return;
        }

        const payment = await presentPaymentSheet();
        if (payment.error) {
          throw new Error(payment.error.message || "Payment was not completed.");
        }

        setCheckoutStatusMessage("Payment received. Preparing your tickets...");

        try {
          await confirmStudentEventOrder(result.orderId);
          setCheckoutStatusMessage("Payment confirmed. Ticket codes are being issued...");

          for (let attempt = 0; attempt < 8; attempt += 1) {
            const orderStatus = await getStudentEventOrderStatus(result.orderId);

            if (orderStatus.ticketsReady) {
              break;
            }

            if (orderStatus.paymentStatus === "paid") {
              setCheckoutStatusMessage("Payment confirmed. Ticket codes are being issued...");
            }

            await wait(attempt < 2 ? 1200 : 2500);
          }
        } catch {
          setCheckoutStatusMessage("Payment received. Opening Wallet while tickets finish syncing...");
          await wait(1200);
        }

        router.replace(walletCheckoutPath(result.orderId));
        return;
      }

      if (!result.checkoutUrl) {
        throw new Error("Checkout could not be started.");
      }

      await Linking.openURL(
        assertSafeEventCheckoutUrl(result.checkoutUrl),
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Checkout could not be started.");
      setCheckoutStatusMessage(null);
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
      {checkoutStatusMessage ? (
        <View style={styles.statusCard}>
          <ActivityIndicator color={colors.primary} />
          <View style={{ flex: 1 }}>
            <AppText variant="subtitle">Finishing checkout</AppText>
            <AppText variant="caption">{checkoutStatusMessage}</AppText>
          </View>
        </View>
      ) : null}

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
          <AppText variant="caption">
            After you choose tickets and enter attendee details, DanceFlow will
            open each required document in the secure signing flow. Your ticket
            hold stays attached to this checkout while you sign.
          </AppText>
          {event.requiredDocuments.map((document, index) => (
            <View key={document.id} style={styles.documentCard}>
              <AppText style={styles.ticketName}>
                {index + 1}. {document.title}
              </AppText>
              {document.description ? (
                <AppText variant="caption">{document.description}</AppText>
              ) : null}
            </View>
          ))}
          {signingOrderId ? (
            <FeatureCard
              title="Signing checkout started"
              detail="Complete the secure documents, then return to DanceFlow to continue payment."
            />
          ) : null}
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
        disabled={selectedTickets.length === 0 || Boolean(checkoutStatusMessage)}
        label={
          checkoutStatusMessage
            ? "Opening secure checkout..."
            : event.requiredDocuments.length > 0
              ? "Continue to documents"
              : "Continue to secure checkout"
        }
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
  statusCard: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 14
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
