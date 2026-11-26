import { describe, expect, it } from "vitest";
import { LUMI_MAX_CONTEXT_CHARS, serializeLumiContext } from "../context";

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

  it("never exceeds the cap, even for a pathological shape", () => {
    const wide = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, "value"]));
    expect(serializeLumiContext(wide, 1000).length).toBeLessThanOrEqual(1000);
  });
});
