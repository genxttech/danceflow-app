import { danceflowApiFetch } from "@/lib/danceflowApi";

export type StudentDigitalProgress = {
  catalogItemId: string;
  positionSeconds: number;
  durationSeconds: number;
  percentComplete: number;
  completed: boolean;
  completedAt: string | null;
  lastWatchedAt: string | null;
};

export type StudentDigitalVideo = {
  catalogItemId: string;
  title: string;
  summary: string | null;
  instructorName: string | null;
  skillLevel: string | null;
  danceStyle: string | null;
  durationSeconds: number | null;
  progress: StudentDigitalProgress | null;
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
  selectedProgress: StudentDigitalProgress | null;
  accessExpiresAt: string | null;
};

export type StudentDigitalLibraryItem = {
  entitlementId: string;
  catalogItemId: string;
  studioId: string;
  studioName: string;
  name: string;
  description: string | null;
  itemType: string;
  imageUrl: string | null;
  percentComplete: number;
  completed: boolean;
  lastWatchedAt: string | null;
  resumeCatalogItemId: string | null;
  resumePositionSeconds: number;
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


export async function saveStudentDigitalProgress(
  entitlementId: string,
  input: {
    catalogItemId: string;
    positionSeconds: number;
    durationSeconds: number;
    completed?: boolean;
  }
) {
  return danceflowApiFetch<StudentDigitalProgress>(
    `/api/student/digital-content/${encodeURIComponent(entitlementId)}/progress`,
    {
      method: "POST",
      body: JSON.stringify(input)
    }
  );
}

export async function loadStudentDigitalLibrary() {
  const response = await danceflowApiFetch<{ items: StudentDigitalLibraryItem[] }>(
    "/api/student/digital-content"
  );
  return response.items;
}
