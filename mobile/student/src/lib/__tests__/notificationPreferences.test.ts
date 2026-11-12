// Found on the Android emulator (2026-11-10): the push bootstrap and the Settings card both
// created a user's first preferences row at once, the second insert hit the primary key, and
// the rejection went unhandled. Creation must tolerate the other writer.
const calls: string[] = [];
let mockStoredRow: Record<string, boolean> | null = null;
let mockUpsertOptions: unknown = null;

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("expo-constants", () => ({ __esModule: true, default: { appOwnership: null, expoConfig: { extra: { eas: { projectId: "p" } } } } }));
jest.mock("expo-notifications", () => ({}));
jest.mock("@/lib/secureSessionStorage", () => ({ secureSessionStorage: { getItem: jest.fn(), setItem: jest.fn(), removeItem: jest.fn() } }));
jest.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          calls.push("select");
          return { data: mockStoredRow, error: null };
        },
        upsert: async (row: Record<string, unknown>, options: unknown) => {
          calls.push("upsert");
          mockUpsertOptions = options;
          // The other writer got there first: the row exists with its own values.
          mockStoredRow = mockStoredRow ?? { push_enabled: false, schedule_updates: true, event_updates: true, favorite_updates: true, learning_updates: true, account_updates: true, partner_updates: true };
          void row;
          return { error: null };
        },
        insert: async () => {
          calls.push("insert");
          return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        }
      };
      return chain;
    }
  }
}));

import { loadNotificationPreferences } from "@/lib/pushNotifications";

beforeEach(() => {
  calls.length = 0;
  mockStoredRow = null;
  mockUpsertOptions = null;
});

it("creates the first row without failing when another caller already created it, and returns what is stored", async () => {
  const preferences = await loadNotificationPreferences("user-1");

  expect(calls).toEqual(["select", "upsert", "select"]);
  expect(mockUpsertOptions).toEqual({ onConflict: "user_id", ignoreDuplicates: true });
  expect(preferences.pushEnabled).toBe(false);
});

it("reads an existing row without writing", async () => {
  mockStoredRow = { push_enabled: true, schedule_updates: false, event_updates: true, favorite_updates: true, learning_updates: true, account_updates: true, partner_updates: true };

  const preferences = await loadNotificationPreferences("user-1");

  expect(calls).toEqual(["select"]);
  expect(preferences.scheduleUpdates).toBe(false);
});
