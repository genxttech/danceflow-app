"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAppointmentCreateAccess, requireAppointmentEditAccess } from "@/lib/auth/serverRoleGuard";
import { detectAppointmentConflicts } from "@/lib/schedule/conflicts";
import { generateWeeklyOccurrenceDates } from "@/lib/utils/recurrence";

function getString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}
function getBoolean(formData: FormData, key: string) {
  const value = formData.get(key);
  return value === "true" || value === "1" || value === "on";
}
const DEFAULT_TZ = "America/New_York";
function getParts(value: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false }).formatToParts(value);
  const map = new Map(parts.map((part) => [part.type, part.value]));
  return { year:Number(map.get("year")), month:Number(map.get("month")), day:Number(map.get("day")), hour:Number(map.get("hour")), minute:Number(map.get("minute")), second:Number(map.get("second")) };
}
function offsetMs(value: Date, timeZone: string) {
  const p = getParts(value, timeZone);
  return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-value.getTime();
}
function localToUtc(value: string, timeZone: string) {
  const [date,time] = value.split("T");
  if (!date || !time) return null;
  const [y,m,d]=date.split("-").map(Number);
  const [h,min,s=0]=time.split(":").map(Number);
  const guess=new Date(Date.UTC(y,m-1,d,h,min,s));
  return new Date(guess.getTime()-offsetMs(guess,timeZone)).toISOString();
}
async function studioTimeZone(supabase: any, studioId: string) {
  const { data } = await supabase.from("studio_settings").select("timezone").eq("studio_id",studioId).maybeSingle();
  return data?.timezone || DEFAULT_TZ;
}
const reasons = new Set(["lunch","practice","meeting","travel","personal","other"]);

export async function createInstructorScheduleBlockAction(formData: FormData) {
  const { supabase, studioId, user } = await requireAppointmentCreateAccess();
  const instructorId=getString(formData,"instructorId");
  const roomId=getString(formData,"roomId") || null;
  const reason=getString(formData,"reason") || "other";
  const title=getString(formData,"title");
  const notes=getString(formData,"notes") || null;
  const startsAtLocal=getString(formData,"startsAt");
  const endsAtLocal=getString(formData,"endsAt");
  const isRecurring=getBoolean(formData,"isRecurring");
  const recurrenceCount=Math.max(1,Math.min(52,Number(getString(formData,"recurrenceCount") || "1")));
  if (!instructorId || !title || !reasons.has(reason)) redirect("/app/schedule/blocks/new?error=missing_fields");
  const tz=await studioTimeZone(supabase,studioId);
  const startsAt=localToUtc(startsAtLocal,tz);
  const endsAt=localToUtc(endsAtLocal,tz);
  if (!startsAt || !endsAt || new Date(endsAt)<=new Date(startsAt)) redirect("/app/schedule/blocks/new?error=invalid_time");

  const startDate=startsAtLocal.slice(0,10);
  const dates=isRecurring ? generateWeeklyOccurrenceDates({ startDate, occurrenceCount: recurrenceCount }) : [startDate];
  const duration=new Date(endsAt).getTime()-new Date(startsAt).getTime();
  const localTime=startsAtLocal.slice(11,16);
  const seriesId=isRecurring ? crypto.randomUUID() : null;
  const rows=[] as Array<Record<string,unknown>>;
  for (const date of dates) {
    const occurrenceStart=localToUtc(`${date}T${localTime}`,tz)!;
    const occurrenceEnd=new Date(new Date(occurrenceStart).getTime()+duration).toISOString();
    const conflict=await detectAppointmentConflicts({ studioId, startsAt:occurrenceStart, endsAt:occurrenceEnd, instructorId, roomId });
    if (conflict.hasConflict) redirect(`/app/schedule/blocks/new?error=${encodeURIComponent(conflict.message || "conflict")}`);
    rows.push({ studio_id:studioId, instructor_id:instructorId, room_id:roomId, reason, title, notes, starts_at:occurrenceStart, ends_at:occurrenceEnd, recurrence_series_id:seriesId, recurrence_frequency:isRecurring?"weekly":null, recurrence_count:isRecurring?dates.length:null, recurrence_ends_on:isRecurring?dates[dates.length-1]:null, created_by:user.id });
  }
  const { error }=await supabase.from("instructor_schedule_blocks").insert(rows);
  if (error) redirect(`/app/schedule/blocks/new?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/schedule"); revalidatePath("/app/schedule/calendar");
  redirect(`/app/schedule/calendar?view=week&date=${startDate}&success=block_created`);
}

export async function updateInstructorScheduleBlockAction(formData: FormData) {
  const { supabase, studioId } = await requireAppointmentEditAccess();
  const id=getString(formData,"blockId");
  const instructorId=getString(formData,"instructorId");
  const roomId=getString(formData,"roomId") || null;
  const reason=getString(formData,"reason") || "other";
  const title=getString(formData,"title");
  const notes=getString(formData,"notes") || null;
  const tz=await studioTimeZone(supabase,studioId);
  const startsAt=localToUtc(getString(formData,"startsAt"),tz);
  const endsAt=localToUtc(getString(formData,"endsAt"),tz);
  if (!id || !instructorId || !title || !startsAt || !endsAt || new Date(endsAt)<=new Date(startsAt)) redirect(`/app/schedule/blocks/${id}/edit?error=invalid_fields`);
  const conflict=await detectAppointmentConflicts({ studioId, startsAt, endsAt, instructorId, roomId, excludeScheduleBlockId:id });
  if (conflict.hasConflict) redirect(`/app/schedule/blocks/${id}/edit?error=${encodeURIComponent(conflict.message || "conflict")}`);
  const { error }=await supabase.from("instructor_schedule_blocks").update({ instructor_id:instructorId, room_id:roomId, reason, title, notes, starts_at:startsAt, ends_at:endsAt, updated_at:new Date().toISOString() }).eq("id",id).eq("studio_id",studioId);
  if (error) redirect(`/app/schedule/blocks/${id}/edit?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/schedule/calendar"); redirect("/app/schedule/calendar?success=block_updated");
}

export async function deleteInstructorScheduleBlockAction(formData: FormData) {
  const { supabase, studioId } = await requireAppointmentEditAccess();
  const id=getString(formData,"blockId");
  const { error }=await supabase.from("instructor_schedule_blocks").delete().eq("id",id).eq("studio_id",studioId);
  if (error) redirect(`/app/schedule/blocks/${id}/edit?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/app/schedule/calendar"); redirect("/app/schedule/calendar?success=block_deleted");
}
