import { danceflowApiFetch } from "@/lib/danceflowApi";

export type StudentDocument = {
  id: string;
  studioId: string;
  clientId: string;
  studioName: string;
  studioSlug: string | null;
  title: string;
  description: string | null;
  documentType: string;
  required: boolean;
  requiresSignature: boolean;
  status: string;
  dueAt: string | null;
  assignedAt: string;
  signedAt: string | null;
  envelopeStatus: string | null;
  nativeSigningAvailable: boolean;
};

export type StudentDocumentField = {
  id: string;
  fieldType:
    | "signature"
    | "initials"
    | "printed_name"
    | "date"
    | "text"
    | "checkbox";
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  required: boolean;
  placeholderText: string | null;
  defaultValue: string | null;
};

export type StudentDocumentDetail = {
  document: StudentDocument & {
    signerName: string;
    signerEmail: string | null;
    expiresAt: string | null;
    pageCount: number;
    pageSizes: Array<{ pageNumber: number; width: number; height: number }>;
    sourceUrl: string | null;
    signedUrl: string | null;
  };
  fields: StudentDocumentField[];
};

export type StudentSigningValue =
  | string
  | boolean
  | { method: "typed"; value: string };

export async function loadStudentDocuments() {
  const payload = await danceflowApiFetch<{ documents: StudentDocument[] }>(
    "/api/student/documents",
  );
  return payload.documents;
}

export async function loadStudentDocument(assignmentId: string) {
  return danceflowApiFetch<StudentDocumentDetail>(
    `/api/student/documents/${encodeURIComponent(assignmentId)}`,
  );
}

export async function completeStudentDocument(params: {
  assignmentId: string;
  signerName: string;
  timezone: string;
  consent: boolean;
  values: Record<string, StudentSigningValue>;
}) {
  return danceflowApiFetch<{
    completed: true;
    signedAt: string;
    signedUrl: string | null;
  }>(
    `/api/student/documents/${encodeURIComponent(params.assignmentId)}/complete`,
    {
      method: "POST",
      body: JSON.stringify({
        signerName: params.signerName,
        timezone: params.timezone,
        consent: params.consent,
        values: params.values,
      }),
    },
  );
}
