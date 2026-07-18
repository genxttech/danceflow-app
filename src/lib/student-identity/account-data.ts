import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

const EXPORT_TABLES = [
  "profiles",
  "dancer_profiles",
  "dancer_partner_profiles",
  "client_account_links",
  "event_registrations",
  "user_favorites",
  "mobile_notification_preferences",
  "mobile_push_tokens",
  "mobile_notification_log",
  "legal_agreement_acceptances",
  "user_account_status",
] as const;

type ExportTable = (typeof EXPORT_TABLES)[number];

async function loadRows(table: ExportTable, userId: string) {
  const admin = createAdminClient();
  const key = table === "profiles" ? "id" : "user_id";

  const { data, error } = await admin
    .from(table)
    .select("*")
    .eq(key, userId)
    .limit(10000);

  if (error) {
    throw new Error(`Data export failed for ${table}: ${error.message}`);
  }

  return data ?? [];
}

export async function buildDanceFlowAccountExport(user: User) {
  const entries = await Promise.all(
    EXPORT_TABLES.map(async (table) => [table, await loadRows(table, user.id)] as const),
  );

  return {
    exportVersion: "2026-07-18",
    generatedAt: new Date().toISOString(),
    account: {
      userId: user.id,
      email: user.email ?? null,
      createdAt: user.created_at,
      lastSignInAt: user.last_sign_in_at ?? null,
      userMetadata: user.user_metadata ?? {},
    },
    data: Object.fromEntries(entries),
    notes: [
      "Studio-owned client records, financial records, attendance, documents, and internal notes are not included because they belong to the studio.",
      "Event registrations and studio relationship history may be retained after account deletion for business, fraud-prevention, and legal-record purposes, with the DanceFlow auth identity removed.",
    ],
  };
}
