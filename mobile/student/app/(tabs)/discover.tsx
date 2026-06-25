import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";

export default function DiscoverScreen() {
  return (
    <Screen>
      <AppText variant="eyebrow">Discover</AppText>
      <AppText variant="title">Studios and events</AppText>
      <AppText variant="caption">
        Discovery should start with favorited studios and events, then expand into public
        search when the marketplace layer is ready.
      </AppText>

      <FeatureCard
        title="Favorite studios"
        detail="Quick access to studios a dancer follows, attends, or wants to try next."
      />
      <FeatureCard
        title="Favorite events"
        detail="Saved showcases, competitions, socials, and workshops."
      />
      <FeatureCard
        title="Open to every dancer"
        detail="Discovery stays available whether you are linked to a studio portal or browsing as an independent dancer."
      />
    </Screen>
  );
}
