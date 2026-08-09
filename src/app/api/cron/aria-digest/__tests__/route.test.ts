import { afterEach, describe, expect, it, vi } from "vitest";
import { processDigestRun, type DigestPreferenceRow } from "@/app/api/cron/aria-digest/route";

const createAdminClient = vi.fn();

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => createAdminClient(),
}));

/** `.insert(row).select(cols).single()` */
function insertSingleBuilder(getResult: () => Promise<unknown>) {
  return {
    insert: (_row: unknown) => ({
      select: (_cols: string) => ({
        single: () => getResult(),
      }),
    }),
  };
}

/** `.select(cols).eq(col, val).maybeSingle()` */
function selectMaybeSingleBuilder(getResult: () => Promise<unknown>) {
  return {
    select: (_cols: string) => ({
      eq: (_col: string, _val: unknown) => ({
        maybeSingle: () => getResult(),
      }),
    }),
  };
}

/** `.select(cols).eq().in().order().order().limit(n)` (automation_actions) */
function actionsBuilder(getResult: () => Promise<unknown>) {
  return {
    select: (_cols: string) => ({
      eq: (_col: string, _val: unknown) => ({
        in: (_col2: string, _vals: unknown[]) => ({
          order: (_col3: string, _opts: unknown) => ({
            order: (_col4: string, _opts2: unknown) => ({
              limit: (_n: number) => getResult(),
            }),
          }),
        }),
      }),
    }),
  };
}

/** aria_digest_runs supports both the initial insert and the later updates. */
function ariaDigestRunsBuilder(params: {
  insertResult: () => Promise<unknown>;
  onUpdate: (payload: Record<string, unknown>) => Promise<{ error: null }>;
}) {
  return {
    insert: (_row: unknown) => ({
      select: (_cols: string) => ({
        single: () => params.insertResult(),
      }),
    }),
    update: (payload: Record<string, unknown>) => ({
      eq: (_col: string, _val: unknown) => params.onUpdate(payload),
    }),
  };
}

/**
 * Reproduces: outbound_deliveries insert succeeds, then the immediately
 * following aria_digest_runs "queued" update throws (a low-level failure,
 * not a normal Postgrest {error} result) — landing processDigestRun in its
 * catch block while a delivery has already been created.
 */
function createFakeAdminClient(options: {
  studio: Record<string, unknown>;
  profile: Record<string, unknown> | null;
  onOutboundInsert: () => void;
  onFailureUpdate: (payload: Record<string, unknown>) => void;
  onTerminalAlertInsert: () => void;
}) {
  let ariaDigestRunsUpdateCount = 0;

  return {
    from(table: string) {
      switch (table) {
        case "aria_digest_runs":
          return ariaDigestRunsBuilder({
            insertResult: async () => ({ data: { id: "run-1" }, error: null }),
            onUpdate: async (payload) => {
              ariaDigestRunsUpdateCount += 1;
              if (ariaDigestRunsUpdateCount === 1) {
                // The "queued" status update — simulate a network-level throw,
                // not a normal Postgrest error response.
                throw new Error("simulated network reset during tracking update");
              }
              options.onFailureUpdate(payload);
              return { error: null };
            },
          });
        case "studios":
          return selectMaybeSingleBuilder(async () => ({ data: options.studio, error: null }));
        case "automation_actions":
          return actionsBuilder(async () => ({ data: [], error: null }));
        case "profiles":
          return selectMaybeSingleBuilder(async () => ({ data: options.profile, error: null }));
        case "outbound_deliveries":
          return insertSingleBuilder(async () => {
            options.onOutboundInsert();
            return { data: { id: "delivery-1" }, error: null };
          });
        case "platform_error_logs":
          return {
            insert: async (_row: unknown) => {
              options.onTerminalAlertInsert();
              return { error: null };
            },
          };
        default:
          throw new Error(`Unexpected table in fake admin client: ${table}`);
      }
    },
  };
}

