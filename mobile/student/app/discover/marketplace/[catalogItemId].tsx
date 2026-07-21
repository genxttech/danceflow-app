import { useEffect, useState } from "react";
import { StyleSheet, useColorScheme, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useStripe } from "@stripe/stripe-react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colorsForScheme } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  confirmStudentMarketplaceOrder,
  createStudentMarketplaceCheckout,
  loadStudentMarketplaceItem,
  type StudentMarketplaceItem
} from "@/lib/studentMarketplace";

function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function money(value: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "USD"
  }).format(value);
}

export default function MarketplaceDetailScreen() {
  const { catalogItemId: rawId } = useLocalSearchParams<{ catalogItemId: string }>();
  const catalogItemId = normalizeParam(rawId);
  const router = useRouter();
  const { session } = useAuth();
  const { initPaymentSheet, presentPaymentSheet } = useStripe();
  const colors = colorsForScheme(useColorScheme());
  const styles = createStyles(colors);
  const [item, setItem] = useState<StudentMarketplaceItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!catalogItemId) return;
    let mounted = true;

    loadStudentMarketplaceItem(catalogItemId)
      .then((nextItem) => {
        if (mounted) setItem(nextItem);
      })
      .catch((error) => {
        if (mounted) {
          setErrorMessage(error instanceof Error ? error.message : "Content could not be loaded.");
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [catalogItemId]);

  async function purchase() {
    if (!catalogItemId || !item || !session) return;

    setSubmitting(true);
    setErrorMessage(null);
    setStatusMessage("Preparing secure checkout...");

    try {
      const checkout = await createStudentMarketplaceCheckout(catalogItemId);
      const initialized = await initPaymentSheet({
        defaultBillingDetails: {
          email: session.user.email ?? undefined
        },
        merchantDisplayName: item.studioName,
        paymentIntentClientSecret: checkout.clientSecret,
        returnURL: "danceflow://wallet/digital-purchases"
      });

      if (initialized.error) {
        throw new Error(initialized.error.message || "Checkout could not be prepared.");
      }

      const payment = await presentPaymentSheet();
      if (payment.error) {
        throw new Error(payment.error.message || "Payment was not completed.");
      }

      setStatusMessage("Payment received. Granting access...");
      const confirmation = await confirmStudentMarketplaceOrder(checkout.orderId);

      if (!confirmation.confirmed) {
        throw new Error("Payment is still confirming. Check Digital Purchases shortly.");
      }

      router.replace("/wallet/digital-purchases" as never);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Purchase could not be completed.");
      setStatusMessage(null);
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <Screen>
        <FeatureCard title="Loading content" detail="Checking availability and ownership." />
      </Screen>
    );
  }

  if (!item) {
    return (
      <Screen>
        <FeatureCard title="Content unavailable" detail={errorMessage ?? "This item could not be found."} />
      </Screen>
    );
  }

  return (
    <Screen>
      <AppText variant="eyebrow">
        {item.itemType === "video_series" ? "Video Series" : "Digital Video"}
      </AppText>
      <AppText variant="title">{item.name}</AppText>
      <AppText variant="caption">{item.studioName}</AppText>

      <View style={styles.card}>
        {item.description ? <AppText variant="caption">{item.description}</AppText> : null}
        {item.instructorName ? (
          <AppText variant="caption">Instructor: {item.instructorName}</AppText>
        ) : null}
        <AppText variant="subtitle">{money(item.price, item.currency)}</AppText>
      </View>

      {statusMessage ? (
        <FeatureCard title="Purchase in progress" detail={statusMessage} />
      ) : null}
      {errorMessage ? (
        <FeatureCard title="Purchase needs attention" detail={errorMessage} />
      ) : null}

      {!session ? (
        <AppButton
          label="Sign in to purchase"
          onPress={() => router.push("/(auth)/sign-in" as never)}
        />
      ) : item.owned ? (
        <AppButton
          label="Open Digital Purchases"
          onPress={() => router.push("/wallet/digital-purchases" as never)}
        />
      ) : (
        <AppButton
          label={submitting ? "Processing..." : `Buy for ${money(item.price, item.currency)}`}
          disabled={submitting}
          onPress={() => void purchase()}
        />
      )}
    </Screen>
  );
}

function createStyles(colors: ReturnType<typeof colorsForScheme>) {
  return StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 20,
      borderWidth: 1,
      gap: 10,
      padding: 18
    }
  });
}
