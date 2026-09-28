import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** PAY-DC-2C: payment_disputes migration source guards. */

const sql = readFileSync(
  join(process.cwd(), "src", "lib", "supabase", "migrations", "20260928090000_paydc2c_payment_disputes.sql"),
  "utf8",
).replace(/--[^\n]*/g, "");

describe("payment_disputes migration", () => {
  it("creates the table with scope, nullable account and one-link rules", () => {
    expect(sql).toContain("create table if not exists public.payment_disputes");
    expect(sql).toMatch(/stripe_scope text not null check \(stripe_scope in \('platform', 'connect'\)\)/);
    expect(sql).toMatch(/stripe_account_id text null,/);
    expect(sql).toMatch(/stripe_dispute_id text not null unique/);
    expect(sql).toMatch(/\(stripe_scope = 'connect' and stripe_account_id ~ '\^acct_\[A-Za-z0-9\]\+\$'\)/);
    expect(sql).toMatch(/\(stripe_scope = 'platform' and stripe_account_id is null\)/);
    expect(sql).toMatch(/check \(payment_id is null or event_payment_id is null\)/);
  });

  it("stores no evidence, metadata or raw payload columns", () => {
    expect(sql).not.toMatch(/evidence\s+(jsonb|text)|metadata\s+jsonb|raw_payload|customer_email|billing/);
  });

  it("makes identity immutable (studio, scope, account, dispute id, set links)", () => {
    for (const column of ["studio_id", "stripe_scope", "stripe_account_id", "stripe_dispute_id"]) {
      expect(sql).toContain(`new.${column} is distinct from old.${column}`);
    }
    expect(sql).toContain("before update on public.payment_disputes");
    expect(sql).toContain("execute function public.set_updated_at()");
  });

  it("payment links may be cleared (ON DELETE SET NULL) but never re-pointed", () => {
    const flat = sql.replace(/\s+/g, " ");
    for (const link of ["payment_id", "event_payment_id"]) {
      expect(flat).toContain(
        `old.${link} is not null and new.${link} is not null and new.${link} is distinct from old.${link}`,
      );
      expect(flat).toMatch(new RegExp(`${link} uuid null references public\\.\\w+\\(id\\) on delete set null`));
    }
    expect(sql).toContain("payment_disputes payment link cannot be re-pointed");
    expect(sql).not.toContain("payment link is immutable once set");
  });

  it("is readable by studio owner/admin/platform admin only, with no write policies", () => {
    expect(sql).toContain("enable row level security");
    expect(sql).toMatch(/for select\s+to authenticated/);
    expect(sql).toContain("usr.role::text in ('platform_admin', 'studio_owner', 'studio_admin')");
    expect(sql).not.toMatch(/for (insert|update|delete|all)\b/);
  });

  it("performs no historical backfill", () => {
    expect(sql).not.toMatch(/insert into|update public\.(payments|event_payments|payment_disputes)/);
  });
});
