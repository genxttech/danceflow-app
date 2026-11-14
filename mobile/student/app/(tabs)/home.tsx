import { Ionicons } from "@expo/vector-icons";
import { LinearGradient } from "expo-linear-gradient";
import { Link, router } from "expo-router";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, StyleSheet, useColorScheme, View } from "react-native";
import Animated from "react-native-reanimated";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { LoadingState } from "@/components/LoadingState";
import { Screen } from "@/components/Screen";
import { colorsForScheme, type ThemeColors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { EVENT_ART_ACCENT, EVENT_ART_END, EVENT_ART_GRADIENT, EVENT_ART_START, EVENT_ART_TEXT, EVENT_ART_TEXT_MUTED } from "@/lib/eventArt";
import { initialsFor } from "@/lib/initials";
import { useEnterUp } from "@/lib/motion";
import { getPublicEventsForMobile, getPublicStudiosForMobile, type PublicEventItem, type PublicStudioItem } from "@/lib/publicDiscovery";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";
import {
  formatScheduleTimeRange,
  loadStudentScheduleOverview,
  type StudentScheduleOverview
} from "@/lib/studentSchedule";
import { momentLabel, weekStrip, weekStripLabel } from "@/lib/todayView";

// eslint-disable-next-line @typescript-eslint/no-require-imports -- Metro asset
const lumiAvatar = require("../../assets/lumi-avatar.png");

type Styles = ReturnType<typeof createStyles>;

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

function todayLabel(now = new Date()) {
  return now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function TodayHeader({ initials, styles }: { initials: string; styles: Styles }) {
  return (
    <View style={styles.todayHeader}>
      <AppText style={styles.todayDate}>{todayLabel()}</AppText>
      <Pressable
        accessibilityHint="Opens your profile, settings and more"
        accessibilityLabel="Profile and settings"
        accessibilityRole="button"
        hitSlop={4}
        onPress={() => router.push("/(tabs)/more")}
        style={({ pressed }) => [styles.profileButton, pressed && styles.pressed]}
        testID="today-profile-button"
      >
        <AppText style={styles.profileInitials}>{initials}</AppText>
      </Pressable>
    </View>
  );
}

/** The day's moment: brand art with display type, the same in both themes, like a photo hero. */
function MomentHero({
  eyebrow,
  title,
  detail,
  children,
  styles
}: {
  eyebrow: string;
  title: string;
  detail?: string;
  children?: React.ReactNode;
  styles: Styles;
}) {
  const entering = useEnterUp();
  return (
    <Animated.View entering={entering}>
      <LinearGradient colors={EVENT_ART_GRADIENT} end={EVENT_ART_END} start={EVENT_ART_START} style={styles.moment} testID="today-moment">
        <AppText style={styles.momentEyebrow}>{eyebrow}</AppText>
        <AppText accessibilityRole="header" style={styles.momentTitle} variant="display">
          {title}
        </AppText>
        {detail ? <AppText style={styles.momentDetail}>{detail}</AppText> : null}
        {children ? <View style={styles.momentActions}>{children}</View> : null}
      </LinearGradient>
    </Animated.View>
  );
}

function WeekStrip({ items, styles, colors }: { items: StudentScheduleOverview["upcoming"]; styles: Styles; colors: ThemeColors }) {
  const days = useMemo(() => weekStrip(items, new Date(), items[0]?.timeZone), [items]);
  return (
    <Pressable
      accessibilityLabel={weekStripLabel(days)}
      accessibilityRole="button"
      onPress={() => router.push("/(tabs)/schedule")}
      style={({ pressed }) => [styles.week, pressed && styles.pressed]}
      testID="today-week"
    >
      <View style={styles.weekHeader}>
        <AppText style={styles.sectionTitle}>This week</AppText>
        <View style={styles.inlineLink}>
          <AppText style={styles.linkText}>Full schedule</AppText>
          <Ionicons color={colors.primary} name="chevron-forward" size={16} />
        </View>
      </View>
      <View style={styles.weekDays}>
        {days.map((day) => (
          <View key={day.key} style={[styles.day, day.isToday && styles.dayToday]}>
            <AppText style={[styles.dayName, day.isToday && styles.dayTodayText]}>{day.weekday}</AppText>
            <AppText style={[styles.dayNumber, day.isToday && styles.dayTodayText]}>{day.dayOfMonth}</AppText>
            <View style={[styles.dayDot, day.count > 0 && { backgroundColor: day.isToday ? colors.onPrimary : colors.primary }]} />
          </View>
        ))}
      </View>
    </Pressable>
  );
}

function ShortcutRow({
  icon,
  title,
  detail,
  onPress,
  styles,
  colors,
  testID
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  detail: string;
  onPress: () => void;
  styles: Styles;
  colors: ThemeColors;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityHint={detail}
      accessibilityLabel={title}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.shortcut, pressed && styles.pressed]}
      testID={testID}
    >
      <View style={styles.shortcutIcon}>
        <Ionicons color={colors.primary} name={icon} size={22} />
      </View>
      <View style={styles.shortcutCopy}>
        <AppText style={styles.shortcutTitle}>{title}</AppText>
        <AppText variant="caption">{detail}</AppText>
      </View>
      <Ionicons color={colors.muted} name="chevron-forward" size={18} />
    </Pressable>
  );
}

