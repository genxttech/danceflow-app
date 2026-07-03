import { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import {
  getPublicJobPostingsForMobile,
  type PublicJobPostingItem
} from "@/lib/publicDiscovery";

function normalize(value: string | null | undefined) {
  return (value ?? "").trim().toLowerCase();
}

function labelFor(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

const roleOptions = ["instructor", "coach", "front_desk", "event_staff", "admin", "other"];
const employmentOptions = ["contract", "part_time", "full_time", "employee", "temporary", "volunteer"];
const locationOptions = ["in_person", "hybrid", "remote"];
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

export default function JobsScreen() {
  const [jobs, setJobs] = useState<PublicJobPostingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filterRole, setFilterRole] = useState("");
  const [filterEmployment, setFilterEmployment] = useState("");
  const [filterLocationType, setFilterLocationType] = useState("");
  const [filterStyle, setFilterStyle] = useState("");
  const [filterLocation, setFilterLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [radiusMiles, setRadiusMiles] = useState(50);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;

    getPublicJobPostingsForMobile()
      .then((items) => {
        if (!mounted) return;
        setJobs(items);
      })
      .catch(() => {
        if (!mounted) return;
        setErrorMessage("Hiring posts are not available yet. Try again in a moment.");
      })
      .finally(() => {
        if (!mounted) return;
        setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const filteredJobs = useMemo(() => {
    const search = normalize(query);

    return jobs.filter((job) =>
      (!search ||
        [
          job.title,
          job.studioName,
          job.location,
          job.roleType,
          job.employmentType,
          job.description,
          job.requirements,
          ...job.danceStyles
        ].some((value) => normalize(value).includes(search))) &&
      (!filterRole || job.roleType === filterRole) &&
      (!filterEmployment || job.employmentType === filterEmployment) &&
      (!filterLocationType || job.locationType === filterLocationType) &&
      (!filterStyle || job.danceStyles.includes(filterStyle)) &&
      (!filterLocation ||
        (job.latitude !== null &&
          job.longitude !== null &&
          milesBetween(filterLocation, {
            latitude: job.latitude,
            longitude: job.longitude
          }) <= radiusMiles))
    );
  }, [filterEmployment, filterLocation, filterLocationType, filterRole, filterStyle, jobs, query, radiusMiles]);

  async function useMyLocationFilter() {
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) {
        setErrorMessage("Allow location access to search for jobs near you.");
        return;
      }

      const current = await Location.getCurrentPositionAsync({});
      setFilterLocation({
        latitude: current.coords.latitude,
        longitude: current.coords.longitude
      });
    } catch {
      setErrorMessage("We could not use your location yet.");
    }
  }

  function clearFilters() {
    setQuery("");
    setFilterRole("");
    setFilterEmployment("");
    setFilterLocationType("");
    setFilterStyle("");
    setFilterLocation(null);
    setRadiusMiles(50);
  }

  async function openApply(job: PublicJobPostingItem) {
    if (job.applyUrl) {
      await Linking.openURL(job.applyUrl);
      return;
    }

    if (job.applyEmail) {
      await Linking.openURL(`mailto:${job.applyEmail}`);
      return;
    }

    if (job.applyPhone) {
      await Linking.openURL(`tel:${job.applyPhone}`);
    }
  }

  return (
    <Screen>
      <AppText variant="eyebrow">Now Hiring</AppText>
      <AppText variant="title">Dance studio openings</AppText>
      <AppText variant="caption">
        Browse instructor, coach, front desk, event staff, and studio operations opportunities from DanceFlow studios.
      </AppText>

      <View style={styles.searchCard}>
        <View style={styles.searchIcon}>
          <Ionicons color="#fff" name="briefcase-outline" size={22} />
        </View>
        <View style={{ flex: 1 }}>
          <AppText style={styles.searchTitle}>Find studio opportunities</AppText>
          <AppText style={styles.searchDetail}>
            Search by role, studio, style, or location.
          </AppText>
        </View>
      </View>

      <TextInput
        autoCapitalize="none"
        onChangeText={setQuery}
        placeholder="Search jobs, studios, cities, or styles"
        placeholderTextColor={colors.muted}
        style={styles.input}
        value={query}
      />

      <View style={styles.filterCard}>
        <AppText variant="eyebrow">Filters</AppText>
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
          <AppText style={styles.filterTitle}>Role</AppText>
          <View style={styles.optionRow}>
            {["", ...roleOptions].map((role) => (
              <Pressable
                key={role || "any-role"}
                onPress={() => setFilterRole(role)}
                style={[styles.optionPill, filterRole === role && styles.optionPillActive]}
              >
                <AppText style={[styles.optionText, filterRole === role && styles.optionTextActive]}>
                  {role ? labelFor(role) : "Any"}
                </AppText>
              </Pressable>
            ))}
          </View>
        </View>
        <View style={styles.filterSection}>
          <AppText style={styles.filterTitle}>Employment</AppText>
          <View style={styles.optionRow}>
            {["", ...employmentOptions].map((employment) => (
              <Pressable
                key={employment || "any-employment"}
                onPress={() => setFilterEmployment(employment)}
                style={[styles.optionPill, filterEmployment === employment && styles.optionPillActive]}
              >
                <AppText style={[styles.optionText, filterEmployment === employment && styles.optionTextActive]}>
                  {employment ? labelFor(employment) : "Any"}
                </AppText>
              </Pressable>
            ))}
          </View>
        </View>
        <View style={styles.filterSection}>
          <AppText style={styles.filterTitle}>Location type</AppText>
          <View style={styles.optionRow}>
            {["", ...locationOptions].map((locationType) => (
              <Pressable
                key={locationType || "any-location"}
                onPress={() => setFilterLocationType(locationType)}
                style={[styles.optionPill, filterLocationType === locationType && styles.optionPillActive]}
              >
                <AppText style={[styles.optionText, filterLocationType === locationType && styles.optionTextActive]}>
                  {locationType ? labelFor(locationType) : "Any"}
                </AppText>
              </Pressable>
            ))}
          </View>
        </View>
        <View style={styles.filterSection}>
          <AppText style={styles.filterTitle}>Dance style</AppText>
          {danceStyleGroups.map((group) => (
            <View key={group.label} style={styles.styleGroup}>
              <AppText style={styles.styleGroupTitle}>{group.label}</AppText>
              <View style={styles.optionRow}>
                {group.styles.map((style) => (
                  <Pressable
                    key={style}
                    onPress={() => setFilterStyle(filterStyle === style ? "" : style)}
                    style={[styles.optionPill, filterStyle === style && styles.optionPillActive]}
                  >
                    <AppText style={[styles.optionText, filterStyle === style && styles.optionTextActive]}>
                      {style}
                    </AppText>
                  </Pressable>
                ))}
              </View>
            </View>
          ))}
        </View>
        <Pressable onPress={clearFilters} style={styles.clearFiltersButton}>
          <AppText style={styles.clearFiltersText}>Clear filters</AppText>
        </Pressable>
      </View>

      {loading ? <FeatureCard title="Loading jobs" detail="Finding studio openings." /> : null}
      {errorMessage ? <FeatureCard title="Now Hiring needs attention" detail={errorMessage} /> : null}

      {filteredJobs.length ? (
        filteredJobs.map((job) => (
          <View key={job.id} style={styles.jobCard}>
            <View style={styles.jobTop}>
              <View style={{ flex: 1 }}>
                <AppText style={styles.jobTitle}>{job.title}</AppText>
                <AppText variant="caption">
                  {job.studioName} · {job.location}
                </AppText>
              </View>
              <View style={styles.roleBadge}>
                <AppText style={styles.roleBadgeText}>{labelFor(job.roleType)}</AppText>
              </View>
            </View>

            {job.description ? (
              <AppText variant="caption">{job.description}</AppText>
            ) : null}

            <View style={styles.tagRow}>
              <View style={styles.tag}>
                <AppText style={styles.tagText}>{labelFor(job.employmentType)}</AppText>
              </View>
              {job.danceStyles.slice(0, 4).map((style) => (
                <View key={style} style={styles.accentTag}>
                  <AppText style={styles.accentTagText}>{style}</AppText>
                </View>
              ))}
            </View>

            {job.compensationSummary ? (
              <AppText style={styles.compensation}>{job.compensationSummary}</AppText>
            ) : null}

            {job.applyUrl || job.applyEmail || job.applyPhone ? (
              <Pressable onPress={() => openApply(job)} style={styles.applyButton}>
                <AppText style={styles.applyButtonText}>
                  {job.applyUrl ? "Apply" : job.applyEmail ? "Apply by Email" : "Call to Apply"}
                </AppText>
              </Pressable>
            ) : (
              <AppText variant="caption">
                Application details will be provided by the studio.
              </AppText>
            )}
          </View>
        ))
      ) : !loading ? (
        <FeatureCard
          title="No jobs found"
          detail="Try a broader search or check back as more studios publish openings."
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
  applyButton: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: 14,
    paddingVertical: 12
  },
  applyButtonText: {
    color: "#fff",
    fontSize: 15,
    fontWeight: "900"
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
  compensation: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "800"
  },
  filterCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    gap: 14,
    padding: 16
  },
  filterSection: {
    gap: 8
  },
  filterTitle: {
    color: colors.text,
    fontSize: 13,
    fontWeight: "900"
  },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    minHeight: 48,
    paddingHorizontal: 12
  },
  jobCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 20,
    borderWidth: 1,
    gap: 12,
    padding: 16
  },
  jobTitle: {
    color: colors.text,
    fontSize: 20,
    fontWeight: "900"
  },
  jobTop: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 12
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
  roleBadge: {
    backgroundColor: "#fff4e7",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  roleBadgeText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "900"
  },
  searchCard: {
    alignItems: "center",
    backgroundColor: colors.primaryDark,
    borderRadius: 20,
    flexDirection: "row",
    gap: 12,
    padding: 16
  },
  searchDetail: {
    color: "rgba(255,255,255,0.78)",
    fontSize: 13,
    lineHeight: 19
  },
  searchIcon: {
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.16)",
    borderRadius: 999,
    height: 42,
    justifyContent: "center",
    width: 42
  },
  searchTitle: {
    color: "#fff",
    fontSize: 16,
    fontWeight: "900",
    marginBottom: 4
  },
  tag: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6
  },
  styleGroup: {
    gap: 8
  },
  styleGroupTitle: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "900"
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
  }
});
