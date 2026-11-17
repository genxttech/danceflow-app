import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { claimMyEventRegistrations } from "@/lib/events/claimMyEventRegistrations";

const root = path.resolve(__dirname, "../../../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const strip = (sql: string) => sql.replace(/--.*$/gm, "");

const clientWith = (result: unknown) => ({ rpc: vi.fn(async () => result) }) as never;

describe("claimMyEventRegistrations (web wrapper)", () => {
  it("calls the parameterless RPC and returns the claimed count", async () => {
    const c = { rpc: vi.fn(async () => ({ data: 3, error: null })) };
    expect(await claimMyEventRegistrations(c as never)).toBe(3);
    expect(c.rpc).toHaveBeenCalledTimes(1);
    expect(c.rpc.mock.calls[0]).toEqual(["claim_my_event_registrations"]);
  });

  it("treats a missing function / any RPC error as nothing claimed", async () => {
    expect(await claimMyEventRegistrations(clientWith({ data: null, error: { code: "PGRST202", message: "not found" } }))).toBe(0);
    expect(await claimMyEventRegistrations(clientWith({ data: null, error: { code: "42501", message: "permission denied" } }))).toBe(0);
  });

  it("never throws, even if the call rejects", async () => {
    const c = { rpc: vi.fn(async () => { throw new Error("network"); }) };
    expect(await claimMyEventRegistrations(c as never)).toBe(0);
  });

  it("ignores non-numeric or negative results", async () => {
    expect(await claimMyEventRegistrations(clientWith({ data: "5", error: null }))).toBe(0);
    expect(await claimMyEventRegistrations(clientWith({ data: -1, error: null }))).toBe(0);
    expect(await claimMyEventRegistrations(clientWith({ data: null, error: null }))).toBe(0);
  });
});

describe("/account wiring", () => {
  it("claims before listing registrations, using the user session client", () => {
    const page = read("src/app/account/page.tsx");
    expect(page).toContain('import { claimMyEventRegistrations } from "@/lib/events/claimMyEventRegistrations"');
    const claim = page.indexOf("await claimMyEventRegistrations(supabase)");
    const list = page.indexOf('.from("event_registrations")');
    expect(claim).toBeGreaterThan(-1);
    expect(claim).toBeLessThan(list);
  });
});

describe("claim migration shape", () => {
  const sql = strip(read("src/lib/supabase/migrations/20270221090000_event_registration_claim_function.sql"));

  it("is parameterless, definer, pinned search_path, email only from my_verified_email()", () => {
    expect(sql).toMatch(/function public\.claim_my_event_registrations\(\)/);
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = ''");
    expect(sql).toContain("public.my_verified_email()");
    expect(sql).not.toMatch(/auth\.users|auth\.jwt|request\.jwt/i);
  });

  it("updates only event_registrations.user_id, only where unclaimed, and writes nothing else", () => {
    expect(sql.match(/\bupdate\s+public\.\w+/gi)).toEqual(["update public.event_registrations"]);
    expect(sql).toMatch(/set user_id = v_uid\s+where user_id is null/);
    expect(sql).not.toMatch(/\binsert\s+into\b|\bdelete\s+from\b/i);
    expect(sql).not.toMatch(/clients|client_account_links|notifications|payments|marketing/i);
  });

  it("grants execute to authenticated only", () => {
    expect(sql).toContain("revoke all on function public.claim_my_event_registrations() from public, anon, authenticated, service_role");
    expect(sql).toContain("grant execute on function public.claim_my_event_registrations() to authenticated");
    expect(sql).not.toMatch(/grant execute[^;]*\bto\s+(anon|public|service_role)\b/i);
  });

  it("index migration is concurrent, partial, standalone (no transaction) and has rollbacks", () => {
    const idx = strip(read("src/lib/supabase/migrations/20270221091000_event_registrations_unclaimed_email_index_concurrent.sql"));
    expect(idx).toMatch(/create index concurrently if not exists event_registrations_unclaimed_email_idx/);
    expect(idx).toContain("lower(btrim(attendee_email))");
    expect(idx).toMatch(/where user_id is null/);
    expect(idx).not.toMatch(/\bbegin\b|\bcommit\b/i);
    expect(read("src/lib/supabase/migrations/rollback/20270221090000_event_registration_claim_function_rollback.sql")).toContain("drop function if exists public.claim_my_event_registrations()");
    expect(read("src/lib/supabase/migrations/rollback/20270221091000_event_registrations_unclaimed_email_index_concurrent_rollback.sql")).toContain("drop index concurrently if exists");
  });
});
