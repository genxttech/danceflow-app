import { useEffect, useState } from "react";
import { Image, Linking, Pressable, Share, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  getPublicStudioDetailForMobile,
  setPublicFavoriteForMobile,
  type PublicEventItem,
  type PublicStudioDetail,
  type PublicStudioStaffMember,
  type PublicStudioTag
} from "@/lib/publicDiscovery";
import {
  loadStudioSelfServiceSlots,
  submitStudioSelfServiceRequest,
  type StudioSelfServiceInstructor,
  type StudioSelfServiceSlot
} from "@/lib/studioSelfService";

type StudioSection =
  | "hub"
  | "overview"
  | "about"
  | "dance-styles"
  | "staff"
  | "offerings"
  | "events"
  | "contact";

type RouterPushTarget = Parameters<ReturnType<typeof useRouter>["push"]>[0];

const STUDIO_SECTIONS: Array<{
  key: Exclude<StudioSection, "hub">;
  title: string;
  detail: string;
  icon: keyof typeof Ionicons.glyphMap;
}> = [
  {
    key: "overview",
    title: "Overview",
    detail: "Highlights, location, and quick studio context.",
    icon: "sparkles-outline"
  },
  {
    key: "about",
    title: "About",
    detail: "Studio story and public description.",
    icon: "reader-outline"
  },
  {
    key: "dance-styles",
    title: "Dance Styles",
    detail: "Dance families and styles this studio teaches.",
    icon: "musical-notes-outline"
  },
  {
    key: "staff",
    title: "Staff",
    detail: "Public instructor profiles and headshots.",
    icon: "people-outline"
  },
  {
    key: "offerings",
    title: "Offerings",
    detail: "Lessons, classes, coaching, socials, and more.",
    icon: "pricetags-outline"
  },
  {
    key: "events",
    title: "Events",
    detail: "Upcoming public events from this studio.",
    icon: "calendar-outline"
  },
  {
    key: "contact",
    title: "Contact",
    detail: "Website, email, phone, and location details.",
    icon: "chatbubble-ellipses-outline"
  }
];

function initialsFor(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function TagList({ empty, tags }: { empty: string; tags: PublicStudioTag[] }) {
  if (!tags.length) {
    return <FeatureCard title="Nothing listed yet" detail={empty} />;
  }

  return (
    <View style={styles.tagWrap}>
      {tags.map((tag) => (
        <View key={tag.key} style={styles.tag}>
          <AppText style={styles.tagText}>{tag.label}</AppText>
        </View>
      ))}
    </View>
  );
}

function StaffCard({ member }: { member: PublicStudioStaffMember }) {
  return (
    <View style={styles.staffCard}>
      {member.photoUrl ? (
        <Image source={{ uri: member.photoUrl }} style={styles.staffPhoto} />
      ) : (
        <View style={styles.staffPhotoFallback}>
          <AppText style={styles.staffInitials}>{initialsFor(member.name)}</AppText>
        </View>
      )}
      <View style={{ flex: 1 }}>
        <AppText style={styles.staffName}>{member.name}</AppText>
        {member.title ? <AppText variant="caption">{member.title}</AppText> : null}
        {member.bio ? <AppText style={styles.description}>{member.bio}</AppText> : null}
        {member.specialties ? (
          <AppText variant="caption">Specialties: {member.specialties}</AppText>
        ) : null}
        {member.yearsExperience !== null ? (
          <AppText variant="caption">
            {member.yearsExperience} year{member.yearsExperience === 1 ? "" : "s"} experience
          </AppText>
        ) : null}
        {member.teachingCertifications ? (
          <AppText variant="caption">Certifications: {member.teachingCertifications}</AppText>
        ) : null}
        {member.competitiveTitles ? (
          <AppText variant="caption">Titles: {member.competitiveTitles}</AppText>
        ) : null}
      </View>
    </View>
  );
}

function EventCard({
  event,
  onOpen
}: {
  event: PublicEventItem;
  onOpen: (event: PublicEventItem) => void;
}) {
  return (
    <Pressable onPress={() => onOpen(event)} style={({ pressed }) => [styles.eventCard, pressed && styles.pressed]}>
      <View style={{ flex: 1 }}>
        <AppText style={styles.eventName}>{event.name}</AppText>
        <AppText variant="caption">{event.schedule}</AppText>
        <AppText variant="caption">{event.location}</AppText>
      </View>
      <Ionicons color={colors.primary} name="chevron-forward" size={20} />
    </Pressable>
  );
}

function formatSlotLabel(slot: StudioSelfServiceSlot) {
  const startsAt = new Date(slot.startsAt);

  if (Number.isNaN(startsAt.getTime())) {
    return `${slot.date} · ${slot.startTime} - ${slot.endTime}`;
  }

  const day = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    weekday: "short"
  }).format(startsAt);

  return `${day} · ${slot.startTime} - ${slot.endTime}`;
}

