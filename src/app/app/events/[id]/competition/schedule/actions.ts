"use server";

import { revalidatePath } from "next/cache";
import { getCurrentStudioContext } from "@/lib/auth/studio";
import { createClient } from "@/lib/supabase/server";

const BLOCK_TYPES = ["competition", "awards", "break", "meal", "showcase", "workshop", "practice", "registration", "other"];
const ROUND_TYPES = ["qualifying", "preliminary", "quarterfinal", "semifinal", "final", "proficiency", "feedback", "exhibition", "all", "custom"];
const DEFAULT_TIME_ZONE = "America/New_York";

function text(formData: FormData, key: string) {
  return String(formData.get(key) ?? "").trim();
}

function allowed(value: string, values: string[], fallback: string) {
  return values.includes(value) ? value : fallback;
}

function positiveInteger(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getStudioTimeZone(value?: string | null) {
  const timeZone = value?.trim() || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function getZonedOffsetMs(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? "0");
  const hour = part("hour") === 24 ? 0 : part("hour");
  return Date.UTC(part("year"), part("month") - 1, part("day"), hour, part("minute"), part("second")) - date.getTime();
}

function zonedDateTimeToUtcIso(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hours, minutes] = time.split(":").map(Number);
  if (![year, month, day, hours, minutes].every(Number.isFinite)) throw new Error("A valid date and time are required.");
  const wallClock = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);
  let utcMs = wallClock;
  for (let index = 0; index < 3; index += 1) utcMs = wallClock - getZonedOffsetMs(new Date(utcMs), timeZone);
  return new Date(utcMs).toISOString();
}

async function requireEventManager(eventId: string) {
  const context = await getCurrentStudioContext();
  const supabase = await createClient();
  const { data: event, error } = await supabase
    .from("events")
    .select("id, studio_id, organizer_id")
    .eq("id", eventId)
    .eq("studio_id", context.studioId)
    .maybeSingle();
  if (error || !event) throw new Error("Event not found.");

  const studioCanManage = ["studio_owner", "studio_admin"].includes(context.studioRole ?? "");
  let organizerCanManage = false;
  if (event.organizer_id) {
    const { data: organizerUser } = await supabase
      .from("organizer_users")
      .select("role")
      .eq("organizer_id", event.organizer_id)
      .eq("user_id", context.userId)
      .eq("active", true)
      .maybeSingle();
    organizerCanManage = ["organizer_owner", "organizer_admin", "organizer_staff"].includes(organizerUser?.role ?? "");
  }
  if (!context.isPlatformAdmin && !studioCanManage && !organizerCanManage) throw new Error("You do not have permission to manage this competition.");

  const { data: settings } = await supabase.from("studio_settings").select("timezone").eq("studio_id", event.studio_id).maybeSingle();
  return { supabase, timeZone: getStudioTimeZone(settings?.timezone) };
}

function refresh(eventId: string) {
  revalidatePath(`/app/events/${eventId}/competition`);
  revalidatePath(`/app/events/${eventId}/competition/schedule`);
}

export async function createScheduleVersionAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  if (!eventId) throw new Error("Event is required.");
  const { supabase } = await requireEventManager(eventId);
  const { error } = await (supabase as any).rpc("create_competition_schedule_version", {
    selected_event_id: eventId,
    selected_name: text(formData, "name") || null,
    source_version_id: text(formData, "sourceVersionId") || null,
  });
  if (error) throw new Error(`Could not create schedule version: ${error.message}`);
  refresh(eventId);
}

export async function createScheduleFloorAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const name = text(formData, "name");
  if (!eventId || !name) throw new Error("Event and floor name are required.");
  const { supabase } = await requireEventManager(eventId);
  const { error } = await (supabase as any).from("event_competition_schedule_floors").insert({
    event_id: eventId,
    name,
    location_label: text(formData, "locationLabel") || null,
    capacity: positiveInteger(text(formData, "capacity"), 1),
  });
  if (error) throw new Error(`Could not create floor: ${error.message}`);
  refresh(eventId);
}

export async function createScheduleSessionAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const versionId = text(formData, "versionId");
  const name = text(formData, "name");
  const date = text(formData, "date");
  if (!eventId || !versionId || !name || !date) throw new Error("Schedule, name, and date are required.");
  const { supabase, timeZone } = await requireEventManager(eventId);
  const { error } = await (supabase as any).from("event_competition_schedule_sessions").insert({
    event_id: eventId,
    schedule_version_id: versionId,
    name,
    session_date: date,
    starts_at: zonedDateTimeToUtcIso(date, text(formData, "startTime"), timeZone),
    ends_at: zonedDateTimeToUtcIso(date, text(formData, "endTime"), timeZone),
  });
  if (error) throw new Error(`Could not create session: ${error.message}`);
  refresh(eventId);
}

export async function createScheduleBlockAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const versionId = text(formData, "versionId");
  const sessionId = text(formData, "sessionId");
  const name = text(formData, "name");
  const date = text(formData, "date");
  if (!eventId || !versionId || !sessionId || !name || !date) throw new Error("Session and block details are required.");
  const { supabase, timeZone } = await requireEventManager(eventId);
  const { error } = await (supabase as any).from("event_competition_schedule_blocks").insert({
    event_id: eventId,
    schedule_version_id: versionId,
    session_id: sessionId,
    floor_id: text(formData, "floorId") || null,
    name,
    block_type: allowed(text(formData, "blockType"), BLOCK_TYPES, "other"),
    starts_at: zonedDateTimeToUtcIso(date, text(formData, "startTime"), timeZone),
    ends_at: zonedDateTimeToUtcIso(date, text(formData, "endTime"), timeZone),
  });
  if (error) throw new Error(`Could not create schedule block: ${error.message}`);
  refresh(eventId);
}

export async function assignContestToBlockAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const versionId = text(formData, "versionId");
  const blockId = text(formData, "blockId");
  const contestId = text(formData, "contestId");
  if (!eventId || !versionId || !blockId || !contestId) throw new Error("Block and competition event are required.");
  const { supabase } = await requireEventManager(eventId);
  const { error } = await (supabase as any).from("event_competition_schedule_block_contests").insert({
    event_id: eventId,
    schedule_version_id: versionId,
    block_id: blockId,
    contest_id: contestId,
    planned_round_type: allowed(text(formData, "plannedRoundType"), ROUND_TYPES, "all"),
  });
  if (error) throw new Error(`Could not assign competition event: ${error.message}`);
  refresh(eventId);
}

export async function publishScheduleVersionAction(formData: FormData): Promise<void> {
  const eventId = text(formData, "eventId");
  const versionId = text(formData, "versionId");
  if (!eventId || !versionId) throw new Error("Schedule version is required.");
  const { supabase } = await requireEventManager(eventId);
  const { error } = await (supabase as any).rpc("publish_competition_schedule_version", { selected_version_id: versionId });
  if (error) throw new Error(`Could not publish schedule: ${error.message}`);
  refresh(eventId);
}
