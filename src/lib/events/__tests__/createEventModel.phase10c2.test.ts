import { describe, expect, it } from "vitest";
import {
  EVENT_TYPE_CATEGORIES,
  EVENT_TYPE_OPTIONS,
  categoryForEventType,
  defaultTypeForCategory,
  fieldForEventError,
  intentFromFields,
  resolveVisibilityFields,
  type EventAudience,
} from "@/lib/events/createEventModel";

/** 10C.2: the Create Event model only regroups / maps existing stored values. */

const STORED_TYPES = ["group_class", "social_dance", "workshop", "party", "competition", "showcase", "festival", "special_event", "other"];

describe("event type grouping", () => {
  it("still supports every stored event type the form offered before", () => {
    expect(EVENT_TYPE_OPTIONS.map((option) => option.value).sort()).toEqual([...STORED_TYPES].sort());
  });

  it("places each stored type in exactly one top-level category and invents none", () => {
    const grouped = EVENT_TYPE_CATEGORIES.flatMap((category) => category.types.map((type) => type.value));
    expect([...grouped].sort()).toEqual([...STORED_TYPES].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it("has fewer top-level choices than stored types, with subtypes only where behavior is shared", () => {
    expect(EVENT_TYPE_CATEGORIES.length).toBeLessThan(STORED_TYPES.length);
    const withSubtypes = Object.fromEntries(
      EVENT_TYPE_CATEGORIES.filter((c) => c.types.length > 1).map((c) => [c.key, c.types.map((t) => t.value)]),
    );
    expect(withSubtypes).toEqual({
      social: ["social_dance", "party"],
      workshop: ["workshop", "festival"],
      other: ["special_event", "other"],
    });
  });

  it("maps every stored type back to its category and picks the first subtype by default", () => {
    expect(categoryForEventType("party").key).toBe("social");
    expect(categoryForEventType("festival").key).toBe("workshop");
    expect(categoryForEventType("competition").key).toBe("competition");
    expect(categoryForEventType("showcase").key).toBe("showcase");
    expect(categoryForEventType("group_class").key).toBe("class");
    expect(categoryForEventType("something_new").key).toBe("other");
    expect(defaultTypeForCategory("social")).toBe("social_dance");
    expect(defaultTypeForCategory("competition")).toBe("competition");
    for (const category of EVENT_TYPE_CATEGORIES) {
      expect(categoryForEventType(defaultTypeForCategory(category.key)).key).toBe(category.key);
    }
  });
});

describe("visibility intent -> stored fields", () => {
  const resolve = (audience: EventAudience, discovery: boolean, publishNow: boolean, registration = false) =>
    resolveVisibilityFields({ audience, discovery, publishNow }, registration);

  it("maps the audience to the stored visibility values the server validates", () => {
    expect(resolve("public", false, true).visibility).toBe("public");
    expect(resolve("link", false, true).visibility).toBe("unlisted");
    expect(resolve("studio", false, true).visibility).toBe("private");
  });

  it("stores Discovery only for the public audience", () => {
    expect(resolve("public", true, true).publicDirectoryEnabled).toBe(true);
    expect(resolve("public", false, true).publicDirectoryEnabled).toBe(false);
    expect(resolve("link", true, true).publicDirectoryEnabled).toBe(false);
    expect(resolve("studio", true, true).publicDirectoryEnabled).toBe(false);
  });

  it("keeps draft as a lifecycle status independent of the audience", () => {
    for (const audience of ["public", "link", "studio"] as const) {
      expect(resolve(audience, false, false).status).toBe("draft");
    }
  });

  it("publishing sets open when registration is on, otherwise published", () => {
    expect(resolve("public", true, true, true).status).toBe("open");
    expect(resolve("link", false, true, false).status).toBe("published");
  });

  it("matches the legacy publishing modes", () => {
    expect(resolve("public", true, true, true)).toEqual({ status: "open", visibility: "public", publicDirectoryEnabled: true });
    expect(resolve("link", false, true)).toEqual({ status: "published", visibility: "unlisted", publicDirectoryEnabled: false });
    expect(resolve("studio", false, false)).toEqual({ status: "draft", visibility: "private", publicDirectoryEnabled: false });
  });

  it("round-trips stored fields into the same intent; the create-page default stays a hidden public draft", () => {
    for (const audience of ["public", "link", "studio"] as const) {
      for (const discovery of [true, false]) {
        for (const publishNow of [true, false]) {
          const intent = { audience, discovery: audience === "public" && discovery, publishNow };
          expect(intentFromFields(resolveVisibilityFields(intent, true))).toEqual(intent);
        }
      }
    }
    // /app/events/new seeds visibility "public", status draft, Discovery off.
    expect(intentFromFields({ status: "draft", visibility: "public", publicDirectoryEnabled: false })).toEqual({
      audience: "public",
      discovery: false,
      publishNow: false,
    });
  });
});

describe("inline validation mapping", () => {
  it("maps the create action's messages to the field they belong to", () => {
    expect(fieldForEventError("Event name is required.")).toBe("name");
    expect(fieldForEventError("That event URL is already taken. Please choose a different event slug.")).toBe("slug");
    expect(fieldForEventError("Start date is required.")).toBe("dates");
    expect(fieldForEventError("End date is required.")).toBe("dates");
    expect(fieldForEventError("End date cannot be before start date.")).toBe("dates");
    expect(fieldForEventError("Selected organizer is invalid.")).toBe("host");
    expect(fieldForEventError("Capacity cannot be negative.")).toBe("capacity");
    expect(fieldForEventError("Registration close must be after registration open.")).toBe("registration");
    expect(fieldForEventError("Could not create event: boom")).toBeNull();
    expect(fieldForEventError("")).toBeNull();
  });
});
