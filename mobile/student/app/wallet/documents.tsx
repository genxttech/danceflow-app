import { useCallback, useState } from "react";
import { Linking, StyleSheet, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { loadStudentDocuments, type StudentDocument } from "@/lib/studentDocuments";

function formatDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function statusLabel(document: StudentDocument) {
  if (document.status === "signed" || document.signedAt) return "Signed";
  if (document.status === "expired") return "Expired";
  if (document.status === "void") return "Voided";
  if (document.dueAt && new Date(document.dueAt).getTime() < Date.now()) return "Past due";
  return document.requiresSignature ? "Ready to sign" : "Ready to review";
}

export default function StudentDocumentsScreen() {
  const [documents, setDocuments] = useState<StudentDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDocuments(await loadStudentDocuments());
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Documents could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  async function openDocument(document: StudentDocument) {
    if (!document.actionUrl) return;
    setOpeningId(document.id);
    try {
      await Linking.openURL(document.actionUrl);
    } finally {
      setOpeningId(null);
    }
  }

  const pending = documents.filter((document) => document.status !== "signed" && !document.signedAt);
  const completed = documents.filter((document) => document.status === "signed" || document.signedAt);

  return (
    <Screen>
      <AppText variant="eyebrow">Wallet</AppText>
      <AppText variant="title">Documents</AppText>
      <AppText variant="caption">
        Review studio documents, sign anything that needs attention, and keep completed records handy.
      </AppText>

      {loading ? <FeatureCard title="Loading documents" detail="Checking your connected studios." /> : null}
      {error ? <FeatureCard title="Documents unavailable" detail={error} /> : null}

      {!loading && !error && documents.length === 0 ? (
        <FeatureCard
          title="No documents yet"
          detail="Waivers, policies, agreements, and other studio documents will appear here."
        />
      ) : null}

      {pending.length ? (
        <View style={styles.section}>
          <AppText variant="subtitle">Needs attention</AppText>
          {pending.map((document) => (
            <View key={document.id} style={styles.card}>
              <View style={styles.row}>
                <AppText variant="eyebrow">{statusLabel(document)}</AppText>
                <AppText variant="caption">{document.studioName}</AppText>
              </View>
              <AppText variant="subtitle">{document.title}</AppText>
              {document.description ? <AppText variant="caption">{document.description}</AppText> : null}
              {document.dueAt ? <AppText variant="caption">Due {formatDate(document.dueAt)}</AppText> : null}
              <AppButton
                label={document.requiresSignature ? "Review and sign" : "Review document"}
                loading={openingId === document.id}
                onPress={() => openDocument(document)}
              />
            </View>
          ))}
        </View>
      ) : null}

      {completed.length ? (
        <View style={styles.section}>
          <AppText variant="subtitle">Completed</AppText>
          {completed.map((document) => (
            <View key={document.id} style={styles.card}>
              <View style={styles.row}>
                <AppText variant="eyebrow">Signed</AppText>
                <AppText variant="caption">{document.studioName}</AppText>
              </View>
              <AppText variant="subtitle">{document.title}</AppText>
              {document.signedAt ? <AppText variant="caption">Signed {formatDate(document.signedAt)}</AppText> : null}
              <AppButton
                label="View document"
                loading={openingId === document.id}
                onPress={() => openDocument(document)}
                variant="secondary"
              />
            </View>
          ))}
        </View>
      ) : null}

      <AppButton label="Refresh documents" onPress={refresh} variant="secondary" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 8,
    padding: 16,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
  },
  section: {
    gap: 10,
  },
});
