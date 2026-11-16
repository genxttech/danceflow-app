import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../../..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");
const strip = (sql: string) => sql.replace(/--.*$/gm, "");

const migration = read("src/lib/supabase/migrations/20270220100000_g01b_marketplace_purchase_notice.sql");
const original = read("src/lib/supabase/migrations/20260721033000_create_student_marketplace_checkout.sql");

describe("G-01b migration shape", () => {
  it("keeps every integrity guard of the original finalize function verbatim", () => {
    for (const guard of [
      "Commerce order amount does not match the payment.",
      "Commerce order currency does not match the payment.",
      "Commerce order is not awaiting payment.",
      "This student already owns this content.",
      "Commerce order is missing the student account.",
      "for update;",
      "'student_marketplace'",
    ]) {
      expect(migration).toContain(guard);
      expect(original).toContain(guard);
    }
    // the replay branch returns BEFORE the notice, so a redelivery cannot notify again
    const replay = migration.indexOf("return v_entitlement_id;");
    const notice = migration.indexOf("'marketplace_purchase:' || v_order.id::text");
    expect(replay).toBeGreaterThan(-1);
    expect(replay).toBeLessThan(notice);
  });

  it("emits one deduplicated, tenant-bound notice and never creates a client, lead or link", () => {
    const sql = strip(migration);
    expect(sql).toContain("on conflict (dedupe_key) where dedupe_key is not null do nothing");
    expect(sql).toMatch(/v_order\.studio_id,\s*v_order\.client_id,\s*'marketplace_purchase'/);
    expect(sql).not.toMatch(/insert into public\.clients|insert into public\.client_account_links/i);
    expect(sql).toMatch(/exception when others then\s*raise warning/);
  });

  it("notice content exposes no email or payment identifiers", () => {
    const body = migration.slice(migration.indexOf("format('%s bought"));
    const fmt = body.slice(0, body.indexOf("'marketplace_purchase:'"));
    expect(fmt).not.toMatch(/email|payment_intent|stripe/i);
  });

  it("extends the type CHECK in place (verbatim live definition, saved for rollback) and ships a rollback", () => {
    expect(migration).toContain("pg_get_constraintdef");
    expect(migration).toContain("notifications_type_check:g01b");
    const rb = read("src/lib/supabase/migrations/rollback/20270220100000_g01b_marketplace_purchase_notice_rollback.sql");
    expect(rb).toContain("delete from public.notifications where type = 'marketplace_purchase'");
    expect(rb).not.toContain("'marketplace_purchase:'");
  });

  it("the studio UI labels the new type", () => {
    expect(read("src/app/app/notifications/page.tsx")).toContain('value: "marketplace_purchase"');
    expect(read("src/components/ui/NotificationMenu.tsx")).toContain('marketplace_purchase: "Marketplace Purchase"');
  });
});
