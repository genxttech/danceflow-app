import { Link } from "expo-router";
import { useEffect, useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import { getStudentAccess, type LinkedStudioAccess } from "@/lib/studentAccess";

const danceFlowLogo = require("../../assets/danceflow-logo.png");
const lumiAvatar = require("../../assets/lumi-avatar.png");

export default function HomeScreen() {
  const { session, signOut } = useAuth();
  const email = session?.user.email ?? "student";
  const [loadingAccess, setLoadingAccess] = useState(true);
  const [linkedStudios, setLinkedStudios] = useState<LinkedStudioAccess[]>([]);

  useEffect(() => {
    let mounted = true;
    const userId = session?.user.id;

    if (!userId) {
      setLoadingAccess(false);
      setLinkedStudios([]);
      return;
    }

    getStudentAccess(userId)
      .then((access) => {
        if (!mounted) return;
        setLinkedStudios(access.linkedStudios);
      })
      .catch(() => {
        if (!mounted) return;
        setLinkedStudios([]);
      })
      .finally(() => {
        if (!mounted) return;
        setLoadingAccess(false);
      });

    return () => {
      mounted = false;
    };
  }, [session?.user.id]);

  const primaryStudio = linkedStudios[0] ?? null;
  const hasPortalAccess = linkedStudios.length > 0;

  return (
    <Screen>
      <View style={styles.hero}>
        <Image
          accessibilityIgnoresInvertColors
          resizeMode="contain"
          source={danceFlowLogo}
          style={styles.logo}
        />
        <AppText variant="title">Today</AppText>
        <AppText variant="caption">
          {loadingAccess
            ? "Loading your DanceFlow access..."
            : hasPortalAccess
              ? `${email} · ${primaryStudio?.studioPublicName || primaryStudio?.studioName}`
              : `${email} · Dancer account`}
        </AppText>
      </View>

      {hasPortalAccess ? (
        <>
          <FeatureCard
            label="Next"
            title="Upcoming lessons"
            detail="This area will show the student's next private lessons, classes, rentals, and event commitments."
          />
          <FeatureCard
            label="Progress"
            title="Lesson recaps and syllabus"
            detail="Connect this to journey data so students can review instructor notes, practice assignments, and skill progress."
          />
        </>
      ) : (
        <>
          <FeatureCard
            label="Explore"
            title="Find studios and events"
            detail="Browse public studios, save favorites, and discover events without needing a studio portal connection."
          />
          <FeatureCard
            label="Get started"
            title="Connect with a studio"
            detail="Once a studio links your portal, DanceFlow can show lessons, packages, recaps, syllabus progress, and LUMI."
          />
        </>
      )}
      <FeatureCard
        label="Favorites"
        title="Studios and events"
        detail="Saved studios, events, and registrations will stay available whether or not you are linked to a studio."
      />

      {hasPortalAccess ? (
        <View style={styles.lumiCard}>
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            source={lumiAvatar}
            style={styles.lumiAvatar}
          />
          <View style={styles.lumiCopy}>
            <AppText variant="eyebrow">LUMI</AppText>
            <AppText variant="title">Your DanceFlow assistant</AppText>
            <AppText variant="caption">
              Ask LUMI about practice ideas, lesson recaps, syllabus progress,
              and what to focus on next.
            </AppText>
            <Link href="/lumi" asChild>
              <AppButton label="Ask LUMI" />
            </Link>
          </View>
        </View>
      ) : (
        <View style={styles.lumiCard}>
          <Image
            accessibilityIgnoresInvertColors
            resizeMode="cover"
            source={lumiAvatar}
            style={styles.lumiAvatar}
          />
          <View style={styles.lumiCopy}>
            <AppText variant="eyebrow">LUMI</AppText>
            <AppText variant="title">Unlock with a studio portal</AppText>
            <AppText variant="caption">
              LUMI becomes available when a studio connects your DanceFlow portal,
              so it can personalize help from real lesson and progress data.
            </AppText>
          </View>
        </View>
      )}
      <AppButton label="Sign out" onPress={signOut} variant="secondary" />
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
  }
});
