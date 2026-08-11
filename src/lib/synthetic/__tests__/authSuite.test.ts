import { describe, expect, it, vi } from "vitest";
import { runAuthSuite } from "@/lib/synthetic/suites/auth";
import { SyntheticSafetyError } from "@/lib/synthetic/types";
import type { SuiteContext } from "@/lib/synthetic/suites/contract";
import type { SyntheticConfig } from "@/lib/synthetic/types";

/**
 * SYN-AUTH-001 regression coverage for the clients-based tenant-isolation
 * assertion (replacing the original `studios` read, which turned out not
 * to be tenant-restricted -- `studios` and `user_studio_roles` both carry
 * an "authenticated users can select ... during onboarding" `USING (true)`
 * policy that grants blanket SELECT to any logged-in user. `clients` has
 * no such policy, so it's the resource this suite now uses to prove RLS
 * actually enforces tenant isolation, not just that a query filter worked.
 */

const CONFIG: SyntheticConfig = {
  studioId: "studio-syn",
  supabaseUrl: "https://example.supabase.co",
  supabaseAnonKey: "anon-key",
  identities: {},
  eventFixture: null,
};

function makeSessionClient(options: {
  preLogoutRows?: { studio_id: string }[];
  preLogoutError?: { message: string } | null;
  postLogoutRows?: { studio_id: string }[];
  postLogoutError?: { message: string } | null;
}) {
  let signedOut = false;
  return {
    auth: {
      signOut: vi.fn(async () => {
        signedOut = true;
        return { error: null };
      }),
    },
    from(table: string) {
      if (table !== "clients") throw new Error(`Unexpected table in fake session client: ${table}`);
      return {
        select: () => ({
          limit: async () => {
            if (signedOut) {
              return { data: options.postLogoutRows ?? [], error: options.postLogoutError ?? null };
            }
            return { data: options.preLogoutRows ?? [], error: options.preLogoutError ?? null };
          },
        }),
      };
    },
  };
}

function makeCtx(sessionClient: unknown, studioId: string = CONFIG.studioId): SuiteContext {
  return {
    runId: "syn_test",
    config: CONFIG,
    sessions: {
      owner: { role: "owner", client: sessionClient as never, userId: "user-owner", studioId },
    },
  };
}

describe("runAuthSuite", () => {
  it("passes when every visible client row belongs to the synthetic tenant and post-logout returns zero rows", async () => {
    const client = makeSessionClient({
      preLogoutRows: [{ studio_id: CONFIG.studioId }, { studio_id: CONFIG.studioId }],
      postLogoutRows: [],
    });

    const refs = await runAuthSuite(makeCtx(client));

    expect(refs).toEqual({});
    expect(client.auth.signOut).toHaveBeenCalledTimes(1);
  });

  it("fails when a visible client row belongs to a DIFFERENT studio (the exact regression this suite exists to catch)", async () => {
    const client = makeSessionClient({
      preLogoutRows: [{ studio_id: CONFIG.studioId }, { studio_id: "some-other-studio" }],
    });

    await expect(runAuthSuite(makeCtx(client))).rejects.toThrow(/outside the synthetic tenant/);
  });

  it("fails when the pre-logout protected-resource query itself errors", async () => {
    const client = makeSessionClient({
      preLogoutError: { message: "connection reset" },
    });

    await expect(runAuthSuite(makeCtx(client))).rejects.toThrow(/Could not load protected clients resource/);
  });

  it("passes when the post-logout query errors instead of returning empty rows (either is an acceptable 'terminated' signal)", async () => {
    const client = makeSessionClient({
      preLogoutRows: [{ studio_id: CONFIG.studioId }],
      postLogoutError: { message: "JWT expired" },
    });

    await expect(runAuthSuite(makeCtx(client))).resolves.toEqual({});
  });

  it("fails when protected client data is still readable after logout -- session did not actually terminate", async () => {
    const client = makeSessionClient({
      preLogoutRows: [{ studio_id: CONFIG.studioId }],
      postLogoutRows: [{ studio_id: CONFIG.studioId }],
    });

    await expect(runAuthSuite(makeCtx(client))).rejects.toThrow(/session did not terminate/);
  });

  it("fails closed via assertSyntheticStudio before ever querying clients if the session's studioId doesn't match config", async () => {
    const client = makeSessionClient({ preLogoutRows: [] });
    const ctx = makeCtx(client, "a-completely-different-studio");

    await expect(runAuthSuite(ctx)).rejects.toThrow(SyntheticSafetyError);
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });
});