export default function HomeScreen() {
  const { session } = useAuth();
  const colors = colorsForScheme(useColorScheme());
  const styles = useMemo(() => createStyles(colors), [colors]);
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
  const savedCount = favoriteStudios.length + favoriteEvents.length;
  const greetingName = primaryStudio?.clientFirstName?.trim() || firstNameFromSession(session);
  const initials = initialsFor(
    primaryStudio
      ? [primaryStudio.clientFirstName, primaryStudio.clientLastName].filter(Boolean).join(" ")
      : displayNameFromSession(session),
    session?.user.email
  );

  if (isGuest) {
    return (
      <Screen>
        <MomentHero
          detail="Explore studios, events, lessons and social dancing from one place."
          eyebrow="DanceFlow"
          styles={styles}
          title="Find your next place to dance"
        />
        <Link href="/(tabs)/discover" asChild>
          <AppButton label="Start exploring" />
        </Link>
        <Link href="/(auth)/sign-in" asChild>
          <AppButton label="Continue with email" variant="secondary" />
        </Link>
      </Screen>
    );
  }

  return (
    <Screen>
      <TodayHeader initials={initials} styles={styles} />

      {loadingAccess || loadingSchedule ? (
        <LoadingState label="Loading your day" rows={1} />
      ) : hasPortalAccess && nextItem ? (
        <MomentHero
          detail={[nextItem.studioName, nextItem.roomName, formatScheduleTimeRange(nextItem.startsAt, nextItem.endsAt, nextItem.timeZone)]
            .filter(Boolean)
            .join(" · ")}
          eyebrow={momentLabel(nextItem.startsAt, nextItem.timeZone)}
          styles={styles}
          title={nextItem.title}
        >
          <AppButton
            label="Details"
            onPress={() => router.push({ pathname: "/appointments/[id]", params: { id: nextItem.id } })}
            style={styles.momentButton} variant="onArt"
          />
        </MomentHero>
      ) : hasPortalAccess ? (
        <MomentHero
          detail="When your studio schedules a lesson, class or coaching, it shows here."
          eyebrow={`Welcome back, ${greetingName}`}
          styles={styles}
          title="Nothing booked yet"
        >
          <AppButton label="Request a lesson" onPress={() => router.push("/schedule/request")} style={styles.momentButton} variant="onArt" />
        </MomentHero>
      ) : (
        <MomentHero
          detail="Save studios and events, keep tickets handy, and connect with a studio when you are ready."
          eyebrow={`Welcome, ${greetingName}`}
          styles={styles}
          title="Your dancer account is ready"
        >
          <Link href="/(tabs)/discover" asChild>
            <AppButton label="Find studios and events" style={styles.momentButton} variant="onArt" />
          </Link>
        </MomentHero>
      )}

      {hasPortalAccess ? <WeekStrip colors={colors} items={scheduleOverview?.upcoming ?? []} styles={styles} /> : null}

      <View style={styles.shortcuts}>
        {hasPortalAccess && pendingRequests > 0 ? (
          <ShortcutRow
            colors={colors}
            detail={`${pendingRequests} lesson request${pendingRequests === 1 ? "" : "s"} waiting on your studio`}
            icon="swap-horizontal-outline"
            onPress={() => router.push({ pathname: "/(tabs)/schedule", params: { section: "requests" } })}
            styles={styles}
            title="Your requests"
          />
        ) : hasPortalAccess ? (
          <ShortcutRow
            colors={colors}
            detail={
              recentCount > 0
                ? "Recaps and practice from your recent lessons"
                : "Lesson notes and practice appear as your studio adds them"
            }
            icon="school-outline"
            onPress={() => router.push("/(tabs)/learn")}
            styles={styles}
            title="Keep practising"
          />
        ) : (
          <ShortcutRow
            colors={colors}
            detail="Add your styles, goals and photo"
            icon="person-outline"
            onPress={() => router.push("/profile")}
            styles={styles}
            title="Complete your profile"
          />
        )}
        <ShortcutRow
          colors={colors}
          detail={
            savedCount > 0
              ? `${savedCount} studio${savedCount === 1 ? "" : "s"} and events you follow`
              : "Tap the heart on studios and events to keep them here"
          }
          icon="heart-outline"
          onPress={() => router.push("/favorites")}
          styles={styles}
          testID="today-saved"
          title="Saved"
        />
        {hasPortalAccess ? (
          <Pressable
            accessibilityHint="Opens LUMI"
            accessibilityLabel="Ask LUMI"
            accessibilityRole="button"
            onPress={() => router.push("/lumi")}
            style={({ pressed }) => [styles.shortcut, pressed && styles.pressed]}
          >
            <Image accessibilityIgnoresInvertColors resizeMode="cover" source={lumiAvatar} style={styles.lumiAvatar} />
            <View style={styles.shortcutCopy}>
              <AppText style={styles.shortcutTitle}>Ask LUMI</AppText>
              <AppText variant="caption">Practice ideas, recaps and what to focus on next</AppText>
            </View>
            <Ionicons color={colors.muted} name="chevron-forward" size={18} />
          </Pressable>
        ) : (
          <AppButton label="Full schedule" onPress={() => router.push("/(tabs)/schedule")} variant="ghost" />
        )}
      </View>
    </Screen>
  );
}

