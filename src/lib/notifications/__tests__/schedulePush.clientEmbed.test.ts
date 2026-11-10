import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/notifications/expoPush", () => ({ sendMobilePushToUser: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/schedule/groupClassRoster", () => ({ resolveClassAttendeesForNotification: vi.fn(async () => []) }));

import { sendAppointmentSchedulePush, sendGroupClassCancellationPush } from "@/lib/notifications/schedulePush";

/**
 * `appointments` has TWO foreign keys to `clients` (client_id and partner_client_id), so a bare `clients ( ... )` embed is ambiguous in PostgREST
 * (PGRST201 "more than one relationship was found for 'appointments' and 'clients'") and the push is dropped. Production saw exactly that on a schedule edit.
 * The real-PostgREST proof is localStack.schedulepush; these cells pin the query text so the ambiguity cannot come back unnoticed.
 */
const source = readFileSync(join(__dirname, "..", "schedulePush.ts"), "utf8");

function recordingClient() {
  const selects: string[] = [];
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = (q: string) => {
    selects.push(q);
    return builder;
  };
  builder.eq = chain;
  builder.in = chain;
  builder.is = chain;
  builder.order = chain;
  builder.limit = chain;
  builder.maybeSingle = async () => ({ data: null, error: { message: "stop here" } });
  builder.single = async () => ({ data: null, error: { message: "stop here" } });
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: "stop here" } });
  const supabase = { from: () => builder } as never;
  return { supabase, selects };
}

describe("schedule push: appointments to clients embed is explicit", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("has no bare `clients (` embed anywhere in the module", () => {
    // remove every hinted or aliased embed, then nothing ambiguous may remain
    const withoutHinted = source.replace(/clients(?:!|:clients!)[a-z_]+\s*\(/g, "");
    expect(withoutHinted).not.toMatch(/(^|[\s,])clients\s*\(/m);
  });

  it("both appointment reads name the client relationship appointments_client_id_fkey and keep the result key `clients`", () => {
    const matches = source.match(/clients:clients!appointments_client_id_fkey\s*\(/g) ?? [];
    expect(matches).toHaveLength(2);
    expect(source.match(/partner_client:clients!appointments_partner_client_id_fkey\s*\(/g) ?? []).toHaveLength(2);
  });

  it("sendAppointmentSchedulePush selects the explicit relationship", async () => {
    const { supabase, selects } = recordingClient();
    await sendAppointmentSchedulePush({ supabase, studioId: "s", appointmentId: "a", reason: "confirmed" });
    expect(selects[0]).toContain("clients:clients!appointments_client_id_fkey");
    expect(selects[0]).toContain("partner_client:clients!appointments_partner_client_id_fkey");
    expect(selects[0].replace(/clients:clients!appointments_client_id_fkey/, "")).not.toMatch(/[\s,]clients\s*\(/);
  });

  it("sendGroupClassCancellationPush selects the explicit relationship", async () => {
    const { supabase, selects } = recordingClient();
    await sendGroupClassCancellationPush({ supabase, studioId: "s", appointmentId: "a", affectedClientIds: ["c1"] }).catch(() => {});
    const q = selects.find((s) => s.includes("partner_client")) ?? "";
    expect(q).toContain("clients:clients!appointments_client_id_fkey");
  });
});
