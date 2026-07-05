import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import {
  getStudentEventOrderStatus,
  type StudentEventOrderStatus
} from "@/lib/eventCheckout";

function formatCurrency(value: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    currency: currency || "USD",
    style: "currency"
  }).format(value);
}

function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function statusText(order: StudentEventOrderStatus | null) {
  if (!order) {
    return {
      detail: "Checking the latest checkout status.",
      title: "Checking checkout"
    };
  }

  if (order.ticketsReady) {
    return {
      detail: `${order.ticketCodesIssued} ticket${order.ticketCodesIssued === 1 ? "" : "s"} ready in Wallet.`,
      title: "Tickets are ready"
    };
  }

  if (order.paymentStatus === "paid") {
    return {
      detail: "Payment was received. Ticket codes are being prepared now.",
      title: "Preparing tickets"
    };
  }

  if (order.status === "cancelled" || order.paymentStatus === "failed") {
    return {
      detail: "This checkout was not completed. Your ticket hold has been released.",
      title: "Checkout was not completed"
    };
  }

  return {
    detail: "Waiting for payment confirmation from Stripe.",
    title: "Confirming payment"
  };
}

export default function EventOrderStatusScreen() {
  const { orderId: orderIdParam } = useLocalSearchParams<{ orderId: string }>();
  const orderId = normalizeParam(orderIdParam);
  const router = useRouter();
  const [order, setOrder] = useState<StudentEventOrderStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);

  const copy = useMemo(() => statusText(order), [order]);
  const shouldPoll =
    Boolean(orderId) &&
    !order?.ticketsReady &&
    order?.status !== "cancelled" &&
    order?.paymentStatus !== "failed" &&
    pollCount < 12;

  const loadOrder = useCallback(
    async (isRefresh = false) => {
      if (!orderId || orderId === "pending") {
        setErrorMessage("This checkout link is missing the order id.");
        setLoading(false);
        return;
      }

      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }

      setErrorMessage(null);

      try {
        const nextOrder = await getStudentEventOrderStatus(orderId);
        setOrder(nextOrder);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Checkout status could not be loaded.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [orderId]
  );

  useEffect(() => {
    loadOrder();
  }, [loadOrder]);

  useFocusEffect(
    useCallback(() => {
      loadOrder(true);
    }, [loadOrder])
  );

  useEffect(() => {
    if (!shouldPoll) return;

    const timer = setTimeout(() => {
      setPollCount((current) => current + 1);
      loadOrder(true);
    }, 2500);

    return () => clearTimeout(timer);
  }, [loadOrder, shouldPoll, pollCount]);

  return (
    <Screen>
      <AppText variant="eyebrow">Event Checkout</AppText>
      <AppText variant="title">{order?.eventName ?? "Ticket purchase"}</AppText>

      <View style={styles.statusCard}>
        {loading ? <ActivityIndicator color={colors.primary} /> : null}
        <AppText variant="subtitle">{copy.title}</AppText>
        <AppText variant="caption">{copy.detail}</AppText>

        {order ? (
          <View style={styles.summaryGrid}>
            <View style={styles.summaryItem}>
              <AppText variant="eyebrow">Total</AppText>
              <AppText variant="subtitle">{formatCurrency(order.totalAmount, order.currency)}</AppText>
            </View>
            <View style={styles.summaryItem}>
              <AppText variant="eyebrow">Tickets</AppText>
              <AppText variant="subtitle">
                {order.ticketCodesIssued}/{order.ticketCount}
              </AppText>
            </View>
          </View>
        ) : null}
      </View>

      {errorMessage ? <FeatureCard title="Checkout needs attention" detail={errorMessage} /> : null}

      <View style={styles.actions}>
        <AppButton label="Open Wallet" onPress={() => router.replace("/wallet")} />
        <AppButton
          label={refreshing ? "Refreshing..." : "Refresh status"}
          onPress={() => loadOrder(true)}
          variant="secondary"
        />
        {order?.eventId ? (
          <AppButton
            label="Back to event"
            onPress={() => router.replace(`/events/${order.eventId}`)}
            variant="secondary"
          />
        ) : null}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: {
    gap: 10
  },
  statusCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 12,
    padding: 18
  },
  summaryGrid: {
    flexDirection: "row",
    gap: 10
  },
  summaryItem: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    flex: 1,
    gap: 4,
    padding: 12
  }
});
