import { supabase } from "@/lib/supabase";
import type { LinkedStudioAccess } from "@/lib/studentAccess";
import {
  appointmentTypeLabel,
  formatScheduleTimeRange
} from "@/lib/studentSchedule";

export type StudentLearnLesson = {
  id: string;
  studioId: string;
  studioName: string;
  studioSlug: string;
  title: string;
  typeLabel: string;
  status: string;
  timeText: string;
  startsAt: string;
  instructorName: string | null;
  roomName: string | null;
};

export type StudentPracticeFocus = {
  id: string;
  title: string;
  detail: string;
};

export type StudentGroupLessonRecap = {
  id: string;
  recapId: string;
  studioId: string;
  studioName: string;
  studioSlug: string;
  title: string;
  summary: string | null;
  techniqueNotes: string | null;
  safetyNotes: string | null;
  practiceAssignment: string | null;
  mediaLinks: string[];
  publishedAt: string | null;
  source: string;
};

export type StudentLearnOverview = {
  recentLessons: StudentLearnLesson[];
  groupLessonRecaps: StudentGroupLessonRecap[];
  practiceFocus: StudentPracticeFocus[];
  lumiPrompts: string[];
};

type StudioSettingRow = {
  studio_id: string;
  timezone: string | null;
};

type AppointmentRow = {
  id: string;
  studio_id: string;
  client_id: string;
  appointment_type: string | null;
  title: string | null;
  status: string | null;
  starts_at: string;
  ends_at: string | null;
  instructors:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null;
  rooms:
    | { name: string | null }
    | { name: string | null }[]
    | null;
};

type GroupLessonRecapRecipientRow = {
  id: string;
  studio_id: string;
  client_id: string | null;
  source: string | null;
  group_lesson_recaps:
    | {
        id: string;
        studio_id: string;
        title: string;
        summary: string | null;
        technique_notes: string | null;
        safety_notes: string | null;
        practice_assignment: string | null;
        media_links: string[] | null;
        published_at: string | null;
        status: string | null;
      }
    | {
        id: string;
        studio_id: string;
        title: string;
        summary: string | null;
        technique_notes: string | null;
        safety_notes: string | null;
        practice_assignment: string | null;
        media_links: string[] | null;
        published_at: string | null;
        status: string | null;
      }[]
    | null;
};

function firstJoin<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function personName(
  value:
    | { first_name: string | null; last_name: string | null }
    | { first_name: string | null; last_name: string | null }[]
    | null
    | undefined
) {
  const row = firstJoin(value);
  const name = [row?.first_name, row?.last_name].filter(Boolean).join(" ").trim();
  return name || null;
}

function roomName(value: { name: string | null } | { name: string | null }[] | null | undefined) {
  const row = firstJoin(value);
  return row?.name?.trim() || null;
}

function studioDisplayName(studio: LinkedStudioAccess) {
  return studio.studioPublicName || studio.studioName || "Studio";
}

function toLesson(row: AppointmentRow, studio: LinkedStudioAccess, timeZone: string): StudentLearnLesson {
  const typeLabel = appointmentTypeLabel(row.appointment_type);
  const instructorName = personName(row.instructors);
  const room = roomName(row.rooms);

  return {
    id: row.id,
    studioId: row.studio_id,
    studioName: studioDisplayName(studio),
    studioSlug: studio.studioSlug,
    title: row.title?.trim() || typeLabel,
    typeLabel,
    status: row.status || "completed",
    timeText: formatScheduleTimeRange(row.starts_at, row.ends_at, timeZone),
    startsAt: row.starts_at,
    instructorName,
    roomName: room
  };
}

function buildPracticeFocus(recentLessons: StudentLearnLesson[]): StudentPracticeFocus[] {
  const lessonsWithTypes = recentLessons.slice(0, 3);

  if (!lessonsWithTypes.length) {
    return [
      {
        id: "start",
        title: "Start with your next lesson",
        detail:
          "Once your studio posts lesson history, this area will turn recent lessons into practice focus areas."
      }
    ];
  }

  const focus: StudentPracticeFocus[] = lessonsWithTypes.map((lesson, index) => ({
    id: `${lesson.id}-focus`,
    title: index === 0 ? "Review your latest lesson" : `Revisit ${lesson.typeLabel.toLowerCase()}`,
    detail: `${lesson.title}${lesson.instructorName ? ` with ${lesson.instructorName}` : ""}. Ask LUMI for a focused practice plan before your next session.`
  }));

  if (focus.length < 3) {
    focus.push({
      id: "consistency",
      title: "Build consistency",
      detail:
        "Pick one small skill from your recent lesson and practice it for 10 minutes before your next appointment."
    });
  }

  return focus.slice(0, 3);
}

function isGroupLesson(lesson: StudentLearnLesson) {
  return lesson.typeLabel.toLowerCase().includes("group");
}

