import { Image, StyleSheet, View } from "react-native";
import { Link } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";

const lumiAvatar = require("../../assets/lumi-avatar.png");

export default function ScheduleScreen() {
  return (
    <Screen>
      <AppText variant="eyebrow">Schedule</AppText>
      <AppText variant="title">Classes, lessons, and bookings</AppText>
      <AppText variant="caption">
        This screen should consume the same student-safe schedule data as the portal.
      </AppText>

      <FeatureCard
        title="Upcoming"
        detail="List confirmed lessons, events, classes, and rentals."
      />
      <FeatureCard
        title="Booking requests"
        detail="Show pending, approved, declined, and reschedule-needed booking requests."
      />

      <View style={styles.lumiCard}>
        <Image source={lumiAvatar} style={styles.lumiAvatar} resizeMode="contain" />
        <View style={styles.lumiCopy}>
          <AppText variant="subtitle">Need help planning?</AppText>
          <AppText variant="caption">
            LUMI can help you understand your schedule, prepare for lessons, and plan your next practice step.
          </AppText>
        </View>
      </View>

      <Link href="/lumi" asChild>
        <AppButton label="Ask LUMI about my schedule" variant="secondary" />
      </Link>
    </Screen>
  );
}

const styles = StyleSheet.create({
  lumiCard: {
    alignItems: "center",
    backgroundColor: "rgba(236, 72, 153, 0.08)",
    borderColor: "rgba(236, 72, 153, 0.22)",
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 14,
    marginTop: 4,
    padding: 14,
  },
  lumiAvatar: {
    height: 72,
    width: 72,
  },
  lumiCopy: {
    flex: 1,
    gap: 4,
  },
});
