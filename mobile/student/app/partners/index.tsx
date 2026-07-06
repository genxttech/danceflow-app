import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { useRouter } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { useAuth } from "@/lib/auth";
import {
  getPublicPartnerProfilesForMobile,
  setPublicFavoriteForMobile,
  type PublicPartnerProfileItem
} from "@/lib/publicDiscovery";
import {
  loadMyPartnerThreads,
  loadMyPartnerProfile,
  requestPartnerConnection,
  saveMyPartnerProfile,
  uploadPartnerProfilePhoto,
  type DancerPartnerProfile,
  type PartnerConversationThread,
  type PartnerListingIntent,
  type PartnerRole,
  type PartnerSkillLevel,
  type PartnerVisibility
} from "@/lib/partnerSearch";

type RequestDrafts = Record<string, string>;
type RouterPushTarget = Parameters<ReturnType<typeof useRouter>["push"]>[0];
type FilterLocation = { latitude: number; longitude: number } | null;

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

const goalOptions = intentOptions.map((option) => option.label);

const stateOptions = [
  "AL",
  "AK",
  "AZ",
  "AR",
  "CA",
  "CO",
  "CT",
  "DE",
  "DC",
  "FL",
  "GA",
  "HI",
  "ID",
  "IL",
  "IN",
  "IA",
  "KS",
  "KY",
  "LA",
  "ME",
  "MD",
  "MA",
  "MI",
  "MN",
  "MS",
  "MO",
  "MT",
  "NE",
  "NV",
  "NH",
  "NJ",
  "NM",
  "NY",
  "NC",
  "ND",
  "OH",
  "OK",
  "OR",
  "PA",
  "RI",
  "SC",
  "SD",
  "TN",
  "TX",
  "UT",
  "VT",
  "VA",
  "WA",
  "WV",
  "WI",
  "WY"
];

