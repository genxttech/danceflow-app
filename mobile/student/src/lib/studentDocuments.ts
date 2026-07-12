import { danceflowApiFetch } from "@/lib/danceflowApi";

export type StudentDocument = {
  id: string;
  studioId: string;
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
  actionUrl: string | null;
};

export async function loadStudentDocuments() {
  const response = await danceflowApiFetch<{ documents: StudentDocument[] }>(
    "/api/student/documents",
  );
  return response.documents ?? [];
}
