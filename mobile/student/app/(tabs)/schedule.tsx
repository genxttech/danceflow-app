import { Link } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";

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

      <Link href="/lumi" asChild>
        <AppButton label="Ask LUMI about my schedule" variant="secondary" />
      </Link>
    </Screen>
  );
}
