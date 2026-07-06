import { Ionicons } from "@expo/vector-icons";
import { Link, router } from "expo-router";
import { useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getPublicEventsForMobile, getPublicStudiosForMobile, type PublicEventItem, type PublicStudioItem } from "@/lib/publicDiscovery";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import {
  formatScheduleTimeRange,
  loadStudentScheduleOverview,
  type StudentScheduleOverview
} from "@/lib/studentSchedule";

const danceFlowLogo = require("../../assets/danceflow-logo.png");
const lumiAvatar = require("../../assets/lumi-avatar.png");

function displayNameFromSession(session: ReturnType<typeof useAuth>["session"]) {
  const metadata = session?.user.user_metadata ?? {};
  const firstName = typeof metadata.first_name === "string" ? metadata.first_name : "";
  const lastName = typeof metadata.last_name === "string" ? metadata.last_name : "";
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();

  return fullName || session?.user.email || "Dancer";
}

function firstNameFromSession(session: ReturnType<typeof useAuth>["session"]) {
  const metadata = session?.user.user_metadata ?? {};
  const firstName = typeof metadata.first_name === "string" ? metadata.first_name.trim() : "";
  if (firstName) return firstName;

  const metadataNameCandidates = [
    metadata.name,
    metadata.full_name,
    metadata.display_name,
    metadata.preferred_name
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  const displayName = metadataNameCandidates[0]?.trim() || displayNameFromSession(session);
  if (displayName.includes("@")) return "Dancer";
  return displayName.split(" ")[0] || "Dancer";
}

function HomeActionCard({
  detail,
  icon,
  label,
  onPress,
  title
}: {
  detail: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  title: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.actionCard, pressed && styles.cardPressed]}
    >
      <View style={styles.actionIcon}>
        <Ionicons color="#fff" name={icon} size={22} />
      </View>
      <View style={{ flex: 1 }}>
        <AppText variant="eyebrow">{label}</AppText>
        <AppText variant="subtitle">{title}</AppText>
        <AppText variant="caption">{detail}</AppText>
      </View>
    </Pressable>
  );
}

