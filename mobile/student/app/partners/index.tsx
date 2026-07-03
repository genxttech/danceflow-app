import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  getPublicPartnerProfilesForMobile,
  type PublicPartnerProfileItem
} from "@/lib/publicDiscovery";
import {
  loadMyPartnerProfile,
  requestPartnerConnection,
  saveMyPartnerProfile,
  type DancerPartnerProfile,
  type PartnerListingIntent,
  type PartnerRole,
  type PartnerSkillLevel,
  type PartnerVisibility
} from "@/lib/partnerSearch";

type RequestDrafts = Record<string, string>;

type EditablePartnerProfile = DancerPartnerProfile & {
  photoUrl?: string | null;
  profilePhotoUrl?: string | null;
};

const intentOptions: Array<{ label: string; value: PartnerListingIntent }> = [
  { label: "Practice", value: "practice" },
  { label: "Social", value: "social" },
  { label: "Showcase", value: "showcase" },
  { label: "Competition", value: "competition" }
];

const roleOptions: Array<{ label: string; value: PartnerRole }> = [
  { label: "Either", value: "either" },
  { label: "Lead", value: "lead" },
  { label: "Follow", value: "follow" },
  { label: "Switch", value: "switch" }
];

const skillOptions: Array<{ label: string; value: PartnerSkillLevel }> = [
  { label: "Newcomer", value: "newcomer" },
  { label: "Beginner", value: "beginner" },
  { label: "Social", value: "social" },
  { label: "Intermediate", value: "intermediate" },
  { label: "Advanced", value: "advanced" },
  { label: "Professional", value: "professional" }
];

