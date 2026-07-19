import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import Pdf from "react-native-pdf";
import * as FileSystem from "expo-file-system/legacy";
import { router, useLocalSearchParams } from "expo-router";
import { AppButton } from "@/components/AppButton";
import { AppText } from "@/components/AppText";
import { FeatureCard } from "@/components/FeatureCard";
import { Screen } from "@/components/Screen";
import { colors } from "@/constants/theme";
import { supabase } from "@/lib/supabase";
import {
  completeStudentDocument,
  loadStudentDocument,
  type StudentDocumentDetail,
  type StudentDocumentField,
  type StudentSigningValue,
} from "@/lib/studentDocuments";

function normalizeParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function initials(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 6)
    .toUpperCase();
}

function isCompleted(detail: StudentDocumentDetail | null) {
  return Boolean(
    detail &&
      (detail.document.status === "signed" ||
        detail.document.envelopeStatus === "completed" ||
        detail.document.signedAt),
  );
}

function FieldEditor({
  field,
  signerName,
  value,
  onChange,
}: {
  field: StudentDocumentField;
  signerName: string;
  value: StudentSigningValue | undefined;
  onChange: (value: StudentSigningValue) => void;
}) {
  if (field.fieldType === "checkbox") {
    const checked = value === true;
    return (
      <Pressable
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        onPress={() => onChange(!checked)}
        style={[styles.checkboxRow, checked && styles.checkboxRowChecked]}
      >
        <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
          {checked ? <AppText style={styles.checkboxMark}>✓</AppText> : null}
        </View>
        <View style={styles.fieldCopy}>
          <AppText variant="subtitle">{field.label || "Agreement"}</AppText>
          {field.required ? <AppText variant="caption">Required</AppText> : null}
        </View>
      </Pressable>
    );
  }

  if (field.fieldType === "signature" || field.fieldType === "initials") {
    const signature =
      value && typeof value === "object" && "method" in value ? value : null;
    const suggested =
      field.fieldType === "initials" ? initials(signerName) : signerName;

    return (
      <View style={styles.fieldCard}>
        <View style={styles.row}>
          <AppText variant="subtitle">
            {field.label ||
              (field.fieldType === "initials" ? "Initials" : "Signature")}
          </AppText>
          {field.required ? <AppText variant="caption">Required</AppText> : null}
        </View>
        <TextInput
          autoCapitalize="words"
          onChangeText={(text) => onChange({ method: "typed", value: text })}
          placeholder={suggested}
          style={[styles.input, styles.signatureInput]}
          value={signature?.value ?? ""}
        />
        <AppText variant="caption">
          Typing your name applies it as your electronic{" "}
          {field.fieldType === "initials" ? "initials" : "signature"}.
        </AppText>
      </View>
    );
  }

  const defaultValue =
    field.defaultValue ||
    (field.fieldType === "printed_name"
      ? signerName
      : field.fieldType === "date"
        ? new Date().toLocaleDateString()
        : "");
  const textValue = typeof value === "string" ? value : defaultValue;

  return (
    <View style={styles.fieldCard}>
      <View style={styles.row}>
        <AppText variant="subtitle">{field.label || "Document field"}</AppText>
        {field.required ? <AppText variant="caption">Required</AppText> : null}
      </View>
      <TextInput
        editable={field.fieldType !== "date"}
        multiline={field.fieldType === "text"}
        onChangeText={onChange}
        placeholder={field.placeholderText || field.label}
        style={[styles.input, field.fieldType === "text" && styles.multilineInput]}
        value={textValue}
      />
    </View>
  );
}

