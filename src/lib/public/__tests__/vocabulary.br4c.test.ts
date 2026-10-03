import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * BR-4C: the stale product names are gone from user-facing surfaces, and each replacement says
 * what the surface actually is. Platform-admin screens, source comments, route names and other
 * technical identifiers are intentionally not covered (see the retained-terms test).
 */

const ROOT = process.cwd();
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

describe("Discover (was 'DanceFlow Discovery')", () => {
  it.each(["studios", "events", "partners", "jobs"])("discover/%s uses the visible label 'Discover'", (name) => {
    const source = read("src", "app", "discover", name, "page.tsx");
    expect(source).not.toContain("DanceFlow Discovery");
    expect(source).toContain("Discover\n");
  });

  it("pricing bullets and the event publishing note use 'Discover'", () => {
    const plans = read("src", "lib", "billing", "plans.ts");
    expect(plans).not.toContain("DanceFlow Discovery");
    expect(plans.match(/Basic public event listings in Discover/g)).toHaveLength(2);
    expect(read("src", "app", "app", "events", "[id]", "page.tsx")).toContain("publish this event to Discover");
  });
});

describe("Organizer Suite (was 'DanceFlow Organizer Workspace')", () => {
  const files = [
    ["src", "app", "app", "organizers", "page.tsx"],
    ["src", "app", "app", "organizers", "OrganizerForm.tsx"],
    ["src", "app", "app", "organizers", "new", "page.tsx"],
    ["src", "app", "app", "events", "page.tsx"],
    ["src", "app", "app", "events", "new", "page.tsx"],
    ["src", "app", "app", "events", "[id]", "edit", "page.tsx"],
    ["src", "app", "app", "notifications", "page.tsx"],
    ["src", "app", "app", "settings", "billing", "page.tsx"],
  ];

  it.each(files.map((parts) => [parts.slice(2).join("/"), parts]))("%s no longer shows the old product name", (_name, parts) => {
    const source = read(...(parts as string[]));
    expect(source).not.toContain("DanceFlow Organizer Workspace");
    expect(source).not.toContain("Go to Organizer Workspace");
    expect(source).toContain("Organizer Suite");
  });

  it("the studio side uses natural wording, not a product brand", () => {
    const notifications = read("src", "app", "app", "notifications", "page.tsx");
    expect(notifications).not.toContain("DanceFlow Studio Workspace");
    expect(notifications).toContain('"Studio workspace"');
    expect(read("src", "app", "app", "page.tsx")).not.toContain("DanceFlow Workspace");
  });

  it("the public knowledgebase article title follows (slug unchanged so links keep working)", () => {
    const articles = read("src", "content", "knowledgebase", "articles.ts");
    expect(articles).toContain('slug: "getting-started-with-organizer-workspace"');
    expect(articles).toContain('title: "Getting Started with Organizer Suite"');
    expect(articles).not.toContain("Getting Started with Your Organizer Workspace");
  });
});

describe("Student Portal (the client/dancer-facing portal a studio provides)", () => {
  it("login names the portal the dancer is signing in to, and the studio's staff workspace is not renamed", () => {
    const login = read("src", "app", "(auth)", "login", "page.tsx");
    expect(login).toContain('? "Student Portal"');
    expect(login).not.toContain("Studio Portal");
    expect(login).not.toMatch(/studio portal/);
  });

  it("the invite page, recap page and account area use the same term for the same thing", () => {
    for (const parts of [
      ["src", "app", "studio-invites", "[token]", "page.tsx"],
      ["src", "app", "recaps", "[token]", "page.tsx"],
      ["src", "app", "account", "page.tsx"],
    ]) {
      const source = read(...parts);
      expect(source, parts.join("/")).not.toContain("Studio Portal");
      expect(source, parts.join("/")).not.toMatch(/\bstudio portals?\b/);
    }
    expect(read("src", "app", "studio-invites", "[token]", "page.tsx")).toContain("Open Student Portal");
    expect(read("src", "app", "account", "page.tsx")).toContain('label="Student Portals"');
    expect(read("src", "app", "account", "page.tsx")).toContain('eyebrow="My Student Portals"');
  });

  it("the independent-instructor sidebar link is the student portal of a studio they are a client of", () => {
    const layout = read("src", "app", "app", "layout.tsx");
    expect(layout).toContain('label: "My Student Portal"');
    expect(layout).not.toContain("My Studio Portal");
  });

  it("no staff or admin workspace is labelled 'Student Portal'", () => {
    for (const parts of [
      ["src", "app", "app", "page.tsx"],
      ["src", "app", "app", "organizers", "page.tsx"],
      ["src", "app", "platform", "page.tsx"],
    ]) {
      expect(read(...parts), parts.join("/")).not.toContain("Student Portal");
    }
  });
});

describe("deliberately retained terms", () => {
  it("platform-admin screens keep their internal labels (not user-facing product branding)", () => {
    expect(read("src", "app", "platform", "organizers", "page.tsx")).toContain("Organizer Workspace");
    expect(read("src", "app", "platform", "studios", "[id]", "page.tsx")).toContain("Organizer Workspace");
  });

  it("the host-studio portal for floor rentals is a different concept and keeps its wording", () => {
    expect(read("src", "app", "app", "page.tsx")).toContain("Host studio portals are available");
  });
});

describe("privacy policy covers the limited attribution cookie", () => {
  it("states the first-party campaign cookie, its lifetime and that it holds no personal information", () => {
    const privacy = read("src", "app", "privacy", "page.tsx").replace(/\s+/g, " ");
    expect(privacy).toContain("campaign or QR link");
    expect(privacy).toContain("first-party cookie for up to 30 days");
    expect(privacy).toContain("It contains no personal information");
  });
});