const danceStyleGroups = [
  {
    label: "Country",
    styles: ["Country Two Step", "West Coast Swing", "East Coast Swing", "Nightclub Two Step", "Country Waltz", "Polka"]
  },
  {
    label: "Ballroom",
    styles: ["Waltz", "Tango", "Foxtrot", "Viennese Waltz", "Quickstep"]
  },
  {
    label: "Latin and Rhythm",
    styles: ["Cha Cha", "Rumba", "Samba", "Paso Doble", "Jive", "Bolero", "Mambo"]
  },
  {
    label: "Social and Club",
    styles: ["Salsa", "Bachata", "Kizomba", "Zouk", "Argentine Tango", "Hustle"]
  }
];

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function labelFor(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function parseList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinList(values: string[]) {
  return Array.from(new Set(values)).join(", ");
}

function profilePhotoUrl(profile: EditablePartnerProfile) {
  return profile.photoUrl?.trim() || profile.profilePhotoUrl?.trim() || "";
}

function Field({
  label,
  multiline = false,
  onChangeText,
  placeholder,
  value
}: {
  label: string;
  multiline?: boolean;
  onChangeText: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <View style={styles.field}>
      <AppText variant="eyebrow">{label}</AppText>
      <TextInput
        multiline={multiline}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        style={[styles.input, multiline ? styles.multilineInput : null]}
        value={value}
      />
    </View>
  );
}

function OptionRow<T extends string>({
  options,
  value,
  onChange
}: {
  options: Array<{ label: string; value: T }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.optionRow}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            style={[styles.optionPill, active && styles.optionPillActive]}
          >
            <AppText style={[styles.optionText, active && styles.optionTextActive]}>
              {option.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

function DanceStylePicker({
  value,
  onChange
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const selected = parseList(value);

  function toggle(style: string) {
    const active = selected.includes(style);
    onChange(joinList(active ? selected.filter((item) => item !== style) : [...selected, style]));
  }

  return (
    <View style={styles.stylePicker}>
      {danceStyleGroups.map((group) => (
        <View key={group.label} style={styles.styleGroup}>
          <AppText style={styles.styleGroupTitle}>{group.label}</AppText>
          <View style={styles.optionRow}>
            {group.styles.map((style) => {
              const active = selected.includes(style);
              return (
                <Pressable
                  key={style}
                  onPress={() => toggle(style)}
                  style={[styles.optionPill, active && styles.optionPillActive]}
                >
                  <AppText style={[styles.optionText, active && styles.optionTextActive]}>
                    {style}
                  </AppText>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}
    </View>
  );
}

export default function PartnerSearchScreen() {
  const { session } = useAuth();
  const user = session?.user ?? null;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profiles, setProfiles] = useState<PublicPartnerProfileItem[]>([]);
  const [myProfile, setMyProfile] = useState<EditablePartnerProfile | null>(null);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [requestDrafts, setRequestDrafts] = useState<RequestDrafts>({});
  const [requestBusyId, setRequestBusyId] = useState<string | null>(null);

  const filteredProfiles = useMemo(() => {
    const search = normalize(query);
    if (!search) return profiles;

    return profiles.filter((profile) =>
      [
        profile.displayName,
        profile.headline,
        profile.bio,
        profile.location,
        profile.leadFollowRole,
        profile.skillLevel,
        profile.listingIntent,
        ...profile.danceStyles,
        ...profile.goals
      ].some((value) => normalize(value).includes(search))
    );
  }, [profiles, query]);

  async function loadPartnerSearch() {
    if (!user) return;

    setLoading(true);
    setErrorMessage(null);

    try {
      const [ownProfile, publicProfiles] = await Promise.all([
        loadMyPartnerProfile(user.id, user.email),
        getPublicPartnerProfilesForMobile()
      ]);
      setMyProfile(ownProfile as EditablePartnerProfile);
      setProfiles(publicProfiles);
    } catch {
      setErrorMessage("Partner Search is not available yet. Try again in a moment.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadPartnerSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  function updateProfile(updater: (profile: EditablePartnerProfile) => EditablePartnerProfile) {
    setMyProfile((current) => (current ? updater(current) : current));
  }

  async function saveProfile(visibility: PartnerVisibility) {
    if (!user || !myProfile) return;

    setSaving(true);
    setMessage(null);
    setErrorMessage(null);

    try {
      const result = await saveMyPartnerProfile(user.id, {
        ...myProfile,
        visibility
      } as DancerPartnerProfile);

      if (result.advertisingRisk) {
        setMessage(
          "Saved as a draft. Remove lesson ads, coaching offers, links, phone numbers, or service language before submitting."
        );
      } else if (result.visibility === "published") {
        setMessage("Listing submitted for review. It appears after approval.");
      } else {
        setMessage("Partner listing saved.");
      }

      await loadPartnerSearch();
    } catch {
      setErrorMessage("We could not save your partner listing yet.");
    } finally {
      setSaving(false);
    }
  }

  async function sendConnectionRequest(profileId: string) {
    if (!user) return;

    const draft = requestDrafts[profileId]?.trim();
    if (!draft) {
      setMessage("Add a short request message first.");
      return;
    }

    setRequestBusyId(profileId);
    setMessage(null);
    setErrorMessage(null);

    try {
      await requestPartnerConnection({
        partnerProfileId: profileId,
        requesterUserId: user.id,
        message: draft
      });
      setRequestDrafts((current) => ({ ...current, [profileId]: "" }));
      setMessage("Connection request sent.");
    } catch {
      setErrorMessage("We could not send that request yet.");
    } finally {
      setRequestBusyId(null);
    }
  }

  return (
    <Screen>
      <AppText variant="eyebrow">Partner Search</AppText>
      <AppText variant="title">Find a dance partner</AppText>
      <AppText variant="caption">
        Create a dancer-owned listing for practice, social dance, showcase, or competition partners. Contact stays inside DanceFlow.
      </AppText>

      {loading ? <FeatureCard title="Loading Partner Search" detail="Loading dancer listings." /> : null}
      {message ? <FeatureCard title="Partner Search" detail={message} /> : null}
      {errorMessage ? <FeatureCard title="Partner Search needs attention" detail={errorMessage} /> : null}

      <View style={styles.safetyCard}>
        <View style={styles.safetyIcon}>
          <Ionicons color="#fff" name="shield-checkmark-outline" size={22} />
        </View>
        <View style={{ flex: 1 }}>
          <AppText style={styles.safetyTitle}>Safety and listing rules</AppText>
          <AppText style={styles.safetyText}>
            Partner Search is for dancers looking for partners. Lesson ads, coaching offers, paid services, outside links, public phone numbers, and studio promos are not allowed.
          </AppText>
        </View>
      </View>

      {myProfile ? (
        <View style={styles.editorCard}>
          <View style={styles.editorHeader}>
            <View style={{ flex: 1 }}>
              <AppText variant="eyebrow">Your listing</AppText>
              <AppText variant="subtitle">
                {myProfile.visibility === "published" ? "Submitted for review" : "Draft listing"}
              </AppText>
            </View>
            <View style={styles.statusPill}>
              <AppText style={styles.statusText}>
                {labelFor(myProfile.moderationStatus)}
              </AppText>
            </View>
          </View>

          <Field
            label="Display name"
            onChangeText={(value) => updateProfile((profile) => ({ ...profile, displayName: value }))}
            value={myProfile.displayName}
          />
          <View style={styles.photoCard}>
            {profilePhotoUrl(myProfile) ? (
              <Image
                accessibilityIgnoresInvertColors
                resizeMode="cover"
                source={{ uri: profilePhotoUrl(myProfile) }}
                style={styles.profilePhoto}
              />
            ) : (
              <View style={styles.photoPlaceholder}>
                <Ionicons color={colors.primary} name="person-outline" size={30} />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Field
                label="Profile photo URL"
                onChangeText={(value) => updateProfile((profile) => ({ ...profile, photoUrl: value }))}
                placeholder="https://..."
                value={profilePhotoUrl(myProfile)}
              />
              <AppText variant="caption">
                Add one clear photo of yourself. Public contact details and promotional images are not allowed.
              </AppText>
            </View>
          </View>
          <Field
            label="Headline"
            onChangeText={(value) => updateProfile((profile) => ({ ...profile, headline: value }))}
            placeholder="Looking for a country two step practice partner"
            value={myProfile.headline}
          />
          <View style={styles.twoColumn}>
            <Field
              label="City"
              onChangeText={(value) => updateProfile((profile) => ({ ...profile, city: value }))}
              value={myProfile.city}
            />
            <Field
              label="State"
              onChangeText={(value) => updateProfile((profile) => ({ ...profile, state: value }))}
              value={myProfile.state}
            />
          </View>

          <View style={styles.field}>
            <AppText variant="eyebrow">Looking for</AppText>
            <OptionRow
              options={intentOptions}
              value={myProfile.listingIntent}
              onChange={(value) => updateProfile((profile) => ({ ...profile, listingIntent: value }))}
            />
          </View>

          <View style={styles.field}>
            <AppText variant="eyebrow">Role</AppText>
            <OptionRow
              options={roleOptions}
              value={myProfile.leadFollowRole}
              onChange={(value) => updateProfile((profile) => ({ ...profile, leadFollowRole: value }))}
            />
          </View>

          <View style={styles.field}>
            <AppText variant="eyebrow">Level</AppText>
            <OptionRow
              options={skillOptions}
              value={myProfile.skillLevel}
              onChange={(value) => updateProfile((profile) => ({ ...profile, skillLevel: value }))}
            />
          </View>

          <View style={styles.field}>
            <AppText variant="eyebrow">Dance styles</AppText>
            <DanceStylePicker
              value={myProfile.danceStyles}
              onChange={(value) => updateProfile((profile) => ({ ...profile, danceStyles: value }))}
            />
          </View>
          <Field
            label="Goals"
            onChangeText={(value) => updateProfile((profile) => ({ ...profile, goals: value }))}
            placeholder="Practice, social dance, showcase, competition"
            value={myProfile.goals}
          />
          <Field
            label="Bio"
            multiline
            onChangeText={(value) => updateProfile((profile) => ({ ...profile, bio: value }))}
            value={myProfile.bio}
          />
          <Field
            label="Availability"
            multiline
            onChangeText={(value) => updateProfile((profile) => ({ ...profile, availabilityNotes: value }))}
            placeholder="Weeknights after 6, Saturdays, local socials..."
            value={myProfile.availabilityNotes}
          />

          {myProfile.moderationReason ? (
            <FeatureCard title="Review note" detail={myProfile.moderationReason} />
          ) : null}

          <View style={styles.actionRow}>
            <AppButton
              label={saving ? "Saving..." : "Save Draft"}
              onPress={() => saveProfile("draft")}
              variant="secondary"
            />
            <AppButton
              label={saving ? "Submitting..." : "Submit for Review"}
              onPress={() => saveProfile("published")}
            />
          </View>
        </View>
      ) : null}

      <View style={styles.searchCard}>
        <AppText variant="eyebrow">Browse</AppText>
        <TextInput
          autoCapitalize="none"
          onChangeText={setQuery}
          placeholder="Search style, city, role, goal, or level"
          placeholderTextColor={colors.muted}
          style={styles.input}
          value={query}
        />
      </View>

      {filteredProfiles.length ? (
        filteredProfiles.map((profile) => (
          <View key={profile.id} style={styles.partnerCard}>
            <View style={styles.partnerTop}>
              <View style={{ flex: 1 }}>
                <AppText style={styles.partnerName}>{profile.displayName}</AppText>
                <AppText variant="caption">{profile.location}</AppText>
              </View>
              <View style={styles.intentBadge}>
                <AppText style={styles.intentBadgeText}>{labelFor(profile.listingIntent)}</AppText>
              </View>
            </View>
            <AppText style={styles.partnerHeadline}>
              {profile.headline || "Looking for a dance partner"}
            </AppText>
            {profile.bio ? <AppText variant="caption">{profile.bio}</AppText> : null}
            <View style={styles.tagRow}>
              <View style={styles.tag}>
                <AppText style={styles.tagText}>{labelFor(profile.leadFollowRole)}</AppText>
              </View>
              <View style={styles.tag}>
                <AppText style={styles.tagText}>{labelFor(profile.skillLevel)}</AppText>
              </View>
              {profile.danceStyles.slice(0, 4).map((style) => (
                <View key={style} style={styles.accentTag}>
                  <AppText style={styles.accentTagText}>{style}</AppText>
                </View>
              ))}
            </View>
            <TextInput
              multiline
              onChangeText={(value) =>
                setRequestDrafts((current) => ({ ...current, [profile.id]: value }))
              }
              placeholder="Write a short, respectful connection request"
              placeholderTextColor={colors.muted}
              style={[styles.input, styles.requestInput]}
              value={requestDrafts[profile.id] ?? ""}
            />
            <AppButton
              label={requestBusyId === profile.id ? "Sending..." : "Request to Connect"}
              onPress={() => sendConnectionRequest(profile.id)}
            />
          </View>
        ))
      ) : !loading ? (
        <FeatureCard
          title="No partner listings yet"
          detail="Try a broader search or submit your own listing for review."
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  accentTag: {
    backgroundColor: "#fff4e7",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  accentTagText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "800"
  },
  actionRow: {
    gap: 10
  },
  editorCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    gap: 14,
    padding: 16
  },
  editorHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12
  },
  field: {
    gap: 6
  },
  input: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  intentBadge: {
    backgroundColor: "#fff4e7",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  intentBadgeText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "900"
  },
  multilineInput: {
    minHeight: 96,
    textAlignVertical: "top"
  },
  optionPill: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 8
  },
  optionPillActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary
  },
  optionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  optionText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "800"
  },
  optionTextActive: {
    color: "#fff"
  },
  partnerCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    gap: 12,
    padding: 16
  },
  partnerHeadline: {
    color: colors.text,
    fontSize: 16,
    fontWeight: "800"
  },
  partnerName: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "900"
  },
  partnerTop: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 12
  },
  photoCard: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 12
  },
  photoPlaceholder: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 24,
    borderWidth: 1,
    height: 72,
    justifyContent: "center",
    width: 72
  },
  profilePhoto: {
    borderRadius: 24,
    height: 72,
    width: 72
  },
  requestInput: {
    minHeight: 86,
    textAlignVertical: "top"
  },
  safetyCard: {
    alignItems: "flex-start",
    backgroundColor: colors.primaryDark,
    borderRadius: 20,
    flexDirection: "row",
    gap: 12,
    padding: 16
  },
  safetyIcon: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.16)",
    borderRadius: 999,
    height: 42,
    justifyContent: "center",
    width: 42
  },
  safetyText: {
    color: "rgba(255,255,255,0.82)",
    fontSize: 13,
    lineHeight: 19
  },
  safetyTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "900",
    marginBottom: 4
  },
  searchCard: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 10,
    padding: 14
  },
  statusPill: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  statusText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: "900"
  },
  styleGroup: {
    gap: 8
  },
  styleGroupTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "900"
  },
  stylePicker: {
    gap: 12
  },
  tag: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  tagRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8
  },
  tagText: {
    color: colors.primary,
    fontSize: 12,
    fontWeight: "800"
  },
  twoColumn: {
    flexDirection: "row",
    gap: 10
  }
});
