import { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
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

export default function JobsScreen() {
  const [jobs, setJobs] = useState<PublicJobPostingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
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
    if (!search) return jobs;

    return jobs.filter((job) =>
      [
        job.title,
        job.studioName,
        job.location,
        job.roleType,
        job.employmentType,
        job.description,
        job.requirements,
        ...job.danceStyles
      ].some((value) => normalize(value).includes(search))
    );
  }, [jobs, query]);

  async function openApply(job: PublicJobPostingItem) {
    if (job.applyUrl) {
      await Linking.openURL(job.applyUrl);
      return;
    }

    if (job.applyEmail) {
      await Linking.openURL(`mailto:${job.applyEmail}`);
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

            {job.applyUrl || job.applyEmail ? (
              <Pressable onPress={() => openApply(job)} style={styles.applyButton}>
                <AppText style={styles.applyButtonText}>Apply</AppText>
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
  compensation: {
    color: colors.text,
    fontSize: 14,
    fontWeight: "800"
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
