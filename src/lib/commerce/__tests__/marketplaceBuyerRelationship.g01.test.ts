import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MARKETPLACE_AUTO_STUDIO_RELATIONSHIP,
  applyMarketplaceBuyerRelationshipOptIn,
  resolveMarketplaceBuyerClient,
} from "@/lib/commerce/marketplaceBuyerRelationship";

const root = path.resolve(__dirname, "../../../..");

type Fixture = {
  selfLink?: { id: string; client_id: string } | null;
  clients?: Array<{ id: string; email: string }>;
  links?: Array<{ id: string; user_id: string | null; status: string }>;
  errorOn?: "client_account_links_self" | "clients" | "client_account_links_all";
};

function fakeAdmin(fixture: Fixture) {
  const writes: string[] = [];
  const reads: string[] = [];
  const from = (table: string) => {
    let selfQuery = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        if (table === "client_account_links" && column === "relationship_type" && value === "self") selfQuery = true;
        return chain;
      },
      ilike: () => chain,
      order: () => chain,
      limit: () => chain,
      insert: () => {
        writes.push(`insert:${table}`);
        return chain;
      },
      update: () => {
        writes.push(`update:${table}`);
        return chain;
      },
      delete: () => {
        writes.push(`delete:${table}`);
        return chain;
      },
      upsert: () => {
        writes.push(`upsert:${table}`);
        return chain;
      },
      maybeSingle: async () => {
        reads.push(`${table}:maybeSingle`);
        if (fixture.errorOn === "client_account_links_self") return { data: null, error: { message: "boom" } };
        return { data: selfQuery ? fixture.selfLink ?? null : null, error: null };
      },
      then: (resolve: (value: unknown) => unknown) => {
        reads.push(`${table}:list`);
        if (table === "clients") {
          return resolve(fixture.errorOn === "clients" ? { data: null, error: { message: "boom" } } : { data: fixture.clients ?? [], error: null });
        }
        if (table === "client_account_links") {
          return resolve(fixture.errorOn === "client_account_links_all" ? { data: null, error: { message: "boom" } } : { data: fixture.links ?? [], error: null });
        }
        return resolve({ data: [], error: null });
      },
    };
    return chain;
  };
  return { admin: { from } as never, writes, reads };
}

const base = { studioId: "studio-1", userId: "user-1", normalizedEmail: "pat@example.com" };

describe("G-01 resolveMarketplaceBuyerClient never writes", () => {
  it("a buyer with no studio record and no relationship becomes a guest: no client lookup result, no writes", async () => {
    const { admin, writes } = fakeAdmin({});
    const result = await resolveMarketplaceBuyerClient({ admin, ...base, isEmailVerified: () => true });
    expect(result).toEqual({ ok: true, clientId: null, basis: "none" });
    expect(writes).toEqual([]);
  });

  it("an existing linked self relationship is used as before (and needs no email verification)", async () => {
    const { admin, writes } = fakeAdmin({ selfLink: { id: "l1", client_id: "client-9" } });
    let verifiedAsked = false;
    const result = await resolveMarketplaceBuyerClient({
      admin,
      ...base,
      isEmailVerified: () => {
        verifiedAsked = true;
        return false;
      },
    });
    expect(result).toEqual({ ok: true, clientId: "client-9", basis: "existing_self_link" });
    expect(verifiedAsked).toBe(false);
    expect(writes).toEqual([]);
  });

  it("an existing valid lead/client matched by the verified email is attached WITHOUT creating or changing any link", async () => {
    const { admin, writes } = fakeAdmin({ clients: [{ id: "lead-1", email: "Pat@Example.com" }], links: [] });
    const result = await resolveMarketplaceBuyerClient({ admin, ...base, isEmailVerified: () => true });
    expect(result).toEqual({ ok: true, clientId: "lead-1", basis: "verified_email_match" });
    expect(writes).toEqual([]);
  });

  it("an unverified email is refused (unchanged gate) with no writes", async () => {
    const { admin, writes } = fakeAdmin({ clients: [{ id: "lead-1", email: "pat@example.com" }] });
    const result = await resolveMarketplaceBuyerClient({ admin, ...base, isEmailVerified: () => false });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(writes).toEqual([]);
  });

  it("duplicate customer records for the email block the purchase", async () => {
    const { admin, writes } = fakeAdmin({
      clients: [
        { id: "a", email: "pat@example.com" },
        { id: "b", email: "pat@example.com" },
      ],
    });
    expect(await resolveMarketplaceBuyerClient({ admin, ...base, isEmailVerified: () => true })).toMatchObject({ ok: false, status: 409 });
    expect(writes).toEqual([]);
  });

  it("a client already held by a different DanceFlow account blocks the purchase", async () => {
    const { admin } = fakeAdmin({
      clients: [{ id: "c1", email: "pat@example.com" }],
      links: [{ id: "l", user_id: "someone-else", status: "linked" }],
    });
    expect(await resolveMarketplaceBuyerClient({ admin, ...base, isEmailVerified: () => true })).toMatchObject({ ok: false, status: 409 });
  });

  it.each(["disconnected", "former_client", "rejected", "conflict"])(
    "a %s relationship the studio closed is never revived",
    async (status) => {
      const { admin, writes } = fakeAdmin({
        clients: [{ id: "c1", email: "pat@example.com" }],
        links: [{ id: "l", user_id: "user-1", status }],
      });
      expect(await resolveMarketplaceBuyerClient({ admin, ...base, isEmailVerified: () => true })).toMatchObject({ ok: false, status: 409 });
      expect(writes).toEqual([]);
    },
  );

  it.each(["client_account_links_self", "clients", "client_account_links_all"] as const)(
    "a database error on %s fails closed (500) with no writes",
    async (errorOn) => {
      const { admin, writes } = fakeAdmin({
        errorOn,
        clients: [{ id: "c1", email: "pat@example.com" }],
      });
      expect(await resolveMarketplaceBuyerClient({ admin, ...base, isEmailVerified: () => true })).toMatchObject({ ok: false, status: 500 });
      expect(writes).toEqual([]);
    },
  );

  it("the opt-in seam is explicit and inert until the owner decides D6", async () => {
    expect(MARKETPLACE_AUTO_STUDIO_RELATIONSHIP).toBe(false);
    expect(await applyMarketplaceBuyerRelationshipOptIn({ studioId: "s", userId: "u", orderId: "o", optIn: true })).toEqual({
      created: false,
      reason: "not_implemented_pending_owner_decision_d6",
    });
  });
});

