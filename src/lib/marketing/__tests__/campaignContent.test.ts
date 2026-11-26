import { describe, expect, it } from "vitest";
import {
  ORGANIZER_CREATE_AUDIENCE_TYPES,
  ORGANIZER_CREATE_EVENT_REQUIRED_AUDIENCES,
  ORGANIZER_UPDATE_AUDIENCE_TYPES,
  ORGANIZER_UPDATE_EVENT_REQUIRED_AUDIENCES,
  STUDIO_AUDIENCE_TYPES,
  hasOrganizerRequiredContent,
  isStudioSpecificEventAudience,
  normalizeCampaignCtaUrl,
  readTrimmedFormString,
  studioCampaignContentIssue,
} from "../campaignContent";

describe("campaignContent (M-2a shared module)", () => {
  it("readTrimmedFormString trims strings and ignores missing or non-string values", () => {
    const fd = new FormData();
    fd.set("a", "  x ");
    fd.set("f", new Blob(["x"]), "f.txt");
    expect(readTrimmedFormString(fd, "a")).toBe("x");
    expect(readTrimmedFormString(fd, "missing")).toBe("");
    expect(readTrimmedFormString(fd, "f")).toBe("");
  });

  it.each([
    ["", ""],
    ["   ", ""],
    ["example.com", "https://example.com/"],
    ["http://example.com", "http://example.com/"],
    ["HTTPS://Example.com/x?y=1", "https://example.com/x?y=1"],
    ["javascript:alert(1)", ""],
    ["data:text/html,hi", ""],
    ["http://", ""],
  ])("strict normalizer: %j -> %j", (input, expected) => {
    expect(normalizeCampaignCtaUrl(input)).toBe(expected);
  });

  it("studio content issues come in subject, body, CTA order", () => {
    expect(studioCampaignContentIssue({ subject: "", bodyText: "", rawCtaUrl: "x", ctaUrl: "" })).toBe("missing_subject");
    expect(studioCampaignContentIssue({ subject: "s", bodyText: "", rawCtaUrl: "x", ctaUrl: "" })).toBe("missing_body");
    expect(studioCampaignContentIssue({ subject: "s", bodyText: "b", rawCtaUrl: "x", ctaUrl: "" })).toBe("invalid_cta_url");
    expect(studioCampaignContentIssue({ subject: "s", bodyText: "b", rawCtaUrl: "", ctaUrl: "" })).toBeNull();
    expect(studioCampaignContentIssue({ subject: "s", bodyText: "b", rawCtaUrl: "a.test", ctaUrl: "https://a.test/" })).toBeNull();
  });

  it("organizer required content needs name, subject and body", () => {
    expect(hasOrganizerRequiredContent({ name: "n", subject: "s", bodyText: "b" })).toBe(true);
    expect(hasOrganizerRequiredContent({ name: "", subject: "s", bodyText: "b" })).toBe(false);
    expect(hasOrganizerRequiredContent({ name: "n", subject: "", bodyText: "b" })).toBe(false);
    expect(hasOrganizerRequiredContent({ name: "n", subject: "s", bodyText: "" })).toBe(false);
  });

  it("audience sets keep their existing members", () => {
    expect([...STUDIO_AUDIENCE_TYPES].sort()).toEqual(
      [
        "manual",
        "all_active_clients",
        "new_leads",
        "inactive_clients",
        "event_attendees",
        "specific_event_registrants",
        "specific_event_checked_in",
        "clients_no_upcoming_lesson",
        "low_package_credits",
      ].sort(),
    );
    expect(isStudioSpecificEventAudience("specific_event_registrants")).toBe(true);
    expect(isStudioSpecificEventAudience("specific_event_checked_in")).toBe(true);
    expect(isStudioSpecificEventAudience("event_attendees")).toBe(false);

    expect(ORGANIZER_CREATE_AUDIENCE_TYPES.size).toBe(8);
    expect(ORGANIZER_UPDATE_AUDIENCE_TYPES.size).toBe(9);
    expect(ORGANIZER_CREATE_AUDIENCE_TYPES.has("specific_event_registered_not_checked_in")).toBe(false);
    expect(ORGANIZER_UPDATE_AUDIENCE_TYPES.has("specific_event_registered_not_checked_in")).toBe(true);
    expect(ORGANIZER_CREATE_EVENT_REQUIRED_AUDIENCES.size).toBe(6);
    expect(ORGANIZER_UPDATE_EVENT_REQUIRED_AUDIENCES.size).toBe(7);
    expect(ORGANIZER_UPDATE_EVENT_REQUIRED_AUDIENCES.has("specific_event_registered_not_checked_in")).toBe(true);
    for (const a of ["all_organizer_contacts", "paid_registration_contacts"]) {
      expect(ORGANIZER_UPDATE_AUDIENCE_TYPES.has(a)).toBe(true);
      expect(ORGANIZER_UPDATE_EVENT_REQUIRED_AUDIENCES.has(a)).toBe(false);
    }
  });
});
