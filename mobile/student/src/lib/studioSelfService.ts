import { danceflowApiFetch } from "@/lib/danceflowApi";

export type StudioSelfServiceInstructor = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  name: string;
};

export type StudioSelfServiceSlot = {
  date: string;
  startTime: string;
  endTime: string;
  startsAt: string;
  endsAt: string;
  instructorId: string | null;
  roomId: string | null;
};

export type StudioSelfServiceDecision = {
  action: "book" | "reschedule" | "cancel";
  allowed: boolean;
  mode: "request_only" | "approval_required" | "instant" | null;
  reason: string | null;
};

export type StudioSelfServiceSlotsResult = {
  studio: { id: string; slug: string };
  bookingDecision: StudioSelfServiceDecision;
  instructors: StudioSelfServiceInstructor[];
  slots: StudioSelfServiceSlot[];
};

export type SubmitStudioSelfServiceRequestResult = {
  actionRequest: {
    id: string;
    status: string;
  };
  bookingDecision: StudioSelfServiceDecision;
};

export function loadStudioSelfServiceSlots(params: {
  studioSlug: string;
  instructorId?: string | null;
}) {
  return danceflowApiFetch<StudioSelfServiceSlotsResult>("/api/student/self-service/slots", {
    params: {
      action: "book",
      instructorId: params.instructorId,
      lessonType: "private_lesson",
      studioSlug: params.studioSlug
    }
  });
}

export function submitStudioSelfServiceRequest(params: {
  studioSlug: string;
  instructorId: string;
  slot: StudioSelfServiceSlot;
}) {
  return danceflowApiFetch<SubmitStudioSelfServiceRequestResult>(
    "/api/student/self-service/actions",
    {
      body: JSON.stringify({
        actionType: "book",
        endsAt: params.slot.endsAt,
        instructorId: params.instructorId,
        lessonType: "private_lesson",
        roomId: params.slot.roomId,
        startsAt: params.slot.startsAt,
        studioSlug: params.studioSlug
      }),
      method: "POST"
    }
  );
}