describe("G-01 checkout route (source guard)", () => {
  const route = readFileSync(path.join(root, "src/app/api/student/marketplace/[catalogItemId]/checkout/route.ts"), "utf8");
  const code = route.replace(/\/\/.*$/gm, "");

  it("creates no client and no client_account_links row, and writes no portal permissions", () => {
    expect(code).not.toMatch(/from\(\s*["']clients["']\s*\)\s*\.insert/);
    expect(code).not.toMatch(/client_account_links/);
    expect(code).not.toMatch(/status:\s*["']lead["']/);
    expect(code).not.toMatch(/can_view_billing|can_manage_bookings|can_sign_documents|can_view_schedule/);
    expect(code).not.toMatch(/referral_source|source_system/);
  });

  it("resolves the buyer through the read-only resolver and keeps the verified-email gate", () => {
    expect(code).toContain("resolveMarketplaceBuyerClient(");
    expect(code).toContain("getMyVerifiedEmail(");
  });

  it("a buyer with no existing client is recorded as a guest order, never a fabricated client", () => {
    expect(code).toMatch(/customer_type:\s*clientId \? "client" : "guest"/);
    expect(code).toMatch(/guest_email:\s*clientId \? null : normalizedEmail/);
  });
});

describe("G-01 migration and settlement path", () => {
  it("the migration only relaxes commerce_entitlements.client_id and ships a Git-only rollback", () => {
    const sql = readFileSync(path.join(root, "src/lib/supabase/migrations/20270220090000_g01_marketplace_guest_entitlements.sql"), "utf8").replace(/--.*$/gm, "");
    expect(sql).toMatch(/alter table public\.commerce_entitlements alter column client_id drop not null/);
    expect(sql).not.toMatch(/\bdelete\s+from\b|\btruncate\b|\bdrop\s+table\b|\binsert\s+into\b|\bupdate\s+public\./i);
    const rollback = readFileSync(
      path.join(root, "src/lib/supabase/migrations/rollback/20270220090000_g01_marketplace_guest_entitlements_rollback.sql"),
      "utf8",
    );
    expect(rollback).toContain("rollback refused");
    expect(rollback).toContain("set not null");
  });

  it("settlement (finalize) creates the entitlement for user_id and never inserts clients or links", () => {
    const finalize = readFileSync(path.join(root, "src/lib/supabase/migrations/20260721033000_create_student_marketplace_checkout.sql"), "utf8");
    expect(finalize).not.toMatch(/insert into public\.clients|insert into public\.client_account_links/i);
    expect(finalize).toMatch(/v_user_id := nullif\(v_order\.metadata ->> 'student_user_id'/);
  });
});
