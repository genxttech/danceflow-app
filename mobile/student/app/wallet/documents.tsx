import { useCallback, useState } from "react";
import { Pressable, StyleSheet, useColorScheme, View } from "react-native";
import { router, useFocusEffect } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colorsForScheme } from "@/constants/theme";
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
  if (document.envelopeStatus === "draft") return "Studio preparing";
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
  const colors = colorsForScheme(useColorScheme());
  const styles = createStyles(colors);
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

  const renderCard = (document: StudentDocument, buttonLabel: string) => {
    const completedDocument = isCompleted(document);
    const preparing = document.envelopeStatus === "draft";
    const pastDue =
      Boolean(document.dueAt) &&
      new Date(document.dueAt as string).getTime() < Date.now() &&
      !completedDocument;

    return (
      <Pressable
        key={document.id}
        onPress={() => openDocument(document)}
        style={({ pressed }) => [
          styles.card,
          pastDue && styles.cardAttention,
          completedDocument && styles.cardCompleted,
          pressed && styles.cardPressed,
        ]}
      >
        <View style={styles.row}>
          <View
            style={[
              styles.statusPill,
              completedDocument && styles.statusPillCompleted,
              pastDue && styles.statusPillAttention,
            ]}
          >
            <AppText
              style={[
                styles.statusText,
                completedDocument && styles.statusTextCompleted,
                pastDue && styles.statusTextAttention,
              ]}
            >
              {statusLabel(document)}
            </AppText>
          </View>
          <AppText style={styles.studioName}>{document.studioName}</AppText>
        </View>

        <AppText style={styles.documentTitle}>{document.title}</AppText>

        {document.description ? (
          <AppText numberOfLines={2} variant="caption">
            {document.description}
          </AppText>
        ) : null}

        <View style={styles.metaRow}>
          {document.dueAt ? (
            <AppText style={pastDue ? styles.metaAttention : styles.metaText}>
              Due {formatDate(document.dueAt)}
            </AppText>
          ) : null}
          {completedDocument && document.signedAt ? (
            <AppText style={styles.metaText}>
              Signed {formatDate(document.signedAt)}
            </AppText>
          ) : null}
          {preparing ? (
            <AppText style={styles.metaText}>
              The studio is preparing this document for signing.
            </AppText>
          ) : null}
        </View>

        <View style={styles.cardAction}>
          <AppText style={styles.cardActionText}>{buttonLabel}</AppText>
          <AppText style={styles.cardChevron}>›</AppText>
        </View>
      </Pressable>
    );
  };

  return (
    <Screen refreshing={loading} onRefresh={refresh}>
      <View style={styles.hero}>
        <AppText style={styles.heroEyebrow}>Wallet · Documents</AppText>
        <AppText style={styles.heroTitle}>Documents</AppText>
        <AppText style={styles.heroDetail}>
          Review requests that need your attention and keep signed documents available in DanceFlow.
        </AppText>

        {!loading ? (
          <View style={styles.summaryRow}>
            <View style={styles.summaryItem}>
              <AppText style={styles.summaryValue}>{pending.length}</AppText>
              <AppText style={styles.summaryLabel}>Need attention</AppText>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryItem}>
              <AppText style={styles.summaryValue}>{completed.length}</AppText>
              <AppText style={styles.summaryLabel}>Completed</AppText>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryItem}>
              <AppText style={styles.summaryValue}>{closed.length}</AppText>
              <AppText style={styles.summaryLabel}>Closed</AppText>
            </View>
          </View>
        ) : null}
      </View>

      {loading ? (
        <FeatureCard
          title="Loading documents"
          detail="Checking your connected studios."
        />
      ) : null}
      {error ? (
        <View style={styles.stateBlock}>
          <FeatureCard title="Documents unavailable" detail={error} />
          <AppButton label="Try again" onPress={refresh} variant="secondary" />
        </View>
      ) : null}

      {!loading && !error && documents.length === 0 ? (
        <View style={styles.emptyState}>
          <AppText style={styles.emptyTitle}>No documents yet</AppText>
          <AppText variant="caption">
            Waivers, policies, agreements, and signed documents from connected studios will appear here.
          </AppText>
        </View>
      ) : null}

      {pending.length ? (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View>
              <AppText variant="eyebrow">Action required</AppText>
              <AppText variant="subtitle">Needs attention</AppText>
            </View>
            <AppText style={styles.sectionCount}>{pending.length}</AppText>
          </View>
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
          <View style={styles.sectionHeader}>
            <View>
              <AppText variant="eyebrow">Your records</AppText>
              <AppText variant="subtitle">Completed</AppText>
            </View>
            <AppText style={styles.sectionCount}>{completed.length}</AppText>
          </View>
          {completed.map((document) => renderCard(document, "View signed document"))}
        </View>
      ) : null}

      {closed.length ? (
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <View>
              <AppText variant="eyebrow">History</AppText>
              <AppText variant="subtitle">Closed</AppText>
            </View>
            <AppText style={styles.sectionCount}>{closed.length}</AppText>
          </View>
          {closed.map((document) => renderCard(document, "View details"))}
        </View>
      ) : null}

      {!loading && documents.length > 0 ? (
        <AppButton label="Refresh documents" onPress={refresh} variant="ghost" />
      ) : null}
    </Screen>
  );
}

