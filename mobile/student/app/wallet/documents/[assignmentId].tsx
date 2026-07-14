import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import Pdf from "react-native-pdf";
import ReactNativeBlobUtil from "react-native-blob-util";
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
    let downloadedPath: string | null = null;

    async function downloadPdf() {
      if (!pdfUrl || !pdfAccessToken) {
        setLocalPdfUri(null);
        return;
      }

      setPdfLoading(true);
      setLocalPdfUri(null);

      try {
        const response = await ReactNativeBlobUtil.config({
          fileCache: true,
          appendExt: "pdf",
        }).fetch("GET", pdfUrl, {
          Authorization: `Bearer ${pdfAccessToken}`,
          "X-DanceFlow-Access-Token": pdfAccessToken,
          Accept: "application/pdf",
        });

        const info = response.info();
        const headers = info.headers ?? {};
        const contentType =
          headers["Content-Type"] ??
          headers["content-type"] ??
          "";

        if (info.status !== 200) {
          const responseText = await response.text();
          throw new Error(
            `The PDF request failed (${info.status}). ${responseText.slice(0, 180)}`,
          );
        }

        if (
          contentType &&
          !String(contentType).toLowerCase().includes("application/pdf")
        ) {
          const responseText = await response.text();
          throw new Error(
            `The server returned ${contentType} instead of a PDF. ${responseText.slice(0, 180)}`,
          );
        }

        downloadedPath = response.path();
        const filePrefix = await ReactNativeBlobUtil.fs.readFile(
          downloadedPath,
          "ascii",
        );

        if (!filePrefix.startsWith("%PDF-")) {
          throw new Error("The downloaded response is not a valid PDF file.");
        }

        if (!cancelled) {
          setLocalPdfUri(`file://${downloadedPath}`);
        }
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

      if (downloadedPath) {
        void ReactNativeBlobUtil.fs
          .unlink(downloadedPath)
          .catch(() => undefined);
      }
    };
  }, [pdfAccessToken, pdfUrl]);


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
            style={styles.pdf}
            trustAllCerts={false}
            onError={(pdfError) => {
              console.error("Student document PDF preview failed", pdfError);
              setError(
                pdfError instanceof Error
                  ? pdfError.message
                  : `The PDF preview could not be loaded: ${String(pdfError)}`,
              );
            }}
          />
        </View>
      ) : (
        <FeatureCard
          title={completed ? "Signed copy unavailable" : "Document preparing"}
          detail={
            completed
              ? "The signed PDF is not available yet."
              : "Your studio is still preparing the signing fields."
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
          detail="This request is still being prepared, expired, was declined, or was withdrawn. Contact the studio for help."
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
    minHeight: 560,
    width: "100%",
  },
  pdfCard: {
    backgroundColor: "#e2e8f0",
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: 1,
    height: 600,
    overflow: "hidden",
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