export default function HomeScreen() {
  const { session } = useAuth();
  const [loadingAccess, setLoadingAccess] = useState(true);
  const [loadingSchedule, setLoadingSchedule] = useState(false);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);
  const [scheduleOverview, setScheduleOverview] = useState<StudentScheduleOverview | null>(null);
  const [favoriteStudios, setFavoriteStudios] = useState<PublicStudioItem[]>([]);
  const [favoriteEvents, setFavoriteEvents] = useState<PublicEventItem[]>([]);

  useEffect(() => {
    let mounted = true;
    const userId = session?.user.id;

    if (!userId) {
      setLoadingAccess(false);
      setLoadingSchedule(false);
      setLinkedStudios([]);
      setScheduleOverview(null);
      setFavoriteStudios([]);
      setFavoriteEvents([]);
      return;
    }

    setLoadingAccess(true);

    Promise.all([getPublicStudiosForMobile(userId), getPublicEventsForMobile(userId)])
      .then(([studios, events]) => {
        if (!mounted) return;
        setFavoriteStudios(studios.filter((studio) => studio.favorited).slice(0, 3));
        setFavoriteEvents(events.filter((event) => event.favorited).slice(0, 3));
      })
      .catch(() => {
        if (!mounted) return;
        setFavoriteStudios([]);
        setFavoriteEvents([]);
      });

    getStudentAccess(userId)
      .then(async (access) => {
        if (!mounted) return;

        setLinkedStudios(access.linkedStudios);

        if (access.linkedStudios.length === 0) {
          setScheduleOverview(null);
          return;
        }

        setLoadingSchedule(true);

        try {
          const overview = await loadStudentScheduleOverview(access.linkedStudios);
          if (!mounted) return;
          setScheduleOverview(overview);
        } finally {
          if (mounted) setLoadingSchedule(false);
        }
      })
      .catch(() => {
        if (!mounted) return;
        setLinkedStudios([]);
        setScheduleOverview(null);
      })
      .finally(() => {
        if (!mounted) return;
        setLoadingAccess(false);
      });

    return () => {
      mounted = false;
    };
  }, [session?.user.id]);

  const isGuest = !session;
  const primaryStudio = linkedStudios[0] ?? null;
  const hasPortalAccess = linkedStudios.length > 0;
  const nextItem = scheduleOverview?.nextItem ?? null;
  const pendingRequests = scheduleOverview?.bookingRequests.length ?? 0;
  const recentCount = scheduleOverview?.recent.length ?? 0;
  const favoritePreview = [...favoriteStudios, ...favoriteEvents].slice(0, 4);
  const greetingName = primaryStudio?.clientFirstName?.trim() || firstNameFromSession(session);

  return (
    <Screen>
      <View style={styles.hero}>
        <Image accessibilityIgnoresInvertColors resizeMode="contain" source={danceFlowLogo} style={styles.logo} />
        <AppText variant="title">
          {isGuest ? "Welcome to DanceFlow" : `Welcome back, ${greetingName}`}
        </AppText>
        <AppText variant="caption">
          {isGuest
            ? "Find dance studios, events, lessons, and social dancing near you."
            : hasPortalAccess
              ? `${session.user.email ?? "DanceFlow"} · ${primaryStudio?.studioPublicName || primaryStudio?.studioName}`
              : "Your dancer account is ready. Save favorites, keep tickets handy, and complete your profile."}
        </AppText>
      </View>

      {isGuest ? (
        <>
          <FeatureCard
            label="Explore"
            title="Browse without an account"
            detail="Search studios and events, view details, share listings, and open public registration links."
          />
          <Link href="/(tabs)/discover" asChild>
            <AppButton label="Start exploring" />
          </Link>
          <Link href="/(auth)/sign-in" asChild>
            <AppButton label="Continue with email" variant="secondary" />
          </Link>
        </>
      ) : hasPortalAccess ? (
        <>
          <FeatureCard
            label="Next"
            title={loadingSchedule ? "Loading your schedule..." : nextItem?.title || "No upcoming lessons yet"}
            detail={
              loadingSchedule
                ? "Checking your connected studio schedule."
                : nextItem
                  ? `${formatScheduleTimeRange(nextItem.startsAt, nextItem.endsAt, nextItem.timeZone)} · ${nextItem.studioName}`
                  : "When your studio schedules a lesson, class, rental, or coaching, it will appear here."
            }
          />

          <View style={styles.actionList}>
            <HomeActionCard
              detail={`${scheduleOverview?.upcoming.length ?? 0} confirmed schedule item${
                (scheduleOverview?.upcoming.length ?? 0) === 1 ? "" : "s"
              }`}
              icon="calendar-outline"
              label="Upcoming"
              onPress={() => router.push({ pathname: "/(tabs)/schedule", params: { section: "upcoming" } })}
              title="Go to schedule"
            />
            <HomeActionCard
              detail={`${pendingRequests} pending or approved request${
                pendingRequests === 1 ? "" : "s"
              }`}
              icon="swap-horizontal-outline"
              label="Requests"
              onPress={() => router.push({ pathname: "/(tabs)/schedule", params: { section: "requests" } })}
              title="View requests"
            />
            <HomeActionCard
              detail={
                recentCount > 0
                  ? `${recentCount} recent schedule item${recentCount === 1 ? "" : "s"} can support recaps and practice.`
                  : "Lesson notes, practice assignments, and skill progress will appear as your studio adds them."
              }
              icon="school-outline"
              label="Progress"
              onPress={() => router.push("/(tabs)/learn")}
              title="Open Learn"
            />
          </View>
        </>
      ) : (
        <>
          <FeatureCard
            label="Dancer account"
            title="Save, profile, and discover"
            detail="Complete your profile, save studios and events, and keep event tickets handy even before a studio connects your account."
          />
          <Link href="/profile" asChild>
            <AppButton label="Complete profile" />
          </Link>
          <Link href="/(tabs)/discover" asChild>
            <AppButton label="Find studios and events" variant="secondary" />
          </Link>
        </>
      )}

      {!isGuest ? (
        <View style={styles.savedCard}>
          <View style={styles.savedHeader}>
            <View style={{ flex: 1 }}>
              <AppText variant="eyebrow">Saved</AppText>
              <AppText variant="subtitle">
                {favoritePreview.length ? "Your favorite studios and events" : "Save studios and events"}
              </AppText>
            </View>
            <Link href="/favorites" asChild>
              <AppButton label="View all" variant="secondary" />
            </Link>
          </View>
          {favoritePreview.length ? (
            favoritePreview.map((item) => (
              <AppText key={item.id} variant="caption">
                ♥ {item.name}
              </AppText>
            ))
          ) : (
            <AppText variant="caption">Tap the heart on studios and events in Discover to keep them here.</AppText>
          )}
        </View>
      ) : null}

      <View style={styles.lumiCard}>
        <Image accessibilityIgnoresInvertColors resizeMode="cover" source={lumiAvatar} style={styles.lumiAvatar} />
        <View style={styles.lumiCopy}>
          <AppText variant="eyebrow">LUMI</AppText>
          <AppText variant="title">
            {hasPortalAccess ? "Your DanceFlow assistant" : "Your dance journey assistant"}
          </AppText>
          <AppText variant="caption">
            {hasPortalAccess
              ? "Ask LUMI about practice ideas, lesson recaps, syllabus progress, and what to focus on next."
              : "LUMI becomes available after a studio connects your account so guidance can use real lesson and progress data."}
          </AppText>
          {hasPortalAccess ? (
            <Link href="/lumi" asChild>
              <AppButton label="Ask LUMI" />
            </Link>
          ) : null}
        </View>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 18,
    gap: 8,
    padding: 20
  },
  logo: {
    height: 42,
    marginBottom: 4,
    width: 150
  },
  lumiAvatar: {
    borderRadius: 34,
    height: 68,
    width: 68
  },
  lumiCard: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderRadius: 18,
    flexDirection: "row",
    gap: 14,
    padding: 16
  },
  lumiCopy: {
    flex: 1,
    gap: 8
  },
  savedCard: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
    padding: 16
  },
  savedHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12
  },
  actionCard: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 14,
    padding: 16
  },
  actionIcon: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: 16,
    height: 46,
    justifyContent: "center",
    width: 46
  },
  actionList: {
    gap: 10
  },
  cardPressed: {
    opacity: 0.78
  }
});