afterEach(() => {
  createAdminClient.mockReset();
});

describe("processDigestRun — delivery_id recovery on tracking-update failure", () => {
  const preference: DigestPreferenceRow = {
    studio_id: "studio-1",
    morning_digest_enabled: true,
    end_of_day_digest_enabled: false,
    delivery_channel: "email",
    default_recipient_user_id: "user-1",
    morning_digest_time: "08:00",
    end_of_day_digest_time: null,
  };

  it("keeps the created delivery_id on the failure-path update, creates exactly one outbound delivery, and does not misclassify as a no-delivery terminal failure", async () => {
    const outboundInserts: number[] = [];
    const failureUpdatePayloads: Record<string, unknown>[] = [];
    const terminalAlertInserts: number[] = [];

    const fakeClient = createFakeAdminClient({
      studio: { id: "studio-1", name: "Test Studio", public_name: null, public_logo_url: null, timezone: "UTC" },
      profile: { id: "user-1", full_name: "Jamie Owner", email: "owner@studio.com" },
      onOutboundInsert: () => outboundInserts.push(1),
      onFailureUpdate: (payload) => failureUpdatePayloads.push(payload),
      onTerminalAlertInsert: () => terminalAlertInserts.push(1),
    });
    createAdminClient.mockReturnValue(fakeClient);

    await expect(
      processDigestRun({
        preference,
        digestType: "morning",
        digestDate: "2026-08-08",
        now: new Date("2026-08-08T08:00:00Z"),
      }),
    ).rejects.toThrow("simulated network reset during tracking update");

    // Exactly one outbound delivery was created — no duplicate.
    expect(outboundInserts).toHaveLength(1);

    // The failure-path update preserved the already-created delivery_id.
    expect(failureUpdatePayloads).toHaveLength(1);
    expect(failureUpdatePayloads[0]).toMatchObject({
      status: "failed",
      delivery_id: "delivery-1",
    });

    // Because a delivery_id was present, classification was "retry", not
    // "terminal" — so no false no-delivery terminal alert was recorded.
    expect(terminalAlertInserts).toHaveLength(0);
  });

  it("baseline: without a created delivery (failure before the outbound insert), the run IS classified terminal", async () => {
    const outboundInserts: number[] = [];
    const failureUpdatePayloads: Record<string, unknown>[] = [];
    const terminalAlertInserts: number[] = [];

    const fakeClient = {
      from(table: string) {
        switch (table) {
          case "aria_digest_runs":
            return ariaDigestRunsBuilder({
              insertResult: async () => ({ data: { id: "run-2" }, error: null }),
              onUpdate: async (payload) => {
                failureUpdatePayloads.push(payload);
                return { error: null };
              },
            });
          case "studios":
            return selectMaybeSingleBuilder(async () => ({ data: null, error: null }));
          case "automation_actions":
            return {
              select: () => {
                throw new Error("automation_actions lookup failed before any delivery was created");
              },
            };
          case "profiles":
            return selectMaybeSingleBuilder(async () => ({ data: null, error: null }));
          case "outbound_deliveries":
            return insertSingleBuilder(async () => {
              outboundInserts.push(1);
              return { data: { id: "delivery-x" }, error: null };
            });
          case "platform_error_logs":
            return {
              insert: async () => {
                terminalAlertInserts.push(1);
                return { error: null };
              },
            };
          default:
            throw new Error(`Unexpected table: ${table}`);
        }
      },
    };
    createAdminClient.mockReturnValue(fakeClient);

    await expect(
      processDigestRun({
        preference,
        digestType: "morning",
        digestDate: "2026-08-08",
        now: new Date("2026-08-08T08:00:00Z"),
      }),
    ).rejects.toThrow();

    expect(outboundInserts).toHaveLength(0);
    expect(failureUpdatePayloads[0]).toMatchObject({ status: "failed", delivery_id: null });
    expect(terminalAlertInserts).toHaveLength(1);
  });
});
