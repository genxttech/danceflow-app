import { beforeEach, describe, expect, it, vi } from "vitest";

const getUserMock = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: getUserMock } })),
}));

import { getPublicAuthState } from "../authState";

describe("getPublicAuthState", () => {
  beforeEach(() => {
    getUserMock.mockReset();
  });

  it("returns true when a user exists", async () => {
    getUserMock.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    await expect(getPublicAuthState()).resolves.toBe(true);
  });

  it("returns false when user is null", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    await expect(getPublicAuthState()).resolves.toBe(false);
  });

  it("returns false for the normal missing-session result (user null with an error object)", async () => {
    getUserMock.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthSessionMissingError", message: "Auth session missing!" },
    });
    await expect(getPublicAuthState()).resolves.toBe(false);
  });

  it("propagates unexpected exceptions instead of reporting signed-out", async () => {
    getUserMock.mockRejectedValue(new Error("supabase unreachable"));
    await expect(getPublicAuthState()).rejects.toThrow("supabase unreachable");
  });
});
