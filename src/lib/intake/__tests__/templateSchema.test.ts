import { describe, expect, it } from "vitest";
import {
  CHOICE_TYPES,
  FIELD_TYPES,
  draftToSchema,
  estimateMaxAnswerBytes,
  moveItem,
  newField,
  newSection,
  optionsFromLines,
  rekeyFromLabel,
  schemaToDraft,
  slugKey,
  starterDraft,
  validateDraft,
  type Draft,
} from "@/lib/intake/templateSchema";

const messages = (draft: Draft) => validateDraft(draft).map((i) => i.message);

describe("starter draft", () => {
  it("is valid, uses only supported types and has no health or medical questions", () => {
    const draft = starterDraft();
    expect(validateDraft(draft)).toEqual([]);
    const types = new Set(draft.sections.flatMap((s) => s.fields.map((f) => f.type)));
    for (const t of types) expect(FIELD_TYPES).toContain(t);
    const text = JSON.stringify(draft).toLowerCase();
    for (const word of ["health", "medical", "injur", "medication", "allerg", "pregnan"]) expect(text).not.toContain(word);
  });
  it("has an acknowledgment with consent scope", () => {
    const schema = draftToSchema(starterDraft()) as { sections: { fields: { type: string; subject_scope: string }[] }[] };
    const ack = schema.sections.flatMap((s) => s.fields).find((f) => f.type === "acknowledgment");
    expect(ack?.subject_scope).toBe("consent");
  });
});

describe("draftToSchema / schemaToDraft", () => {
  it("round-trips keys, types, options and visibility", () => {
    const draft = starterDraft();
    const again = schemaToDraft(draft.name, draftToSchema(draft));
    expect(draftToSchema(again)).toEqual(draftToSchema(draft));
  });
  it("derives subject scope: acknowledgment is consent, guardian sections about_guardian, others about_student", () => {
    const draft: Draft = { name: "x", sections: [] };
    const guardian = newSection(draft, "Parent", "guardian");
    draft.sections.push(guardian);
    guardian.fields.push(newField(draft, "short_text", "Parent phone"), newField(draft, "acknowledgment", "I agree"));
    const student = newSection(draft, "Student", "student");
    draft.sections.push(student);
    student.fields.push(newField(draft, "short_text", "Goal"));
    const scopes = (draftToSchema(draft) as { sections: { fields: { subject_scope: string }[] }[] }).sections.map((s) => s.fields.map((f) => f.subject_scope));
    expect(scopes).toEqual([["about_guardian", "consent"], ["about_student"]]);
  });
  it("tolerates malformed stored schemas without throwing", () => {
    expect(schemaToDraft("n", null).sections).toEqual([]);
    expect(schemaToDraft("n", { sections: [{ fields: [{ type: "weird" }] }] }).sections[0].fields[0].type).toBe("short_text");
  });
});

describe("validateDraft", () => {
  it("requires a name, a section, section titles, wording and questions", () => {
    expect(messages({ name: " ", sections: [] })).toEqual(expect.arrayContaining(["Give the template a name.", "Add at least one section."]));
    const d = starterDraft();
    d.sections[0].title = "";
    d.sections[0].fields[0].label = " ";
    const m = messages(d).join(" | ");
    expect(m).toContain("needs a title");
    expect(m).toContain("needs wording");
    const empty = starterDraft();
    empty.sections[1].fields = [];
    expect(messages(empty).join(" ")).toContain("needs at least one question");
  });
  it("requires choices for choice types and rejects blank or duplicate choices", () => {
    for (const type of CHOICE_TYPES) {
      const d = starterDraft();
      const f = newField(d, type, "Pick");
      f.options = [];
      d.sections[0].fields.push(f);
      expect(messages(d).join(" ")).toContain("needs 1–50 choices");
      f.options = [{ key: "a", label: "" }];
      expect(messages(d).join(" ")).toContain("needs wording");
      f.options = [{ key: "a", label: "One" }, { key: "a", label: "Two" }];
      expect(messages(d).join(" ")).toContain("too similar");
    }
  });
  it("rejects duplicate internal keys and over-long wording", () => {
    const d = starterDraft();
    d.sections[0].fields[1].key = d.sections[0].fields[0].key;
    expect(messages(d).join(" ")).toContain("share the same internal key");
    const e = starterDraft();
    e.sections[0].fields[0].label = "x".repeat(501);
    expect(messages(e).join(" ")).toContain("too long");
  });
  it("enforces the 200-question and answer-size limits like the database", () => {
    const many: Draft = { name: "many", sections: [] };
    const s = newSection(many, "S", "student");
    many.sections.push(s);
    for (let i = 0; i < 201; i += 1) {
      const f = newField(many, "short_text", `Q ${i}`);
      f.label = `Q ${i}`;
      f.key = `q_${i}`;
      s.fields.push(f);
    }
    expect(messages(many).join(" ")).toContain("limited to 200 questions");
    const big: Draft = { name: "big", sections: [] };
    const t = newSection(big, "S", "student");
    big.sections.push(t);
    for (let i = 0; i < 14; i += 1) {
      const f = newField(big, "long_text", `Long ${i}`);
      f.label = `Long ${i}`;
      f.key = `long_${i}`;
      t.fields.push(f);
    }
    expect(estimateMaxAnswerBytes(big)).toBeGreaterThan(262144);
    expect(messages(big).join(" ")).toContain("too large");
  });
});

describe("keys are stable", () => {
  it("a new question follows its wording until it is saved, then never changes", () => {
    const d = starterDraft();
    const f = newField(d, "short_text");
    d.sections[0].fields.push(f);
    expect(rekeyFromLabel(d, f, "Favorite song")).toBe("favorite_song");
    const saved = { ...f, key: "favorite_song", autoKey: false };
    expect(rekeyFromLabel(d, saved, "Totally different wording")).toBe("favorite_song");
  });
  it("slugKey makes valid unique keys", () => {
    expect(slugKey("Your goal?!", [])).toBe("your_goal");
    expect(slugKey("Goal", ["goal"])).toBe("goal_2");
    expect(slugKey("123 numbers", [])).toMatch(/^[a-z]/);
    expect(slugKey("", [])).toBe("question");
  });
  it("optionsFromLines keeps the key of an unchanged choice and keys new ones uniquely", () => {
    const field = { options: [{ key: "never", label: "Never" }, { key: "some", label: "A little" }] };
    expect(optionsFromLines(field, "Never\nSome\n\nSome")).toEqual([
      { key: "never", label: "Never" },
      { key: "some", label: "Some" },
      { key: "some_2", label: "Some" },
    ]);
  });
  it("moveItem swaps within bounds only", () => {
    expect(moveItem([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(moveItem([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
  });
});
