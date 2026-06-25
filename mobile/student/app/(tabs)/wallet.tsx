import { useEffect, useState } from "react";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { useAuth } from "@/lib/auth";
import { getStudentAccess } from "@/lib/studentAccess";

export default function WalletScreen() {
  const { session } = useAuth();
  const [hasPortalAccess, setHasPortalAccess] = useState(false);

  useEffect(() => {
    const userId = session?.user.id;
    let mounted = true;

    if (!userId) return;

    getStudentAccess(userId)
      .then((access) => {
        if (mounted) setHasPortalAccess(access.hasPortalAccess);
      })
      .catch(() => {
        if (mounted) setHasPortalAccess(false);
      });

    return () => {
      mounted = false;
    };
  }, [session?.user.id]);

  return (
    <Screen>
      <AppText variant="eyebrow">Wallet</AppText>
      <AppText variant="title">Memberships, packages, and tickets</AppText>
      <AppText variant="caption">
        This tab should show active memberships, lesson package balances, event tickets,
        and QR codes when ticketing is connected.
      </AppText>

      {hasPortalAccess ? (
        <>
          <FeatureCard
            title="Membership"
            detail="Current plan, renewal status, and student-visible billing state."
          />
          <FeatureCard
            title="Packages"
            detail="Remaining lesson credits, expiration dates, and eligible booking types."
          />
        </>
      ) : (
        <FeatureCard
          title="Studio wallet unlocks after portal connection"
          detail="Memberships and lesson packages appear after a studio links your DanceFlow portal."
        />
      )}
      <FeatureCard
        title="Tickets"
        detail="Upcoming event tickets and check-in QR codes will be available for public event registrations."
      />
    </Screen>
  );
}
