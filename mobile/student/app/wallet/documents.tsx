import { useCallback, useState } from "react";
import { StyleSheet, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
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

function isCompleted(document: StudentDocument) {
  return (
    document.status === "signed" ||
    document.envelopeStatus === "completed" ||
    Boolean(document.signedAt)
  );
}

function statusLabel(document: StudentDocument) {
  if (isCompleted(document)) return "Signed";
  if (document.envelopeStatus === "draft") return "Sender preparing";
  if (document.status === "expired" || document.envelopeStatus === "expired") {
    return "Expired";
  }
  if (document.status === "void" || document.envelopeStatus === "void") {
    return "Voided";
  }
  if (document.envelopeStatus === "declined") return "Declined";
  if (document.dueAt && new Date(document.dueAt).getTime() < Date.now()) {
    return "Past due";
  }
  return document.requiresSignature ? "Ready to sign" : "Ready to review";
}

export default function StudentDocumentsScreen() {
  const [documents, setDocuments] = useState<StudentDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDocuments(await loadStudentDocuments());
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "Documents could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  function openDocument(document: StudentDocument) {
    router.push(
  {
    pathname: "/wallet/documents/[assignmentId]",
    params: { assignmentId: document.id },
  } as never,
);
  }

  const pending = documents.filter(
    (document) =>
      !isCompleted(document) &&
      !["expired", "void"].includes(document.status) &&
      !["expired", "void", "declined"].includes(document.envelopeStatus ?? ""),
  );
  const completed = documents.filter(isCompleted);
  const closed = documents.filter(
    (document) =>
      ["expired", "void"].includes(document.status) ||
      ["expired", "void", "declined"].includes(document.envelopeStatus ?? ""),
  );

  const renderCard = (document: StudentDocument, buttonLabel: string) => (
    <View key={document.id} style={styles.card}>
      <View style={styles.row}>
        <AppText variant="eyebrow">{statusLabel(document)}</AppText>
        <AppText variant="caption">{document.studioName}</AppText>
      </View>
      <AppText variant="subtitle">{document.title}</AppText>
      {document.description ? (
        <AppText variant="caption">{document.description}</AppText>
      ) : null}
      {document.dueAt ? (
        <AppText variant="caption">Due {formatDate(document.dueAt)}</AppText>
      ) : null}
      <AppButton
        label={buttonLabel}
        onPress={() => openDocument(document)}
        variant={isCompleted(document) ? "secondary" : undefined}
      />
    </View>
  );

  return (
    <Screen>
      <AppText variant="eyebrow">Wallet</AppText>
      <AppText variant="title">Documents</AppText>
      <AppText variant="caption">
        Review and sign documents from your studios and event organizers without leaving DanceFlow.
      </AppText>

      {loading ? (
        <FeatureCard
          title="Loading documents"
          detail="Checking your studios and event organizers."
        />
      ) : null}
      {error ? <FeatureCard title="Documents unavailable" detail={error} /> : null}

      {!loading && !error && documents.length === 0 ? (
        <FeatureCard
          title="No documents yet"
          detail="Waivers, policies, agreements, and event documents will appear here."
        />
      ) : null}

      {pending.length ? (
        <View style={styles.section}>
          <AppText variant="subtitle">Needs attention</AppText>
          {pending.map((document) =>
            renderCard(
              document,
              document.envelopeStatus === "draft"
                ? "View status"
                : document.requiresSignature
                  ? "Review and sign"
                  : "Review document",
            ),
          )}
        </View>
      ) : null}

      {completed.length ? (
        <View style={styles.section}>
          <AppText variant="subtitle">Completed</AppText>
          {completed.map((document) => renderCard(document, "View signed document"))}
        </View>
      ) : null}

      {closed.length ? (
        <View style={styles.section}>
          <AppText variant="subtitle">Closed</AppText>
          {closed.map((document) => renderCard(document, "View details"))}
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
