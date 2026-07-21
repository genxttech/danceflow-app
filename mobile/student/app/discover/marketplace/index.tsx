import { useCallback, useState } from "react";
import { Pressable, StyleSheet, useColorScheme, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colorsForScheme } from "@/constants/theme";
import {
  loadStudentMarketplace,
  type StudentMarketplaceItem
} from "@/lib/studentMarketplace";

function money(value: number, currency: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency || "USD"
  }).format(value);
}

export default function MarketplaceScreen() {
  const router = useRouter();
  const colors = colorsForScheme(useColorScheme());
  const styles = createStyles(colors);
  const [items, setItems] = useState<StudentMarketplaceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      setLoading(true);
      setErrorMessage(null);

      loadStudentMarketplace()
        .then((nextItems) => {
          if (mounted) setItems(nextItems);
        })
        .catch((error) => {
          if (mounted) {
            setErrorMessage(
              error instanceof Error ? error.message : "Marketplace could not be loaded."
            );
          }
        })
        .finally(() => {
          if (mounted) setLoading(false);
        });

      return () => {
        mounted = false;
      };
    }, [])
  );

  return (
    <Screen>
      <AppText variant="eyebrow">Marketplace</AppText>
      <AppText variant="title">Learn from DanceFlow studios</AppText>
      <AppText variant="caption">
        Browse secure videos and series. Purchases are saved to Wallet and available in Learn.
      </AppText>

      {loading ? (
        <FeatureCard title="Loading marketplace" detail="Finding published digital content." />
      ) : null}

      {!loading && errorMessage ? (
        <FeatureCard title="Marketplace unavailable" detail={errorMessage} />
      ) : null}

      {!loading && !errorMessage && items.length === 0 ? (
        <FeatureCard
          title="New content is coming"
          detail="Published videos and series from DanceFlow studios will appear here."
        />
      ) : null}

      <View style={styles.list}>
        {items.map((item) => (
          <Pressable
            key={item.id}
            onPress={() =>
              router.push({
                pathname: "/discover/marketplace/[catalogItemId]",
                params: { catalogItemId: item.id }
              } as never)
            }
            style={({ pressed }) => [styles.card, pressed && styles.pressed]}
          >
            <View style={styles.header}>
              <AppText variant="eyebrow">
                {item.itemType === "video_series" ? "Video Series" : "Video"}
              </AppText>
              <AppText variant="caption">{item.studioName}</AppText>
            </View>
            <AppText variant="subtitle">{item.name}</AppText>
            {item.description ? <AppText variant="caption">{item.description}</AppText> : null}
            <View style={styles.footer}>
              <AppText variant="subtitle">{money(item.price, item.currency)}</AppText>
              <AppText variant="caption">{item.owned ? "Owned" : "View details"}</AppText>
            </View>
          </Pressable>
        ))}
      </View>
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
      gap: 8,
      padding: 16
    },
    footer: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
      marginTop: 4
    },
    header: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
      justifyContent: "space-between"
    },
    list: {
      gap: 12
    },
    pressed: {
      opacity: 0.8
    }
  });
}