function createStyles(colors: ReturnType<typeof colorsForScheme>) {
  return StyleSheet.create({
    hero: {
      backgroundColor: colors.backgroundSoft,
      borderColor: colors.border,
      borderRadius: 28,
      borderWidth: 1,
      gap: 8,
      padding: 20,
    },
    heroEyebrow: {
      color: colors.accent,
      fontSize: 11,
      fontWeight: "900",
      letterSpacing: 1.3,
      textTransform: "uppercase",
    },
    heroTitle: {
      color: colors.text,
      fontSize: 30,
      fontWeight: "900",
      lineHeight: 36,
    },
    heroDetail: {
      color: colors.muted,
      fontSize: 14,
      lineHeight: 21,
    },
    summaryRow: {
      alignItems: "center",
      flexDirection: "row",
      marginTop: 10,
    },
    summaryItem: {
      flex: 1,
    },
    summaryDivider: {
      backgroundColor: colors.border,
      height: 34,
      marginHorizontal: 10,
      width: 1,
    },
    summaryValue: {
      color: colors.text,
      fontSize: 20,
      fontWeight: "900",
    },
    summaryLabel: {
      color: colors.muted,
      fontSize: 10,
      fontWeight: "800",
      marginTop: 2,
      textTransform: "uppercase",
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 20,
      borderWidth: 1,
      gap: 10,
      padding: 16,
    },
    cardAttention: {
      borderColor: colors.accent,
    },
    cardCompleted: {
      backgroundColor: colors.surfaceAlt,
    },
    cardPressed: {
      opacity: 0.82,
      transform: [{ scale: 0.995 }],
    },
    row: {
      alignItems: "center",
      flexDirection: "row",
      gap: 10,
      justifyContent: "space-between",
    },
    statusPill: {
      backgroundColor: colors.surfaceAlt,
      borderRadius: 999,
      paddingHorizontal: 9,
      paddingVertical: 5,
    },
    statusPillCompleted: {
      backgroundColor: `${colors.success}22`,
    },
    statusPillAttention: {
      backgroundColor: colors.accentSoft,
    },
    statusText: {
      color: colors.primary,
      fontSize: 10,
      fontWeight: "900",
      letterSpacing: 0.7,
      textTransform: "uppercase",
    },
    statusTextCompleted: {
      color: colors.success,
    },
    statusTextAttention: {
      color: colors.accent,
    },
    studioName: {
      color: colors.muted,
      flexShrink: 1,
      fontSize: 12,
      textAlign: "right",
    },
    documentTitle: {
      color: colors.text,
      fontSize: 18,
      fontWeight: "900",
      lineHeight: 24,
    },
    metaRow: {
      gap: 3,
    },
    metaText: {
      color: colors.muted,
      fontSize: 12,
      lineHeight: 18,
    },
    metaAttention: {
      color: colors.accent,
      fontSize: 12,
      fontWeight: "800",
      lineHeight: 18,
    },
    cardAction: {
      alignItems: "center",
      borderTopColor: colors.border,
      borderTopWidth: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      marginTop: 2,
      paddingTop: 10,
    },
    cardActionText: {
      color: colors.primary,
      fontSize: 13,
      fontWeight: "900",
    },
    cardChevron: {
      color: colors.primary,
      fontSize: 24,
      lineHeight: 24,
    },
    section: {
      gap: 10,
    },
    sectionHeader: {
      alignItems: "center",
      flexDirection: "row",
      justifyContent: "space-between",
    },
    sectionCount: {
      backgroundColor: colors.surfaceAlt,
      borderRadius: 999,
      color: colors.primary,
      fontSize: 12,
      fontWeight: "900",
      overflow: "hidden",
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    emptyState: {
      alignItems: "center",
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 22,
      borderStyle: "dashed",
      borderWidth: 1,
      gap: 6,
      padding: 24,
    },
    emptyTitle: {
      color: colors.text,
      fontSize: 18,
      fontWeight: "900",
    },
    stateBlock: {
      gap: 10,
    },
  });
}
