import { danceflowApiFetch } from "@/lib/danceflowApi";

const DEFAULT_WEB_BASE_URL = "https://idanceflow.com";

function webBaseUrl() {
  const value =
    process.env.EXPO_PUBLIC_DANCEFLOW_WEB_URL ?? DEFAULT_WEB_BASE_URL;
  return value.replace(/\/$/, "");
}

export type LinkedStudioAccess = {
  linkId?: string | null;
  clientId: string;
  studioId: string;
  studioSlug: string;
  studioName: string;
  studioPublicName: string | null;
  clientFirstName: string | null;
  clientLastName: string | null;
  clientEmail: string | null;
  clientPhone: string | null;
  isIndependentInstructor: boolean;
  lumiEnabled: boolean;
  status?: string;
  relationshipType?: string;
};

export function studentPassCode(
  access: Pick<LinkedStudioAccess, "clientId" | "studioId">,
) {
  return `danceflow-pass:${access.studioId}:${access.clientId}`;
}

export function studentPassQrImageUrl(
  access: Pick<LinkedStudioAccess, "clientId" | "studioId">,
) {
  return `${webBaseUrl()}/api/tickets/qr?code=${encodeURIComponent(
    studentPassCode(access),
  )}`;
}

type StudentAccessResponse = {
  hasPortalAccess: boolean;
  linkedStudios: LinkedStudioAccess[];
  primaryStudio: LinkedStudioAccess | null;
  lumiEnabled: boolean;
};

export async function getStudentAccess(_userId: string) {
  return danceflowApiFetch<StudentAccessResponse>(
    "/api/student/studio-links",
  );
}
