const calls: { op: string; payload: Record<string, unknown> }[] = [];

jest.mock("@/lib/danceflowApi", () => ({ danceflowApiFetch: jest.fn() }));
jest.mock("@/lib/supabase", () => {
  const chain = { eq: () => chain, then: (resolve: (v: unknown) => void) => resolve({ error: null }) };
  return {
    supabase: {
      from: () => ({
        insert: (payload: Record<string, unknown>) => {
          calls.push({ op: "insert", payload });
          return Promise.resolve({ error: null });
        },
        update: (payload: Record<string, unknown>) => {
          calls.push({ op: "update", payload });
          return chain;
        }
      })
    }
  };
});

import { saveMyPartnerProfile, type DancerPartnerProfile } from "@/lib/partnerSearch";

const base: DancerPartnerProfile = {
  id: null,
  displayName: "Dancer",
  headline: "",
  bio: "Social foxtrot",
  city: "",
  state: "",
  leadFollowRole: "either",
  danceStyles: "Foxtrot",
  skillLevel: "social",
  goals: "Practice",
  listingIntent: "practice",
  availabilityNotes: "",
  photoUrl: "",
  visibility: "draft",
  moderationStatus: "pending",
  moderationReason: "",
  allowStudioBadge: false,
  termsAcceptedAt: null
};

describe("saveMyPartnerProfile", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it.each([
    ["new published listing", null, "published", "pending"],
    ["existing approved listing kept as draft", "profile-1", "draft", "approved"],
    ["existing approved listing republished", "profile-1", "published", "approved"]
  ] as const)("never writes moderation fields: %s", async (_label, id, visibility, moderationStatus) => {
    const profile: DancerPartnerProfile = { ...base, id, visibility, moderationStatus };

    await saveMyPartnerProfile("user-1", profile);

    expect(calls).toHaveLength(1);
    expect(calls[0].op).toBe(id ? "update" : "insert");
    for (const field of ["moderation_status", "reported_count", "last_reported_at", "blocked_reason"]) {
      expect(calls[0].payload).not.toHaveProperty(field);
    }
  });
});