function createStyles(colors: ThemeColors) {
  return StyleSheet.create({
    todayHeader: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", minHeight: 44 },
    todayDate: { color: colors.text, fontSize: 15, fontWeight: "600" },
    profileButton: {
      alignItems: "center",
      backgroundColor: colors.surfaceAlt,
      borderColor: colors.borderStrong,
      borderRadius: 22,
      borderWidth: 1,
      height: 44,
      justifyContent: "center",
      width: 44
    },
    profileInitials: { color: colors.text, fontSize: 14, fontWeight: "700" },
    moment: { borderRadius: 24, gap: 10, justifyContent: "flex-end", minHeight: 260, overflow: "hidden", padding: 20 },
    momentEyebrow: { color: EVENT_ART_ACCENT, fontSize: 15, fontWeight: "700" },
    momentTitle: { color: EVENT_ART_TEXT },
    momentDetail: { color: EVENT_ART_TEXT_MUTED, fontSize: 15, lineHeight: 21 },
    momentActions: { flexDirection: "row", gap: 10, marginTop: 6 },
    momentButton: { flex: 1 },
    week: { backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 20, borderWidth: 1, gap: 12, padding: 16 },
    weekHeader: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
    sectionTitle: { color: colors.text, fontSize: 17, fontWeight: "700" },
    inlineLink: { alignItems: "center", flexDirection: "row", gap: 2 },
    linkText: { color: colors.primary, fontSize: 15, fontWeight: "700" },
    weekDays: { flexDirection: "row", justifyContent: "space-between" },
    day: { alignItems: "center", borderRadius: 12, gap: 2, minWidth: 40, paddingVertical: 8 },
    dayToday: { backgroundColor: colors.primary },
    dayName: { color: colors.muted, fontSize: 12, fontWeight: "600" },
    dayNumber: { color: colors.text, fontSize: 17, fontWeight: "700" },
    dayTodayText: { color: colors.onPrimary },
    dayDot: { backgroundColor: "transparent", borderRadius: 3, height: 5, marginTop: 2, width: 5 },
    shortcuts: { gap: 10 },
    shortcut: {
      alignItems: "center",
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 16,
      borderWidth: 1,
      flexDirection: "row",
      gap: 14,
      minHeight: 64,
      padding: 12
    },
    shortcutIcon: { alignItems: "center", backgroundColor: colors.surfaceAlt, borderRadius: 12, height: 44, justifyContent: "center", width: 44 },
    shortcutCopy: { flex: 1, gap: 2 },
    shortcutTitle: { color: colors.text, fontSize: 16, fontWeight: "700" },
    lumiAvatar: { borderRadius: 22, height: 44, width: 44 },
    pressed: { opacity: 0.88 }
  });
}
