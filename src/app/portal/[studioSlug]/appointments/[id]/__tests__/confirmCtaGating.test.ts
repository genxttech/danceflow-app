import { describe, expect, it } from "vitest";
import {
  canShowConfirmPrompt,
  canShowConfirmedBadge,
} from "@/app/portal/[studioSlug]/appointments/[id]/page";

/**
 * GC-1.3B: appointments.status/confirmed_at is class-level lifecycle only
 * for a group_class row -- there is no per-student confirmation concept for
 * a shared class in this slice, and the underlying write
 * (confirmOwnedAppointment) requires a non-null client_id, which a
 * real-roster class never has. The Confirm CTA must be hidden for a class
 * regardless of status; lesson behavior must be unchanged.
 */
describe("canShowConfirmPrompt", () => {
  it("hides the confirm prompt for a group_class, even when scheduled and in the future", () => {
    expect(
      canShowConfirmPrompt({
        appointmentType: "group_class",
        status: "scheduled",
        startsAtMs: Date.now() + 1000 * 60 * 60,
        nowMs: Date.now(),
      }),
    ).toBe(false);
  });

  it("shows the confirm prompt for a future, scheduled lesson (unchanged)", () => {
    expect(
      canShowConfirmPrompt({
        appointmentType: "private_lesson",
        status: "scheduled",
        startsAtMs: Date.now() + 1000 * 60 * 60,
        nowMs: Date.now(),
      }),
    ).toBe(true);
  });

  it("still respects status/time exclusions for a lesson (unchanged)", () => {
    expect(
      canShowConfirmPrompt({
        appointmentType: "private_lesson",
        status: "attended",
        startsAtMs: Date.now() + 1000 * 60 * 60,
        nowMs: Date.now(),
      }),
    ).toBe(false);
    expect(
      canShowConfirmPrompt({
        appointmentType: "private_lesson",
        status: "scheduled",
        startsAtMs: Date.now() - 1000 * 60 * 60,
        nowMs: Date.now(),
      }),
    ).toBe(false);
  });
});

describe("canShowConfirmedBadge", () => {
  it("hides the confirmed badge for a group_class", () => {
    expect(
      canShowConfirmedBadge({ appointmentType: "group_class", status: "confirmed" }),
    ).toBe(false);
  });

  it("shows the confirmed badge for a confirmed lesson (unchanged)", () => {
    expect(
      canShowConfirmedBadge({ appointmentType: "private_lesson", status: "confirmed" }),
    ).toBe(true);
  });
});