const danceStyleGroups = [
  {
    label: "American Smooth",
    styles: ["Waltz", "Tango", "Foxtrot", "Viennese Waltz"]
  },
  {
    label: "American Rhythm",
    styles: ["Cha Cha", "Rumba", "East Coast Swing", "Bolero", "Mambo"]
  },
  {
    label: "International Ballroom",
    styles: ["Waltz", "Tango", "Viennese Waltz", "Foxtrot", "Quickstep"]
  },
  {
    label: "International Latin",
    styles: ["Cha Cha", "Samba", "Rumba", "Paso Doble", "Jive"]
  },
  {
    label: "Country",
    styles: ["Country Two Step", "West Coast Swing", "East Coast Swing", "Nightclub Two Step", "Country Waltz", "Polka"]
  },
  {
    label: "Social / Club",
    styles: ["Salsa", "Bachata", "Argentine Tango", "Hustle", "Lindy Hop", "Zouk", "Kizomba"]
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

function selectionSummary(values: string[], emptyLabel = "Any") {
  if (values.length === 0) return emptyLabel;
  if (values.length === 1) return values[0];
  return `${values.length} selected`;
}

function toggleListValue(value: string, listValue: string) {
  const selected = parseList(listValue);
  const active = selected.includes(value);
  return joinList(active ? selected.filter((item) => item !== value) : [...selected, value]);
}

function styleFilterOptions(styles: string[]) {
  const expanded = new Set<string>();

  styles.forEach((selectedStyle) => {
    const group = danceStyleGroups.find((item) => normalize(item.label) === normalize(selectedStyle));

    if (group) {
      expanded.add(group.label);
      group.styles.forEach((groupStyle) => expanded.add(groupStyle));
      return;
    }

    expanded.add(selectedStyle);
  });

  return Array.from(expanded);
}

function profilePhotoUrl(profile: DancerPartnerProfile) {
  return profile.photoUrl.trim();
}

function initialsFor(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}

function milesBetween(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
) {
  const earthRadiusMiles = 3958.8;
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 2 * earthRadiusMiles * Math.asin(Math.sqrt(h));
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
  const [expanded, setExpanded] = useState(false);
  const selected = parseList(value);

  function toggle(style: string) {
    const active = selected.includes(style);
    onChange(joinList(active ? selected.filter((item) => item !== style) : [...selected, style]));
  }

  return (
    <View style={styles.stylePicker}>
      <Pressable onPress={() => setExpanded((current) => !current)} style={styles.dropdownButton}>
        <View style={{ flex: 1 }}>
          <AppText style={styles.dropdownLabel}>Dance styles</AppText>
          <AppText style={styles.dropdownValue}>{selectionSummary(selected, "Select styles")}</AppText>
        </View>
        <Ionicons color={colors.primary} name={expanded ? "chevron-up" : "chevron-down"} size={20} />
      </Pressable>
      {expanded
        ? danceStyleGroups.map((group) => (
            <View key={group.label} style={styles.styleGroup}>
              <Pressable
                onPress={() => toggle(group.label)}
                style={[
                  styles.categoryPill,
                  selected.includes(group.label) && styles.optionPillActive
                ]}
              >
                <AppText
                  style={[
                    styles.categoryPillText,
                    selected.includes(group.label) && styles.optionTextActive
                  ]}
                >
                  {group.label} - all styles
                </AppText>
              </Pressable>
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
          ))
        : null}
    </View>
  );
}

function CollapsibleSinglePicker({
  emptyLabel = "Any",
  label,
  options,
  value,
  onChange
}: {
  emptyLabel?: string;
  label: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={styles.dropdownField}>
      <Pressable onPress={() => setExpanded((current) => !current)} style={styles.dropdownButton}>
        <View style={{ flex: 1 }}>
          <AppText style={styles.dropdownLabel}>{label}</AppText>
          <AppText style={styles.dropdownValue}>{value || emptyLabel}</AppText>
        </View>
        <Ionicons color={colors.primary} name={expanded ? "chevron-up" : "chevron-down"} size={20} />
      </Pressable>
      {expanded ? (
        <View style={styles.optionRow}>
          <Pressable
            onPress={() => onChange("")}
            style={[styles.optionPill, !value && styles.optionPillActive]}
          >
            <AppText style={[styles.optionText, !value && styles.optionTextActive]}>
              {emptyLabel}
            </AppText>
          </Pressable>
          {options.map((option) => {
            const active = option === value;
            return (
              <Pressable
                key={option}
                onPress={() => onChange(option)}
                style={[styles.optionPill, active && styles.optionPillActive]}
              >
                <AppText style={[styles.optionText, active && styles.optionTextActive]}>
                  {option}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function CollapsibleMultiPicker({
  emptyLabel = "Any",
  label,
  options,
  value,
  onChange
}: {
  emptyLabel?: string;
  label: string;
  options: string[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const selected = parseList(value);

  return (
    <View style={styles.dropdownField}>
      <Pressable onPress={() => setExpanded((current) => !current)} style={styles.dropdownButton}>
        <View style={{ flex: 1 }}>
          <AppText style={styles.dropdownLabel}>{label}</AppText>
          <AppText style={styles.dropdownValue}>{selectionSummary(selected, emptyLabel)}</AppText>
        </View>
        <Ionicons color={colors.primary} name={expanded ? "chevron-up" : "chevron-down"} size={20} />
      </Pressable>
      {expanded ? (
        <View style={styles.optionRow}>
          {options.map((option) => {
            const active = selected.includes(option);
            return (
              <Pressable
                key={option}
                onPress={() => onChange(toggleListValue(option, value))}
                style={[styles.optionPill, active && styles.optionPillActive]}
              >
                <AppText style={[styles.optionText, active && styles.optionTextActive]}>
                  {option}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function CollapsibleArrayPicker({
  emptyLabel = "Any",
  label,
  options,
  value,
  onChange
}: {
  emptyLabel?: string;
  label: string;
  options: string[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  function toggle(option: string) {
    onChange(value.includes(option) ? value.filter((item) => item !== option) : [...value, option]);
  }

  return (
    <View style={styles.dropdownField}>
      <Pressable onPress={() => setExpanded((current) => !current)} style={styles.dropdownButton}>
        <View style={{ flex: 1 }}>
          <AppText style={styles.dropdownLabel}>{label}</AppText>
          <AppText style={styles.dropdownValue}>{selectionSummary(value, emptyLabel)}</AppText>
        </View>
        <Ionicons color={colors.primary} name={expanded ? "chevron-up" : "chevron-down"} size={20} />
      </Pressable>
      {expanded ? (
        <View style={styles.optionRow}>
          {options.map((option) => {
            const active = value.includes(option);
            return (
              <Pressable
                key={option}
                onPress={() => toggle(option)}
                style={[styles.optionPill, active && styles.optionPillActive]}
              >
                <AppText style={[styles.optionText, active && styles.optionTextActive]}>
                  {option}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function DanceStyleFilterPicker({
  value,
  onChange
}: {
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  function toggle(style: string) {
    onChange(value.includes(style) ? value.filter((item) => item !== style) : [...value, style]);
  }

  return (
    <View style={styles.stylePicker}>
      <Pressable onPress={() => setExpanded((current) => !current)} style={styles.dropdownButton}>
        <View style={{ flex: 1 }}>
          <AppText style={styles.dropdownLabel}>Dance styles</AppText>
          <AppText style={styles.dropdownValue}>{selectionSummary(value, "Any style")}</AppText>
        </View>
        <Ionicons color={colors.primary} name={expanded ? "chevron-up" : "chevron-down"} size={20} />
      </Pressable>
      {expanded
        ? danceStyleGroups.map((group) => (
            <View key={group.label} style={styles.styleGroup}>
              <Pressable
                onPress={() => toggle(group.label)}
                style={[
                  styles.categoryPill,
                  value.includes(group.label) && styles.optionPillActive
                ]}
              >
                <AppText
                  style={[
                    styles.categoryPillText,
                    value.includes(group.label) && styles.optionTextActive
                  ]}
                >
                  {group.label} - all styles
                </AppText>
              </Pressable>
              <View style={styles.optionRow}>
                {group.styles.map((style) => (
                  <Pressable
                    key={`${group.label}-${style}`}
                    onPress={() => toggle(style)}
                    style={[styles.optionPill, value.includes(style) && styles.optionPillActive]}
                  >
                    <AppText style={[styles.optionText, value.includes(style) && styles.optionTextActive]}>
                      {style}
                    </AppText>
                  </Pressable>
                ))}
              </View>
            </View>
          ))
        : null}
    </View>
  );
}

export default function PartnerSearchScreen() {
  const { session } = useAuth();
  const router = useRouter();
  const user = session?.user ?? null;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [profiles, setProfiles] = useState<PublicPartnerProfileItem[]>([]);
  const [threads, setThreads] = useState<PartnerConversationThread[]>([]);
  const [myProfile, setMyProfile] = useState<DancerPartnerProfile | null>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [query, setQuery] = useState("");
  const [filterRole, setFilterRole] = useState<PartnerRole | "">("");
  const [filterSkill, setFilterSkill] = useState<PartnerSkillLevel | "">("");
  const [filterIntents, setFilterIntents] = useState<string[]>([]);
  const [filterStyles, setFilterStyles] = useState<string[]>([]);
  const [filterLocation, setFilterLocation] = useState<FilterLocation>(null);
  const [radiusMiles, setRadiusMiles] = useState(50);
  const [message, setMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [requestDrafts, setRequestDrafts] = useState<RequestDrafts>({});
  const [requestBusyId, setRequestBusyId] = useState<string | null>(null);

  const filteredProfiles = useMemo(() => {
    const search = normalize(query);
    const styleOptions = styleFilterOptions(filterStyles);

    return profiles.filter((profile) =>
      (!search ||
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
      ].some((value) => normalize(value).includes(search))) &&
      (!filterRole || profile.leadFollowRole === filterRole) &&
      (!filterSkill || profile.skillLevel === filterSkill) &&
      (!filterIntents.length ||
        filterIntents.some((intent) =>
          normalize(profile.listingIntent) === normalize(intent) ||
          profile.goals.some((goal) => normalize(goal) === normalize(intent))
        )) &&
      (!styleOptions.length ||
        styleOptions.some((style) => profile.danceStyles.includes(style))) &&
      (!filterLocation ||
        (profile.latitude !== null &&
          profile.longitude !== null &&
          milesBetween(filterLocation, {
            latitude: profile.latitude,
            longitude: profile.longitude
          }) <= radiusMiles))
    );
  }, [filterIntents, filterLocation, filterRole, filterSkill, filterStyles, profiles, query, radiusMiles]);

  async function loadPartnerSearch() {
    if (!user) return;

    setLoading(true);
    setErrorMessage(null);

    try {
      const [ownProfile, publicProfiles, ownThreads] = await Promise.all([
        loadMyPartnerProfile(user.id, user.email),
        getPublicPartnerProfilesForMobile(user.id),
        loadMyPartnerThreads(user.id)
      ]);
      setMyProfile(ownProfile);
      setProfiles(publicProfiles);
      setThreads(ownThreads);
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

  function updateProfile(updater: (profile: DancerPartnerProfile) => DancerPartnerProfile) {
    setMyProfile((current) => (current ? updater(current) : current));
  }

  async function chooseProfilePhoto() {
    if (!user) return;

    setUploadingPhoto(true);
    setMessage(null);
    setErrorMessage(null);

    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setMessage("Allow photo access to add a partner profile photo.");
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        allowsEditing: true,
        aspect: [1, 1],
        mediaTypes: ["images"],
        quality: 0.82
      });

      if (result.canceled || !result.assets[0]) return;

      const asset = result.assets[0];
      const photoUrl = await uploadPartnerProfilePhoto({
        contentType: asset.mimeType,
        uri: asset.uri,
        userId: user.id
      });

      updateProfile((profile) => ({ ...profile, photoUrl }));
      setMessage("Photo added. Save your listing to keep it on your profile.");
    } catch {
      setErrorMessage("We could not upload that photo yet.");
    } finally {
      setUploadingPhoto(false);
    }
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
      });

      if (result.advertisingRisk) {
        setMessage(
          "Saved as a draft. Remove lesson ads, coaching offers, links, phone numbers, or service language before submitting."
        );
      } else if (result.visibility === "paused") {
        setMessage("Partner profile hidden. You can turn it back on anytime.");
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

  async function toggleProfileVisibility() {
    if (!myProfile) return;
    await saveProfile(myProfile.visibility === "paused" ? "published" : "paused");
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
      const threadId = await requestPartnerConnection({
        partnerProfileId: profileId,
        requesterUserId: user.id,
        message: draft
      });
      setRequestDrafts((current) => ({ ...current, [profileId]: "" }));
      setThreads(await loadMyPartnerThreads(user.id));
      setMessage("Connection request sent. Opening your DanceFlow conversation.");
      router.push(`/partners/${threadId}` as unknown as RouterPushTarget);
    } catch {
      setErrorMessage("We could not send that request yet.");
    } finally {
      setRequestBusyId(null);
    }
  }

  async function togglePartnerFavorite(profile: PublicPartnerProfileItem) {
    if (!user) {
      setMessage("Sign in to save partner profiles.");
      return;
    }

    setMessage(null);
    setErrorMessage(null);

    try {
      const favorited = await setPublicFavoriteForMobile({
        favorited: !profile.favorited,
        targetId: profile.id,
        targetType: "partner_profile",
        userId: user.id
      });

      setProfiles((current) =>
        current.map((item) => (item.id === profile.id ? { ...item, favorited } : item))
      );
    } catch {
      setErrorMessage("We could not save that partner profile yet.");
    }
  }

  async function useMyLocationFilter() {
    setMessage(null);
    setErrorMessage(null);

    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        setMessage("Allow location access to search for partner listings near you.");
        return;
      }

      const current = await Location.getCurrentPositionAsync({});
      setFilterLocation({
        latitude: current.coords.latitude,
        longitude: current.coords.longitude
      });
      setMessage(`Showing partner listings within ${radiusMiles} miles.`);
    } catch {
      setErrorMessage("We could not use your location yet.");
    }
  }

  function clearFilters() {
    setQuery("");
    setFilterRole("");
    setFilterSkill("");
    setFilterIntents([]);
    setFilterStyles([]);
    setFilterLocation(null);
    setRadiusMiles(50);
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
        <View style={styles.filterSection}>
          <AppText style={styles.filterTitle}>Near me</AppText>
          <View style={styles.optionRow}>
            {[25, 50, 100].map((radius) => (
              <Pressable
                key={radius}
                onPress={() => setRadiusMiles(radius)}
                style={[styles.optionPill, radiusMiles === radius && styles.optionPillActive]}
              >
                <AppText style={[styles.optionText, radiusMiles === radius && styles.optionTextActive]}>
                  {radius} mi
                </AppText>
              </Pressable>
            ))}
            <Pressable onPress={useMyLocationFilter} style={styles.optionPill}>
              <AppText style={styles.optionText}>{filterLocation ? "Near me on" : "Use my location"}</AppText>
            </Pressable>
          </View>
        </View>
        <View style={styles.filterSection}>
          <CollapsibleArrayPicker
            label="Goals"
            emptyLabel="Any goal"
            options={goalOptions}
            value={filterIntents}
            onChange={setFilterIntents}
          />
        </View>
        <View style={styles.filterSection}>
          <AppText style={styles.filterTitle}>Role</AppText>
          <OptionRow
            options={[{ label: "Any", value: "" }, ...roleOptions]}
            value={filterRole}
            onChange={setFilterRole}
          />
        </View>
        <View style={styles.filterSection}>
          <AppText style={styles.filterTitle}>Level</AppText>
          <OptionRow
            options={[{ label: "Any", value: "" }, ...skillOptions]}
            value={filterSkill}
            onChange={setFilterSkill}
          />
        </View>
        <View style={styles.filterSection}>
          <DanceStyleFilterPicker value={filterStyles} onChange={setFilterStyles} />
        </View>
        <Pressable onPress={clearFilters} style={styles.clearFiltersButton}>
          <AppText style={styles.clearFiltersText}>Clear filters</AppText>
        </Pressable>
      </View>

      {myProfile ? (
        <Pressable
          onPress={() => router.push("/partners/draft" as unknown as RouterPushTarget)}
          style={({ pressed }) => [styles.listingButton, pressed && styles.cardPressed]}
        >
          <View style={styles.listingButtonIcon}>
            <Ionicons color="#fff" name="create-outline" size={22} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={styles.editorHeader}>
              <View style={{ flex: 1 }}>
                <AppText variant="eyebrow">Your Listing</AppText>
                <AppText variant="subtitle">
                  {myProfile.visibility === "paused"
                    ? "Hidden from Partner Search"
                    : myProfile.visibility === "published"
                      ? "Submitted for review"
                      : "Draft listing"}
                </AppText>
              </View>
              <View style={styles.statusPill}>
                <AppText style={styles.statusText}>{labelFor(myProfile.moderationStatus)}</AppText>
              </View>
            </View>
            <AppText variant="caption">Create, edit, save, or submit your partner search listing.</AppText>
          </View>
        </Pressable>
      ) : null}

      {threads.length ? (
        <View style={styles.messagesCard}>
          <View style={styles.editorHeader}>
            <View style={{ flex: 1 }}>
              <AppText variant="eyebrow">Messages</AppText>
              <AppText variant="subtitle">DanceFlow conversations</AppText>
            </View>
            <View style={styles.statusPill}>
              <AppText style={styles.statusText}>{threads.length}</AppText>
            </View>
          </View>
          {threads.map((thread) => (
            <Pressable
              key={thread.id}
              onPress={() => router.push(`/partners/${thread.id}` as unknown as RouterPushTarget)}
              style={({ pressed }) => [styles.threadRow, pressed && styles.cardPressed]}
            >
              <View style={{ flex: 1 }}>
                <AppText style={styles.threadName}>{thread.partnerDisplayName}</AppText>
                {thread.partnerHeadline ? (
                  <AppText variant="caption">{thread.partnerHeadline}</AppText>
                ) : null}
              </View>
              <Ionicons color={colors.primary} name="chatbubble-ellipses-outline" size={20} />
            </Pressable>
          ))}
        </View>
      ) : null}

      {filteredProfiles.length ? (
        filteredProfiles.map((profile) => (
          <View key={profile.id} style={styles.partnerCard}>
            <View style={styles.partnerTop}>
              {profile.photoUrl ? (
                <Image source={{ uri: profile.photoUrl }} style={styles.partnerAvatar} />
              ) : (
                <View style={styles.partnerAvatarFallback}>
                  <AppText style={styles.partnerAvatarInitials}>
                    {initialsFor(profile.displayName) || "DF"}
                  </AppText>
                </View>
              )}
              <View style={{ flex: 1 }}>
                <AppText style={styles.partnerName}>{profile.displayName}</AppText>
                <AppText variant="caption">{profile.location}</AppText>
              </View>
              <Pressable
                onPress={() => togglePartnerFavorite(profile)}
                style={({ pressed }) => [styles.heartButton, pressed && styles.cardPressed]}
              >
                <Ionicons
                  color={profile.favorited ? "#EF4444" : colors.muted}
                  name={profile.favorited ? "heart" : "heart-outline"}
                  size={22}
                />
              </Pressable>
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
  cardPressed: {
    opacity: 0.78
  },
  clearFiltersButton: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    paddingVertical: 10
  },
  clearFiltersText: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "900"
  },
  categoryPill: {
    alignSelf: "flex-start",
    backgroundColor: colors.background,
    borderColor: colors.primary,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  categoryPillText: {
    color: colors.primary,
    fontSize: 13,
    fontWeight: "900"
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
  dropdownButton: {
    alignItems: "center",
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    minHeight: 52,
    paddingHorizontal: 12,
    paddingVertical: 10
  },
  dropdownField: {
    gap: 8
  },
  dropdownLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: "900",
    letterSpacing: 0.4,
    textTransform: "uppercase"
  },
  dropdownValue: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "800",
    marginTop: 2
  },
  field: {
    gap: 6
  },
  filterSection: {
    gap: 8
  },
  filterTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "900"
  },
  heartButton: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    height: 42,
    justifyContent: "center",
    width: 42
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
  listingButton: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    flexDirection: "row",
    gap: 14,
    padding: 16
  },
  listingButtonIcon: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: 16,
    height: 46,
    justifyContent: "center",
    width: 46
  },
  multilineInput: {
    minHeight: 96,
    textAlignVertical: "top"
  },
  messagesCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    gap: 12,
    padding: 16
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
  partnerAvatar: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 24,
    height: 64,
    width: 64
  },
  partnerAvatarFallback: {
    alignItems: "center",
    backgroundColor: "rgba(244, 63, 142, 0.12)",
    borderColor: "rgba(244, 63, 142, 0.25)",
    borderRadius: 24,
    borderWidth: 1,
    height: 64,
    justifyContent: "center",
    width: 64
  },
  partnerAvatarInitials: {
    color: colors.primary,
    fontSize: 18,
    fontWeight: "900"
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
  threadName: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "900"
  },
  threadRow: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: "row",
    gap: 10,
    padding: 12
  },
  twoColumn: {
    flexDirection: "row",
    gap: 10
  },
  visibilityCard: {
    alignItems: "center",
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 12
  },
  visibilitySwitch: {
    alignItems: "center",
    backgroundColor: colors.border,
    borderRadius: 999,
    height: 32,
    justifyContent: "center",
    paddingHorizontal: 3,
    width: 56
  },
  visibilitySwitchKnob: {
    alignSelf: "flex-start",
    backgroundColor: "#fff",
    borderRadius: 999,
    height: 26,
    width: 26
  },
  visibilitySwitchKnobOn: {
    alignSelf: "flex-end"
  },
  visibilitySwitchOn: {
    backgroundColor: colors.primary
  },
  visibilityTitle: {
    color: colors.text,
    fontSize: 15,
    fontWeight: "900"
  }
});
