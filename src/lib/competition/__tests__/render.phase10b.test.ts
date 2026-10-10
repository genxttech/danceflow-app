import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  usePathname: () => "/app/events/e1/competition/divisions",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  redirect: vi.fn(),
  notFound: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown } & Record<string, unknown>) => createElement("a", { href, ...rest }, children as never),
}));
vi.mock("@/app/app/events/[id]/competition/simpleActions", () => ({
  createCompetitionDraftAction: vi.fn(),
  publishCompetitionAction: vi.fn(),
  updateDivisionAction: vi.fn(),
  addDivisionAction: vi.fn(),
  removeDivisionAction: vi.fn(),
}));

import { STUDIO_CUSTOM_V2_DEFAULTS } from "@/lib/competition/setup/studioCustomV2";
import CompetitionNav from "@/app/app/events/[id]/competition/CompetitionNav";
import PublishForm from "@/app/app/events/[id]/competition/PublishForm";
import CompetitionSetupWizard from "@/app/app/events/[id]/competition/new/CompetitionSetupWizard";
import DivisionsBoard from "@/app/app/events/[id]/competition/divisions/DivisionsBoard";

/** Server-render smoke tests: the client components mount without runtime errors and show the right first screen. */

describe("workspace components render", () => {
  it("renders the navigation with disabled future areas and a highlighted current section", () => {
    const html = renderToStaticMarkup(createElement(CompetitionNav, { eventId: "e1" }));
    expect(html).toContain("Overview");
    expect(html).toContain('aria-current="page"');
    expect(html.match(/aria-disabled="true"/g)?.length).toBe(4);
    for (const label of ["Officials", "Scoring", "Results", "Awards"]) expect(html).toContain(label);
    expect(html).not.toMatch(/href="[^"]*(officials|scoring|results|awards)/);
    expect(html).toContain('href="/app/events/e1/competition/divisions"');
  });

  it("renders the first setup step: the event basics, the three purposes and no engine words (10C.5)", () => {
    const html = renderToStaticMarkup(
      createElement(CompetitionSetupWizard, {
        eventId: "e1",
        event: { name: "Spring Showcase", dates: "Mar 6, 2027", times: "6:00 PM", venue: "Main Studio", existingWindow: null },
        profile: { key: "studio_simple", version: 2 },
        defaults: STUDIO_CUSTOM_V2_DEFAULTS,
        initialRegistration: { opens: "", closes: "", accountRequired: true },
        requestKey: "request-key-0001",
      }),
    );
    expect(html).toContain("What are you creating?");
    expect(html).toContain("Spring Showcase");
    expect(html).toContain("Mar 6, 2027");
    expect(html).toContain("Edit event details");
    for (const label of ["Competition", "Showcase / Performance", "Competition + Showcase"]) expect(html).toContain(label);
    expect(html).toContain("Advanced settings");
    expect(html).toContain("1. Purpose");
    expect(html).toContain("Review");
    expect(html).not.toContain("Sanction</button>");
    expect(html).toContain("Continue");
    expect(html).not.toContain("Create Competition Draft");
    expect(html).not.toMatch(/ordinal_majority|proficiency_rating|callback_tally/);
  });

  it("renders the publish control with one clear action", () => {
    const html = renderToStaticMarkup(createElement(PublishForm, { eventId: "e1", programId: "p1", label: "Publish competition" }));
    expect(html).toContain("Publish competition");
    expect(html.match(/<button/g)?.length).toBe(1);
    expect(html).toContain('name="programId" value="p1"');
  });

  it("renders the divisions board with categories, divisions and per-category add actions (panel closed)", () => {
    const html = renderToStaticMarkup(
      createElement(DivisionsBoard, {
        eventId: "e1",
        categories: [
          { id: "c1", name: "ProAm", editable: true, divisions: [{ id: "d1", name: "Bronze", skillLabel: "Bronze", ageLabel: null, rounds: ["Final"], dances: 2, entries: 0 }] },
          { id: "c2", name: "Solo", editable: true, divisions: [] },
          { id: "c3", name: "Team", editable: false, divisions: [{ id: "d3", name: "Open", skillLabel: null, ageLabel: null, rounds: ["Callback round", "Final"], dances: 0, entries: 3 }] },
        ],
      }),
    );
    expect(html).toContain("ProAm");
    expect(html).toContain("Final · 2 dances");
    expect(html).toContain("Callback round → Final · 3 entries");
    expect(html).toContain("needs a division before the competition can be published");
    expect(html.match(/Add division/g)?.length).toBe(2);
    expect(html).not.toContain('role="dialog"');
  });
});
