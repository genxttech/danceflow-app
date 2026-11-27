import { describe, expect, it } from "vitest";
import { LUMI_MAX_CONTEXT_CHARS, orderSyllabusProgress, serializeLumiContext } from "../context";

const note = "n".repeat(2000);

describe("LUMI context bounding", () => {
  it("leaves a context that fits unchanged", () => {
    const context = { task: "weekly_plan", goals: [{ title: "Frame" }] };
    expect(serializeLumiContext(context)).toBe(JSON.stringify(context));
  });

  it("trims an established dancer's large history instead of exceeding the cap", () => {
    const context = {
      task: "weekly_plan",
      goals: Array.from({ length: 8 }, () => ({ title: "Goal", notes: note })),
      visibleLessonRecaps: Array.from({ length: 6 }, () => ({ summary: note, homework: note, next_focus: note })),
      visibleSyllabusProgress: Array.from({ length: 8 }, () => ({
        client_syllabus_progress: Array.from({ length: 400 }, (_, i) => ({ status: "in_progress", notes: note, i })),
      })),
    };
    const serialized = serializeLumiContext(context);
    expect(serialized.length).toBeLessThanOrEqual(LUMI_MAX_CONTEXT_CHARS);
    const parsed = JSON.parse(serialized);
    expect(parsed.task).toBe("weekly_plan");
    expect(parsed.visibleSyllabusProgress[0].client_syllabus_progress[0].i).toBe(0);
  });

  it("keeps current work first so it survives trimming, whatever order the database returns", () => {
    const rows = [
      { status: "mastered", updated_at: "2026-11-01" },
      { status: "practicing", updated_at: "2026-01-01" },
      { status: "not_started", updated_at: null },
      { status: "practicing", updated_at: "2026-10-01" },
      { status: "introduced", updated_at: "2026-02-01" },
    ];
    expect(orderSyllabusProgress(rows).map((row) => `${row.status}:${row.updated_at}`)).toEqual([
      "practicing:2026-10-01",
      "practicing:2026-01-01",
      "introduced:2026-02-01",
      "not_started:null",
      "mastered:2026-11-01",
    ]);
  });

  it("shortens the syllabus history before recaps and says the history was shortened", () => {
    const homework = "h".repeat(1500);
    const context = {
      visibleLessonRecaps: [{ homework }],
      visibleSyllabusProgress: [{ client_syllabus_progress: Array.from({ length: 600 }, () => ({ notes: "n".repeat(300) })) }],
    };
    const parsed = JSON.parse(serializeLumiContext(context));
    expect(parsed.historyShortened).toBe(true);
    expect(parsed.visibleLessonRecaps[0].homework).toBe(homework);
    expect(parsed.visibleSyllabusProgress[0].client_syllabus_progress.length).toBeLessThan(600);
  });

  it("does not cut current syllabus work when the recaps are what is large", () => {
    const context = {
      visibleLessonRecaps: Array.from({ length: 6 }, () => ({ summary: "s".repeat(8000), homework: "h".repeat(8000) })),
      visibleSyllabusProgress: Array.from({ length: 8 }, () => ({
        client_syllabus_progress: Array.from({ length: 10 }, (_, i) => ({ status: "practicing", i })),
      })),
    };
    const serialized = serializeLumiContext(context);
    expect(serialized.length).toBeLessThanOrEqual(LUMI_MAX_CONTEXT_CHARS);
    const parsed = JSON.parse(serialized);
    expect(parsed.visibleSyllabusProgress).toHaveLength(8);
    expect(parsed.visibleSyllabusProgress[7].client_syllabus_progress).toHaveLength(10);
    expect(parsed.visibleLessonRecaps).toHaveLength(6);
  });

  it("never exceeds the cap, even for a pathological shape", () => {
    const wide = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, "value"]));
    expect(serializeLumiContext(wide, 1000).length).toBeLessThanOrEqual(1000);
  });
});
