import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
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
};

function DiscoverCard({ accent, countLabel, detail, icon, onPress, title }: DiscoverCardProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.categoryCard, pressed && styles.cardPressed]}
    >
      <View style={[styles.categoryIcon, accent && styles.categoryIconAccent]}>
        <Ionicons color="#fff" name={icon} size={24} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.cardHeader}>
          <AppText style={styles.categoryTitle}>{title}</AppText>
          <AppText style={styles.countPill}>{countLabel}</AppText>
        </View>
        <AppText style={styles.categoryDetail}>{detail}</AppText>
      </View>
    </Pressable>
  );
}

export default function DiscoverScreen() {
  const router = useRouter();
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
      <View style={styles.hero}>
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
        />
        <DiscoverCard
          accent
          countLabel={`${counts.events}`}
          detail="Browse dance events, registrations, classes, socials, and special workshops."
          icon="ticket-outline"
          onPress={() => router.push("/discover/events" as unknown as RouterPushTarget)}
          title="Events"
        />
        <DiscoverCard
          countLabel={`${counts.partners}`}
          detail="Find dancers looking for practice, social, showcase, or competition partners."
          icon="people-outline"
          onPress={() => router.push("/partners" as unknown as RouterPushTarget)}
          title="Partners"
        />
        <DiscoverCard
          accent
          countLabel={`${counts.jobs}`}
          detail="Explore studio openings for instructors, coaches, front desk, and event staff."
          icon="briefcase-outline"
          onPress={() => router.push("/jobs" as unknown as RouterPushTarget)}
          title="Jobs"
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
    opacity: 0.78
  },
  categoryCard: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 22,
    borderWidth: 1,
    flexDirection: "row",
    gap: 14,
    padding: 16
  },
  categoryDetail: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 4
  },
  categoryIcon: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: 18,
    height: 50,
    justifyContent: "center",
    width: 50
  },
  categoryIconAccent: {
    backgroundColor: colors.accent
  },
  categoryList: {
    gap: 12
  },
  categoryTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "900"
  },
  countPill: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 999,
    color: colors.primary,
    fontSize: 12,
    fontWeight: "900",
    overflow: "hidden",
    paddingHorizontal: 10,
    paddingVertical: 5
  },
  hero: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 22,
    borderWidth: 1,
    gap: 8,
    padding: 18
  }
});
