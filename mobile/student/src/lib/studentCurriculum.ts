import { danceflowApiFetch } from "@/lib/danceflowApi";

export type StudentCurriculumAssignment = {
  id: string;
  studioId: string;
  clientId: string;
  studioName: string;
  studioSlug: string | null;
  stepId: string;
  stepName: string;
  alternateName: string | null;
  summary: string | null;
  timing: string | null;
  counts: string | null;
  studentNotes: string | null;
  styleName: string | null;
  danceName: string | null;
  levelName: string | null;
  assignedAt: string;
  targetDate: string | null;
  priority: string;
  status: string;
  practiceNote: string | null;
  completedAt: string | null;
};

export type StudentCurriculumChartRow = {
  id: string;
  countLabel: string | null;
  leaderFoot: string | null;
  leaderAction: string | null;
  followerFoot: string | null;
  followerAction: string | null;
  direction: string | null;
  notes: string | null;
};

export type StudentCurriculumDetail = {
  id: string;
  studioId: string;
  clientId: string;
  studioName: string;
  studioSlug: string | null;
  assignedAt: string;
  targetDate: string | null;
  priority: string;
  status: string;
  practiceNote: string | null;
  completedAt: string | null;
  step: {
    id: string;
    name: string;
    alternateName: string | null;
    summary: string | null;
    prerequisiteNotes: string | null;
    timing: string | null;
    counts: string | null;
    startingPosition: string | null;
    endingPosition: string | null;
    techniqueNotes: string | null;
    studentNotes: string | null;
    styleName: string | null;
    danceName: string | null;
    levelName: string | null;
  };
  chart: {
    id: string;
    title: string;
    format: string;
    notes: string | null;
    rows: StudentCurriculumChartRow[];
  } | null;
  videos: Array<{
    id: string;
    title: string;
    description: string | null;
    contentType: string;
    presentationType: string;
    durationSeconds: number | null;
    displayOrder: number;
  }>;
};

export async function loadStudentCurriculumAssignments() {
  const payload = await danceflowApiFetch<{
    assignments: StudentCurriculumAssignment[];
  }>("/api/student/syllabus/assignments");

  return payload.assignments;
}

export async function loadStudentCurriculumAssignment(assignmentId: string) {
  const payload = await danceflowApiFetch<{
    assignment: StudentCurriculumDetail;
  }>(
    `/api/student/syllabus/assignments/${encodeURIComponent(assignmentId)}`,
  );

  return payload.assignment;
}

export async function loadStudentCurriculumVideo(
  assignmentId: string,
  videoAssetId: string,
) {
  const payload = await danceflowApiFetch<{
    video: {
      id: string;
      title: string;
      description: string | null;
      durationSeconds: number | null;
      url: string;
      expiresAt: string;
    };
  }>(
    `/api/student/syllabus/videos/${encodeURIComponent(
      videoAssetId,
    )}/playback`,
    {
      params: { assignmentId },
    },
  );

  return payload.video;
}
