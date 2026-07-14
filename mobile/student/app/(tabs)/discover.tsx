import { useEffect, useState } from "react";
import { Pressable, StyleSheet, useColorScheme, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colorsForScheme } from "@/constants/theme";
import {
  getPublicEventsForMobile,
  getPublicJobPostingsForMobile,
  getPublicPartnerProfilesForMobile,
  getPublicStudiosForMobile
} from "@/lib/publicDiscovery";

type RouterPushTarget = Parameters<ReturnType<typeof useRouter>["push"]>[0];

type DiscoverCardProps = {
  accent?: boolean;
  countLabel: string;
  detail: string;
  icon: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  title: string;
  width: "100%" | "48.5%";
};

function DiscoverCard({ accent, countLabel, detail, icon, onPress, title, width }: DiscoverCardProps) {
  const colors = colorsForScheme(useColorScheme());

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.categoryCard,
        {
          backgroundColor: colors.surface,
          borderColor: colors.border,
          shadowColor: colors.black,
          width,
        },
        pressed && styles.cardPressed,
      ]}
    >
      <View
        style={[
          styles.categoryIcon,
          { backgroundColor: accent ? colors.accent : colors.primary },
        ]}
      >
        <Ionicons color="#fff" name={icon} size={24} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.cardHeader}>
          <AppText style={[styles.categoryTitle, { color: colors.text }]}>{title}</AppText>
          <AppText style={[styles.countPill, { backgroundColor: colors.surfaceAlt, color: colors.primary }]}>{countLabel}</AppText>
        </View>
        <AppText style={[styles.categoryDetail, { color: colors.muted }]}>{detail}</AppText>
      </View>
    </Pressable>
  );
}

export default function DiscoverScreen() {
  const router = useRouter();
  const colors = colorsForScheme(useColorScheme());
  const { width: screenWidth } = useWindowDimensions();
  const cardWidth: "100%" | "48.5%" = screenWidth >= 390 ? "48.5%" : "100%";
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState({
    events: 0,
    jobs: 0,
    partners: 0,
    studios: 0
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    Promise.all([
      getPublicStudiosForMobile(),
      getPublicEventsForMobile(),
      getPublicPartnerProfilesForMobile(),
      getPublicJobPostingsForMobile()
    ])
      .then(([studios, events, partners, jobs]) => {
        if (!mounted) return;
        setCounts({
          events: events.length,
          jobs: jobs.length,
          partners: partners.length,
          studios: studios.length
        });
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

  return (
    <Screen>
      <View style={[styles.hero, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
        <AppText variant="eyebrow">Discover</AppText>
        <AppText variant="title">What are you looking for?</AppText>
        <AppText variant="caption">
          Choose a category first, then search inside that specific area.
        </AppText>
      </View>

      {loading ? <FeatureCard title="Loading discovery" detail="Checking available categories." /> : null}
      {errorMessage ? <FeatureCard title="Discovery update" detail={errorMessage} /> : null}

      <View style={styles.categoryList}>
        <DiscoverCard
          countLabel={`${counts.studios}`}
          detail="Find studios, instructors, beginner-friendly places, and public profiles."
          icon="business-outline"
          onPress={() => router.push("/discover/studios" as unknown as RouterPushTarget)}
          title="Studios"
          width={cardWidth}
        />
        <DiscoverCard
          accent
          countLabel={`${counts.events}`}
          detail="Browse dance events, registrations, classes, socials, and special workshops."
          icon="ticket-outline"
          onPress={() => router.push("/discover/events" as unknown as RouterPushTarget)}
          title="Events"
          width={cardWidth}
        />
        <DiscoverCard
          countLabel={`${counts.partners}`}
          detail="Find dancers looking for practice, social, showcase, or competition partners."
          icon="people-outline"
          onPress={() => router.push("/partners" as unknown as RouterPushTarget)}
          title="Partners"
          width={cardWidth}
        />
        <DiscoverCard
          accent
          countLabel={`${counts.jobs}`}
          detail="Explore studio openings for instructors, coaches, front desk, and event staff."
          icon="briefcase-outline"
          onPress={() => router.push("/jobs" as unknown as RouterPushTarget)}
          title="Jobs"
          width={cardWidth}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between"
  },
  cardPressed: {
    opacity: 0.88,
    transform: [{ scale: 0.99 }]
  },
  categoryCard: {
    borderRadius: 22,
    borderWidth: 1,
    elevation: 1,
    gap: 13,
    minHeight: 170,
    padding: 16,
    shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.06,
    shadowRadius: 14
  },
  categoryDetail: {
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4
  },
  categoryIcon: {
    alignItems: "center",
    borderRadius: 18,
    height: 50,
    justifyContent: "center",
    width: 50
  },
  categoryList: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    justifyContent: "space-between"
  },
  categoryTitle: {
    fontSize: 19,
    fontWeight: "800"
  },
  countPill: {
    borderRadius: 999,
    fontSize: 12,
    fontWeight: "900",
    overflow: "hidden",
    paddingHorizontal: 10,
    paddingVertical: 5
  },
  hero: {
    borderRadius: 24,
    borderWidth: 1,
    gap: 8,
    padding: 20
  }
});
