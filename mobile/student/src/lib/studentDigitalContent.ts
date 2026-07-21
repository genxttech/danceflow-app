import { danceflowApiFetch } from "@/lib/danceflowApi";

export type StudentDigitalVideo = {
  catalogItemId: string;
  title: string;
  summary: string | null;
  instructorName: string | null;
  skillLevel: string | null;
  danceStyle: string | null;
  durationSeconds: number | null;
};

export type StudentDigitalPlayback = {
  catalogItemId: string;
  url: string;
  expiresAt: string;
};

export type StudentDigitalContentAccess = {
  entitlementId: string;
  itemType: string;
  name: string;
  description: string | null;
  videos: StudentDigitalVideo[];
  playback: StudentDigitalPlayback | null;
  accessExpiresAt: string | null;
};

export async function loadStudentDigitalContent(
  entitlementId: string,
  catalogItemId?: string | null
) {
  return danceflowApiFetch<StudentDigitalContentAccess>(
    `/api/student/digital-content/${encodeURIComponent(
      entitlementId
    )}/playback`,
    {
      params: {
        catalogItemId: catalogItemId ?? null
      }
    }
  );
}