function toGroupLessonRecap(
  row: GroupLessonRecapRecipientRow,
  studioById: Map<string, LinkedStudioAccess>
): StudentGroupLessonRecap | null {
  const recap = firstJoin(row.group_lesson_recaps);
  const studio = studioById.get(row.studio_id);

  if (!recap || !studio || recap.status !== "published") {
    return null;
  }

  return {
    id: row.id,
    recapId: recap.id,
    studioId: row.studio_id,
    studioName: studioDisplayName(studio),
    studioSlug: studio.studioSlug,
    title: recap.title,
    summary: recap.summary,
    techniqueNotes: recap.technique_notes,
    safetyNotes: recap.safety_notes,
    practiceAssignment: recap.practice_assignment,
    mediaLinks: recap.media_links ?? [],
    publishedAt: recap.published_at,
    source: row.source ?? "checked_in"
  };
}

function buildLumiPrompts(
  recentLessons: StudentLearnLesson[],
  groupLessonRecaps: StudentGroupLessonRecap[]
) {
  const latest = recentLessons[0];
  const latestGroupRecap = groupLessonRecaps[0];

  if (!latest && !latestGroupRecap) {
    return [
      "What should I practice before my first linked lesson?",
      "How do I set a dance goal?",
      "How can I feel more confident at my next class?"
    ];
  }

  if (!latest && latestGroupRecap) {
    return [
      `Help me review ${latestGroupRecap.title}.`,
      "Turn my group class recap into a 15-minute practice plan.",
      "What should I focus on before my next class?"
    ];
  }

  const prompts = [
    `What should I practice from ${latest.title}?`,
    "Turn my recent lessons into a weekly practice plan.",
    "What should I ask my instructor next time?"
  ];

  if (latestGroupRecap) {
    prompts[1] = `Help me review ${latestGroupRecap.title} from group class.`;
  }

  return prompts;
}

export async function loadStudentLearnOverview(
  linkedStudios: LinkedStudioAccess[]
): Promise<StudentLearnOverview> {
  if (!linkedStudios.length) {
    return {
      recentLessons: [],
      groupLessonRecaps: [],
      practiceFocus: [],
      lumiPrompts: buildLumiPrompts([], [])
    };
  }

  const studioIds = linkedStudios.map((studio) => studio.studioId);
  const clientIds = linkedStudios.map((studio) => studio.clientId);
  const studioById = new Map(linkedStudios.map((studio) => [studio.studioId, studio]));

  const { data: settingRows, error: settingsError } = await supabase
    .from("studio_settings")
    .select("studio_id, timezone")
    .in("studio_id", studioIds);

  if (settingsError) {
    throw settingsError;
  }

  const timeZoneByStudioId = new Map(
    ((settingRows ?? []) as StudioSettingRow[]).map((row) => [
      row.studio_id,
      row.timezone || "America/New_York"
    ])
  );

  const recentStartIso = new Date(Date.now() - 1000 * 60 * 60 * 24 * 120).toISOString();
  const nowIso = new Date().toISOString();

  const lessonQueries = linkedStudios.map((studio) =>
    supabase
      .from("appointments")
      .select(
        `
        id,
        studio_id,
        client_id,
        appointment_type,
        title,
        status,
        starts_at,
        ends_at,
        instructors ( first_name, last_name ),
        rooms ( name )
      `
      )
      .eq("studio_id", studio.studioId)
      .eq("client_id", studio.clientId)
      .gte("starts_at", recentStartIso)
      .lt("starts_at", nowIso)
      .neq("status", "cancelled")
      .order("starts_at", { ascending: false })
      .limit(10)
  );

  const results = await Promise.all(lessonQueries);
  const recentLessons: StudentLearnLesson[] = [];

  results.forEach((result) => {
    if (result.error) throw result.error;

    ((result.data ?? []) as AppointmentRow[]).forEach((row) => {
      const studio = studioById.get(row.studio_id);
      if (!studio) return;

      recentLessons.push(
        toLesson(row, studio, timeZoneByStudioId.get(row.studio_id) || "America/New_York")
      );
    });
  });

  recentLessons.sort(
    (a, b) => new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime()
  );

  const slicedLessons = recentLessons.slice(0, 12);

  const { data: recapRows, error: recapError } = await supabase
    .from("group_lesson_recap_recipients")
    .select(
      `
      id,
      studio_id,
      client_id,
      source,
      group_lesson_recaps (
        id,
        studio_id,
        title,
        summary,
        technique_notes,
        safety_notes,
        practice_assignment,
        media_links,
        published_at,
        status
      )
    `
    )
    .in("studio_id", studioIds)
    .in("client_id", clientIds)
    .neq("delivery_status", "revoked")
    .order("created_at", { ascending: false })
    .limit(12);

  if (recapError) {
    throw recapError;
  }

  const groupLessonRecaps = ((recapRows ?? []) as GroupLessonRecapRecipientRow[])
    .map((row) => toGroupLessonRecap(row, studioById))
    .filter((item): item is StudentGroupLessonRecap => Boolean(item))
    .sort(
      (a, b) =>
        new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime()
    )
    .slice(0, 6);

  return {
    recentLessons: slicedLessons,
    groupLessonRecaps,
    practiceFocus: buildPracticeFocus(slicedLessons),
    lumiPrompts: buildLumiPrompts(slicedLessons, groupLessonRecaps)
  };
}