export default function StudentDocumentDetailScreen() {
  const params = useLocalSearchParams<{ assignmentId?: string | string[] }>();
  const assignmentId = normalizeParam(params.assignmentId);
  const [detail, setDetail] = useState<StudentDocumentDetail | null>(null);
  const [values, setValues] = useState<Record<string, StudentSigningValue>>({});
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pdfAccessToken, setPdfAccessToken] = useState<string | null>(null);
  const [localPdfUri, setLocalPdfUri] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfPageCount, setPdfPageCount] = useState(1);
  const downloadedPdfUriRef = useRef<string | null>(null);

  const completed = isCompleted(detail);
  const pdfUrl = completed
    ? detail?.document.signedUrl
    : detail?.document.sourceUrl;

  const pdfSource = useMemo(
    () => (localPdfUri ? { uri: localPdfUri, cache: false } : null),
    [localPdfUri],
  );

  const load = useCallback(async () => {
    if (!assignmentId) {
      setError("Document assignment is missing.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError) throw sessionError;

      let activeSession = session;
      const expiresSoon =
        !activeSession?.expires_at ||
        activeSession.expires_at * 1000 <= Date.now() + 60_000;

      if (expiresSoon) {
        const {
          data: { session: refreshedSession },
          error: refreshError,
        } = await supabase.auth.refreshSession();

        if (refreshError || !refreshedSession?.access_token) {
          throw new Error("Your session has expired. Please sign in again.");
        }

        activeSession = refreshedSession;
      }

      if (!activeSession?.access_token) {
        throw new Error("Authentication required.");
      }

      setPdfAccessToken(activeSession.access_token);

      const next = await loadStudentDocument(assignmentId);
      setDetail(next);

      const initialValues: Record<string, StudentSigningValue> = {};
      for (const field of next.fields) {
        if (field.fieldType === "printed_name") {
          initialValues[field.id] =
            field.defaultValue || next.document.signerName;
        } else if (field.fieldType === "date") {
          initialValues[field.id] =
            field.defaultValue || new Date().toLocaleDateString();
        } else if (field.defaultValue) {
          initialValues[field.id] = field.defaultValue;
        }
      }
      setValues(initialValues);
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "The document could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, [assignmentId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;

    async function downloadPdf() {
      if (!pdfUrl) {
        setLocalPdfUri(null);
        return;
      }

      const cacheDirectory = FileSystem.cacheDirectory;

      if (!cacheDirectory) {
        setError("The app cache is unavailable on this device.");
        setPdfLoading(false);
        return;
      }

      setPdfLoading(true);
      setLocalPdfUri(null);
      setPdfPage(1);
      setPdfPageCount(1);
      setError(null);

      try {
        const previousUri = downloadedPdfUriRef.current;
        downloadedPdfUriRef.current = null;

        if (previousUri) {
          await FileSystem.deleteAsync(previousUri, {
            idempotent: true,
          }).catch(() => undefined);
        }

        const filename =
          `danceflow-document-${assignmentId ?? "preview"}-${Date.now()}.pdf`;
        const destination = `${cacheDirectory}${filename}`;
        const isDanceFlowApiUrl = pdfUrl.includes("/api/student/documents/");
        const requestHeaders: Record<string, string> = {
          Accept: "application/pdf",
        };

        if (isDanceFlowApiUrl && pdfAccessToken) {
          requestHeaders.Authorization = `Bearer ${pdfAccessToken}`;
          requestHeaders["X-DanceFlow-Access-Token"] = pdfAccessToken;
        }

        const result = await FileSystem.downloadAsync(pdfUrl, destination, {
          headers: requestHeaders,
        });

        if (result.status !== 200) {
          await FileSystem.deleteAsync(result.uri, {
            idempotent: true,
          }).catch(() => undefined);

          throw new Error(
            `The PDF request failed with status ${result.status}.`,
          );
        }

        const fileInfo = await FileSystem.getInfoAsync(result.uri);

        if (!fileInfo.exists || !("size" in fileInfo) || fileInfo.size < 5) {
          await FileSystem.deleteAsync(result.uri, {
            idempotent: true,
          }).catch(() => undefined);

          throw new Error("The downloaded PDF file was empty.");
        }

        if (cancelled) {
          await FileSystem.deleteAsync(result.uri, {
            idempotent: true,
          }).catch(() => undefined);
          return;
        }

        downloadedPdfUriRef.current = result.uri;
        setLocalPdfUri(result.uri);
      } catch (downloadError) {
        if (!cancelled) {
          console.error("Student document PDF download failed", downloadError);
          setError(
            downloadError instanceof Error
              ? downloadError.message
              : "The PDF preview could not be downloaded.",
          );
        }
      } finally {
        if (!cancelled) {
          setPdfLoading(false);
        }
      }
    }

    void downloadPdf();

    return () => {
      cancelled = true;
    };
  }, [assignmentId, pdfAccessToken, pdfUrl]);

  useEffect(() => {
    return () => {
      const uri = downloadedPdfUriRef.current;

      if (uri) {
        void FileSystem.deleteAsync(uri, {
          idempotent: true,
        }).catch(() => undefined);
      }
    };
  }, []);


  const missingRequired = useMemo(() => {
    if (!detail || completed) return [];

    return detail.fields.filter((field) => {
      if (!field.required) return false;
      const value = values[field.id];

      if (field.fieldType === "checkbox") return value !== true;

      if (field.fieldType === "signature" || field.fieldType === "initials") {
        return !(
          value &&
          typeof value === "object" &&
          "value" in value &&
          value.value.trim()
        );
      }

      return !(typeof value === "string" && value.trim());
    });
  }, [completed, detail, values]);

  async function submit() {
    if (!assignmentId || !detail) return;

    if (missingRequired.length) {
      Alert.alert(
        "Complete required fields",
        `There ${missingRequired.length === 1 ? "is" : "are"} ${
          missingRequired.length
        } required field${missingRequired.length === 1 ? "" : "s"} remaining.`,
      );
      return;
    }

    if (!consent) {
      Alert.alert(
        "Consent required",
        "Confirm that you agree to use an electronic signature.",
      );
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await completeStudentDocument({
        assignmentId,
        signerName: detail.document.signerName,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        consent,
        values,
      });
      await load();
      Alert.alert("Document signed", "Your signed document is now available.");
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : "The document could not be completed.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <Screen>
        <ActivityIndicator color={colors.primary} size="large" />
        <AppText variant="caption">Loading secure document…</AppText>
      </Screen>
    );
  }

  if (error && !detail) {
    return (
      <Screen>
        <FeatureCard title="Document unavailable" detail={error} />
        <AppButton label="Try again" onPress={load} />
      </Screen>
    );
  }

  if (!detail) return null;

  const unavailable =
    !completed &&
    (!detail.document.nativeSigningAvailable ||
      ["expired", "void", "declined"].includes(
        detail.document.envelopeStatus ?? detail.document.status,
      ));

  return (
    <Screen>
      <AppText variant="eyebrow">{detail.document.studioName}</AppText>
      <AppText variant="title">{detail.document.title}</AppText>
      {detail.document.description ? (
        <AppText variant="caption">{detail.document.description}</AppText>
      ) : null}

      {error ? <FeatureCard title="Signing needs attention" detail={error} /> : null}

      {pdfLoading ? (
        <View style={styles.pdfLoadingCard}>
          <ActivityIndicator color={colors.primary} size="large" />
          <AppText variant="caption">Preparing PDF preview…</AppText>
        </View>
      ) : pdfSource ? (
        <View style={styles.pdfCard}>
          <Pdf
            source={pdfSource}
            page={pdfPage}
            horizontal
            enablePaging
            fitPolicy={0}
            style={styles.pdf}
            trustAllCerts={false}
            onLoadComplete={(numberOfPages) => {
              setPdfPageCount(Math.max(numberOfPages, 1));
              setPdfPage((current) =>
                Math.min(Math.max(current, 1), Math.max(numberOfPages, 1)),
              );
            }}
            onPageChanged={(page, numberOfPages) => {
              setPdfPage(page);
              setPdfPageCount(Math.max(numberOfPages, 1));
            }}
            onError={(pdfError) => {
              console.error("Student document PDF preview failed", pdfError);
              setError(
                pdfError instanceof Error
                  ? pdfError.message
                  : `The PDF preview could not be loaded: ${String(pdfError)}`,
              );
            }}
          />
          <View style={styles.pdfNavigation}>
            <Pressable
              accessibilityRole="button"
              disabled={pdfPage <= 1}
              onPress={() => setPdfPage((current) => Math.max(current - 1, 1))}
              style={[
                styles.pdfNavigationButton,
                pdfPage <= 1 && styles.pdfNavigationButtonDisabled,
              ]}
            >
              <AppText style={styles.pdfNavigationButtonText}>Previous</AppText>
            </Pressable>

            <AppText variant="caption">
              Page {pdfPage} of {pdfPageCount}
            </AppText>

            <Pressable
              accessibilityRole="button"
              disabled={pdfPage >= pdfPageCount}
              onPress={() =>
                setPdfPage((current) => Math.min(current + 1, pdfPageCount))
              }
              style={[
                styles.pdfNavigationButton,
                pdfPage >= pdfPageCount && styles.pdfNavigationButtonDisabled,
              ]}
            >
              <AppText style={styles.pdfNavigationButtonText}>Next</AppText>
            </Pressable>
          </View>
        </View>
      ) : (
        <FeatureCard
          title={completed ? "Signed copy unavailable" : "PDF preview unavailable"}
          detail={
            completed
              ? "The signed PDF is not available yet."
              : pdfUrl
                ? "The document is ready, but the app could not prepare the preview."
                : "The sender is still preparing the signing fields."
          }
        />
      )}

      {completed ? (
        <FeatureCard
          title="Document completed"
          detail="Your electronic signature was recorded and the signed PDF is shown above."
        />
      ) : unavailable ? (
        <FeatureCard
          title="Signing request unavailable"
          detail="This request is still being prepared, expired, was declined, or was withdrawn. Contact the studio or event organizer for help."
        />
      ) : (
        <>
          <View style={styles.section}>
            <AppText variant="subtitle">Complete the document</AppText>
            <AppText variant="caption">
              Review the PDF, then complete each required field below.
            </AppText>

            {detail.fields.map((field) => (
              <FieldEditor
                key={field.id}
                field={field}
                signerName={detail.document.signerName}
                value={values[field.id]}
                onChange={(value) =>
                  setValues((current) => ({ ...current, [field.id]: value }))
                }
              />
            ))}
          </View>

          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: consent }}
            onPress={() => setConsent((current) => !current)}
            style={[styles.consentCard, consent && styles.consentCardChecked]}
          >
            <View style={[styles.checkbox, consent && styles.checkboxChecked]}>
              {consent ? <AppText style={styles.checkboxMark}>✓</AppText> : null}
            </View>
            <AppText style={styles.consentText}>
              I reviewed this document, agree to use electronic records and
              signatures, and confirm that the signature I apply is my own.
            </AppText>
          </Pressable>

          <AppButton
            label="Finish and Sign"
            loading={submitting}
            onPress={submit}
          />
        </>
      )}

      <AppButton
        label="Back to Documents"
        onPress={() => router.back()}
        variant="secondary"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  checkbox: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: 7,
    borderWidth: 2,
    height: 26,
    justifyContent: "center",
    width: 26,
  },
  checkboxChecked: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  checkboxMark: {
    color: "#fff",
    fontSize: 17,
    fontWeight: "900",
  },
  checkboxRow: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 16,
  },
  checkboxRowChecked: {
    borderColor: colors.primary,
  },
  consentCard: {
    alignItems: "flex-start",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    padding: 16,
  },
  consentCardChecked: {
    borderColor: colors.primary,
  },
  consentText: {
    color: colors.text,
    flex: 1,
    fontSize: 14,
    lineHeight: 21,
  },
  fieldCard: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 10,
    padding: 16,
  },
  fieldCopy: {
    flex: 1,
    gap: 2,
  },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: 1,
    color: colors.text,
    fontSize: 16,
    minHeight: 50,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  multilineInput: {
    minHeight: 96,
    textAlignVertical: "top",
  },
  pdf: {
    flex: 1,
    minHeight: 520,
    width: "100%",
  },
  pdfCard: {
    backgroundColor: "#e2e8f0",
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    height: 610,
    overflow: "hidden",
  },
  pdfNavigation: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderTopColor: colors.border,
    borderTopWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pdfNavigationButton: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: 10,
    minWidth: 88,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  pdfNavigationButtonDisabled: {
    opacity: 0.4,
  },
  pdfNavigationButtonText: {
    color: "#fff",
    fontSize: 13,
    fontWeight: "700",
  },
  pdfLoadingCard: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    gap: 12,
    justifyContent: "center",
    minHeight: 220,
    padding: 24,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    justifyContent: "space-between",
  },
  section: {
    gap: 12,
  },
  signatureInput: {
    fontSize: 22,
    fontStyle: "italic",
  },
});