export function StudioSectionScreen({ section }: { section: StudioSection }) {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();
  const [studio, setStudio] = useState<PublicStudioDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [favoriteMessage, setFavoriteMessage] = useState<string | null>(null);
  const [savingFavorite, setSavingFavorite] = useState(false);
  const [selfServiceInstructors, setSelfServiceInstructors] = useState<StudioSelfServiceInstructor[]>([]);
  const [selectedInstructorId, setSelectedInstructorId] = useState("");
  const [selfServiceSlots, setSelfServiceSlots] = useState<StudioSelfServiceSlot[]>([]);
  const [selfServiceLoading, setSelfServiceLoading] = useState(false);
  const [selfServiceMessage, setSelfServiceMessage] = useState<string | null>(null);
  const [selfServiceError, setSelfServiceError] = useState<string | null>(null);
  const [requestingSlotKey, setRequestingSlotKey] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    if (!id) return;

    setLoading(true);
    setErrorMessage(null);
    getPublicStudioDetailForMobile(id, session?.user.id)
      .then((detail) => {
        if (!mounted) return;
        setStudio(detail);
      })
      .catch(() => {
        if (!mounted) return;
        setErrorMessage("This studio could not be loaded.");
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [id, session?.user.id]);

  useEffect(() => {
    let mounted = true;

    if (section !== "contact" || !studio || !session?.user.id) {
      setSelfServiceInstructors([]);
      setSelfServiceSlots([]);
      setSelectedInstructorId("");
      return;
    }

    setSelfServiceLoading(true);
    setSelfServiceError(null);
    setSelfServiceMessage(null);

    loadStudioSelfServiceSlots({
      instructorId: selectedInstructorId || null,
      studioSlug: studio.slug
    })
      .then((result) => {
        if (!mounted) return;
        setSelfServiceInstructors(result.instructors);
        setSelfServiceSlots(selectedInstructorId ? result.slots : []);
        if (!result.bookingDecision.allowed) {
          setSelfServiceError(result.bookingDecision.reason ?? "Self-service lesson requests are not available.");
        }
      })
      .catch((error) => {
        if (!mounted) return;
        setSelfServiceInstructors([]);
        setSelfServiceSlots([]);
        setSelfServiceError(error instanceof Error ? error.message : "Could not load request slots.");
      })
      .finally(() => {
        if (!mounted) return;
        setSelfServiceLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [section, selectedInstructorId, session?.user.id, studio]);

  if (loading) {
    return (
      <Screen>
        <FeatureCard title="Loading studio" detail="Checking the public studio profile." />
      </Screen>
    );
  }

  if (!studio || errorMessage) {
    return (
      <Screen>
        <FeatureCard title="Studio unavailable" detail={errorMessage ?? "This studio could not be found."} />
        <AppButton label="Back to studios" onPress={() => router.push("/discover/studios" as unknown as RouterPushTarget)} />
      </Screen>
    );
  }

  const openSection = (key: Exclude<StudioSection, "hub">) => {
    router.push(`/studios/${studio.id}/${key}` as unknown as RouterPushTarget);
  };

  const openEvent = (event: PublicEventItem) => {
    router.push(`/events/${event.id}` as unknown as RouterPushTarget);
  };

  const toggleFavorite = async () => {
    const userId = session?.user.id ?? null;

    if (!studio || !userId) {
      setFavoriteMessage("Sign in to save studios.");
      return;
    }

    setSavingFavorite(true);
    setFavoriteMessage(null);

    try {
      await setPublicFavoriteForMobile({
        favorited: !studio.favorited,
        targetId: studio.id,
        targetType: "studio",
        userId
      });

      setStudio({ ...studio, favorited: !studio.favorited });
      setFavoriteMessage(
        !studio.favorited ? "Studio saved to your favorites." : "Studio removed from your favorites."
      );
    } catch {
      setFavoriteMessage("We could not update your favorite yet. Please try again.");
    } finally {
      setSavingFavorite(false);
    }
  };

  const requestSlot = async (slot: StudioSelfServiceSlot) => {
    if (!studio || !selectedInstructorId) return;

    setRequestingSlotKey(slot.startsAt);
    setSelfServiceError(null);
    setSelfServiceMessage(null);

    try {
      const result = await submitStudioSelfServiceRequest({
        instructorId: selectedInstructorId,
        slot,
        studioSlug: studio.slug
      });

      setSelfServiceMessage(
        result.bookingDecision.mode === "instant"
          ? "Lesson booked. Check your schedule for details."
          : "Lesson request sent. The studio will review it."
      );
      setSelfServiceSlots((current) => current.filter((item) => item.startsAt !== slot.startsAt));
    } catch (error) {
      setSelfServiceError(error instanceof Error ? error.message : "Could not send that lesson request.");
    } finally {
      setRequestingSlotKey(null);
    }
  };

  return (
    <Screen>
      <View style={styles.hero}>
        {studio.heroImageUrl ? (
          <Image source={{ uri: studio.heroImageUrl }} style={styles.heroImage} />
        ) : null}
        <View style={styles.heroContent}>
          {studio.logoUrl ? (
            <Image source={{ uri: studio.logoUrl }} style={styles.logo} />
          ) : (
            <View style={styles.logoFallback}>
              <AppText style={styles.logoInitials}>{initialsFor(studio.name)}</AppText>
            </View>
          )}
          <View style={{ flex: 1 }}>
            <AppText variant="eyebrow">Studio</AppText>
            <AppText style={styles.title}>{studio.name}</AppText>
            <AppText variant="caption">{studio.location}</AppText>
          </View>
        </View>
      </View>

      <View style={styles.footerActions}>
        <Pressable
          accessibilityLabel={studio.favorited ? "Remove saved studio" : "Save studio"}
          disabled={savingFavorite}
          onPress={toggleFavorite}
          style={({ pressed }) => [
            styles.iconButton,
            studio.favorited && styles.iconButtonActive,
            pressed && styles.pressed,
            savingFavorite && styles.disabled
          ]}
        >
          <Ionicons
            color={studio.favorited ? "#fff" : colors.primary}
            name={studio.favorited ? "heart" : "heart-outline"}
            size={20}
          />
        </Pressable>
        <Pressable
          accessibilityLabel="Share studio"
          onPress={() =>
            Share.share({
              title: studio.name,
              message: `${studio.name}\n${studio.webUrl}`,
              url: studio.webUrl
            })
          }
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
        >
          <Ionicons color={colors.primary} name="share-outline" size={20} />
        </Pressable>
        {section !== "hub" ? (
          <AppButton label="All studio sections" onPress={() => router.push(`/studios/${studio.id}` as unknown as RouterPushTarget)} variant="secondary" />
        ) : null}
      </View>

      {favoriteMessage ? <AppText variant="caption">{favoriteMessage}</AppText> : null}

      {section === "hub" ? (
        <>
          {studio.description ? <AppText style={styles.description}>{studio.description}</AppText> : null}
          <View style={styles.sectionGrid}>
            {STUDIO_SECTIONS.map((item) => (
              <Pressable
                key={item.key}
                onPress={() => openSection(item.key)}
                style={({ pressed }) => [styles.sectionButton, pressed && styles.pressed]}
              >
                <View style={styles.sectionIcon}>
                  <Ionicons color={colors.primary} name={item.icon} size={22} />
                </View>
                <View style={{ flex: 1 }}>
                  <AppText style={styles.sectionTitle}>{item.title}</AppText>
                  <AppText variant="caption">{item.detail}</AppText>
                </View>
                <Ionicons color={colors.primary} name="chevron-forward" size={18} />
              </Pressable>
            ))}
          </View>
        </>
      ) : null}

      {section === "overview" ? (
        <>
          <View style={styles.infoCard}>
            <AppText variant="subtitle">Overview</AppText>
            <AppText>{studio.description ?? "This studio has not added an overview yet."}</AppText>
            {studio.beginnerFriendly ? (
              <View style={styles.badge}>
                <AppText style={styles.badgeText}>Beginner friendly</AppText>
              </View>
            ) : null}
          </View>
          <View style={styles.infoCard}>
            <AppText variant="subtitle">Quick Details</AppText>
            <AppText variant="caption">{studio.location}</AppText>
            <AppText variant="caption">
              {studio.styles.length} dance style{studio.styles.length === 1 ? "" : "s"} listed
            </AppText>
            <AppText variant="caption">
              {studio.upcomingEvents.length} upcoming event{studio.upcomingEvents.length === 1 ? "" : "s"}
            </AppText>
          </View>
        </>
      ) : null}

      {section === "about" ? (
        <View style={styles.infoCard}>
          <AppText variant="subtitle">About</AppText>
          <AppText>{studio.about || studio.description || "This studio has not added an about section yet."}</AppText>
        </View>
      ) : null}

      {section === "dance-styles" ? (
        <>
          <AppText variant="subtitle">Dance Styles</AppText>
          <TagList empty="This studio has not selected public dance styles yet." tags={studio.styles} />
        </>
      ) : null}

      {section === "staff" ? (
        <>
          <AppText variant="subtitle">Staff</AppText>
          {studio.staff.length ? (
            studio.staff.map((member) => <StaffCard key={member.id} member={member} />)
          ) : (
            <FeatureCard title="No public staff yet" detail="This studio has not published staff profiles." />
          )}
        </>
      ) : null}

      {section === "offerings" ? (
        <>
          <AppText variant="subtitle">Offerings</AppText>
          <TagList empty="This studio has not selected public offerings yet." tags={studio.offerings} />
        </>
      ) : null}

      {section === "events" ? (
        <>
          <AppText variant="subtitle">Events</AppText>
          {studio.upcomingEvents.length ? (
            studio.upcomingEvents.map((event) => (
              <EventCard key={event.id} event={event} onOpen={openEvent} />
            ))
          ) : (
            <FeatureCard title="No upcoming events" detail="This studio does not have public events listed right now." />
          )}
        </>
      ) : null}

      {section === "contact" ? (
        <>
          <View style={styles.infoCard}>
            <AppText variant="subtitle">Request a Lesson Slot</AppText>
            <AppText variant="caption">
              Choose an instructor, then request one of the available self-service lesson times.
            </AppText>

            {!session ? (
              <AppButton
                label="Sign in to request a lesson"
                onPress={() => router.push("/(auth)/sign-in" as unknown as RouterPushTarget)}
              />
            ) : null}

            {session && selfServiceLoading ? (
              <FeatureCard title="Loading request slots" detail="Checking instructor availability." />
            ) : null}

            {session && selfServiceError ? (
              <FeatureCard title="Request slots unavailable" detail={selfServiceError} />
            ) : null}

            {session && selfServiceMessage ? (
              <FeatureCard title="Request sent" detail={selfServiceMessage} />
            ) : null}

            {session && selfServiceInstructors.length > 0 ? (
              <>
                <AppText style={styles.fieldLabel}>Choose Instructor</AppText>
                <View style={styles.chipWrap}>
                  {selfServiceInstructors.map((instructor) => {
                    const selected = selectedInstructorId === instructor.id;

                    return (
                      <Pressable
                        key={instructor.id}
                        onPress={() => setSelectedInstructorId(instructor.id)}
                        style={({ pressed }) => [
                          styles.choiceChip,
                          selected && styles.choiceChipActive,
                          pressed && styles.pressed
                        ]}
                      >
                        <AppText style={[styles.choiceChipText, selected && styles.choiceChipTextActive]}>
                          {instructor.name}
                        </AppText>
                      </Pressable>
                    );
                  })}
                </View>
              </>
            ) : null}

            {session && selectedInstructorId && !selfServiceLoading ? (
              selfServiceSlots.length ? (
                <View style={styles.slotList}>
                  {selfServiceSlots.slice(0, 12).map((slot) => (
                    <Pressable
                      key={`${slot.startsAt}-${slot.instructorId ?? "any"}`}
                      disabled={requestingSlotKey === slot.startsAt}
                      onPress={() => requestSlot(slot)}
                      style={({ pressed }) => [
                        styles.slotCard,
                        pressed && styles.pressed,
                        requestingSlotKey === slot.startsAt && styles.disabled
                      ]}
                    >
                      <View style={{ flex: 1 }}>
                        <AppText style={styles.slotTitle}>{formatSlotLabel(slot)}</AppText>
                        <AppText variant="caption">Tap to send this request.</AppText>
                      </View>
                      <Ionicons color={colors.primary} name="send-outline" size={20} />
                    </Pressable>
                  ))}
                </View>
              ) : (
                <FeatureCard title="No slots showing" detail="Try another instructor or check back when the studio opens more availability." />
              )
            ) : null}
          </View>

          <View style={styles.infoCard}>
            <AppText variant="subtitle">Contact</AppText>
            <AppText variant="caption">{studio.location}</AppText>
            {studio.phone ? <AppText variant="caption">{studio.phone}</AppText> : null}
            {studio.email ? <AppText variant="caption">{studio.email}</AppText> : null}
            <View style={styles.actionRow}>
              {studio.websiteUrl ? (
                <AppButton label="Website" onPress={() => Linking.openURL(studio.websiteUrl!)} variant="secondary" />
              ) : null}
              {studio.email ? (
                <AppButton label="Email" onPress={() => Linking.openURL(`mailto:${studio.email}`)} variant="secondary" />
              ) : null}
              {studio.phone ? (
                <AppButton label="Call" onPress={() => Linking.openURL(`tel:${studio.phone}`)} variant="secondary" />
              ) : null}
            </View>
          </View>
        </>
      ) : null}

    </Screen>
  );
}

const styles = StyleSheet.create({
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginTop: 8
  },
  badge: {
    alignSelf: "flex-start",
    backgroundColor: "#fff4e7",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  badgeText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "900"
  },
  chipWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  choiceChip: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9
  },
  choiceChipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary
  },
  choiceChipText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "900"
  },
  choiceChipTextActive: {
    color: "#fff"
  },
  description: {
    color: colors.text,
    fontSize: 14,
    lineHeight: 21
  },
  disabled: {
    opacity: 0.55
  },
  eventCard: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 14
  },
  eventName: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "900"
  },
  fieldLabel: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "900"
  },
  footerActions: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  hero: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 24,
    borderWidth: 1,
    overflow: "hidden"
  },
  heroContent: {
    alignItems: "center",
    flexDirection: "row",
    gap: 14,
    padding: 16
  },
  heroImage: {
    backgroundColor: colors.surfaceAlt,
    height: 130,
    width: "100%"
  },
  iconButton: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 14,
    height: 44,
    justifyContent: "center",
    width: 48
  },
  iconButtonActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary
  },
  infoCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
    padding: 16
  },
  logo: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 16,
    height: 62,
    width: 62
  },
  logoFallback: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    height: 62,
    justifyContent: "center",
    width: 62
  },
  logoInitials: {
    color: colors.primary,
    fontSize: 18,
    fontWeight: "900"
  },
  pressed: {
    opacity: 0.78
  },
  sectionButton: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 14
  },
  sectionGrid: {
    gap: 10
  },
  sectionIcon: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderRadius: 14,
    height: 44,
    justifyContent: "center",
    width: 44
  },
  sectionTitle: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "900"
  },
  slotCard: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 14
  },
  slotList: {
    gap: 8
  },
  slotTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "900"
  },
  staffCard: {
    alignItems: "flex-start",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 14,
    padding: 14
  },
  staffInitials: {
    color: colors.primary,
    fontSize: 20,
    fontWeight: "900"
  },
  staffName: {
    color: colors.text,
    fontSize: 17,
    fontWeight: "900"
  },
  staffPhoto: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 18,
    height: 72,
    width: 72
  },
  staffPhotoFallback: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    height: 72,
    justifyContent: "center",
    width: 72
  },
  tag: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  tagText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: "900"
  },
  tagWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  title: {
    color: colors.text,
    fontSize: 24,
    fontWeight: "900"
  }
});
