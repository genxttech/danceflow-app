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

  const rows = data ?? [];

  if (table === "mobile_push_tokens") {
    return rows.map(({ expo_push_token: _token, ...row }) => ({
      ...row,
      expo_push_token: "[redacted]",
    }));
  }

  if (table === "mobile_notification_log") {
    return rows.map(
      ({
        provider_message_id: _providerMessageId,
        error_message: _errorMessage,
        ...row
      }) => row,
    );
  }

  return rows;
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
      "Push notification tokens and provider delivery identifiers are redacted from this export for account security.",
    ],
  };
}


function safeText(value: unknown) {
  if (value === null || value === undefined || value === "") return "Not provided";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function escapeHtml(value: unknown) {
  return safeText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function titleFromKey(key: string) {
  return key
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function rowsToText(title: string, rows: unknown[]) {
  const lines = [`\n${title}`, "-".repeat(title.length)];

  if (!rows.length) {
    lines.push("No records.");
    return lines.join("\n");
  }

  rows.forEach((row, index) => {
    lines.push(`Record ${index + 1}`);
    if (row && typeof row === "object") {
      for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
        lines.push(`${titleFromKey(key)}: ${safeText(value)}`);
      }
    } else {
      lines.push(safeText(row));
    }
    lines.push("");
  });

  return lines.join("\n").trimEnd();
}

export function buildDanceFlowAccountTextReport(
  payload: Awaited<ReturnType<typeof buildDanceFlowAccountExport>>,
) {
  const sections = [
    "DANCEFLOW ACCOUNT DATA REPORT",
    `Generated: ${payload.generatedAt}`,
    "",
    "ACCOUNT",
    "-------",
    `Email: ${safeText(payload.account.email)}`,
    `Account created: ${safeText(payload.account.createdAt)}`,
    `Last sign-in: ${safeText(payload.account.lastSignInAt)}`,
  ];

  const labels: Array<[string, keyof typeof payload.data]> = [
    ["Profile", "profiles"],
    ["Dancer Profile", "dancer_profiles"],
    ["Partner Profile", "dancer_partner_profiles"],
    ["Connected Studios", "client_account_links"],
    ["Event Registrations", "event_registrations"],
    ["Favorites", "user_favorites"],
    ["Notification Preferences", "mobile_notification_preferences"],
    ["Push Notification Devices", "mobile_push_tokens"],
    ["Notification History", "mobile_notification_log"],
    ["Legal Agreement History", "legal_agreement_acceptances"],
    ["Account Status", "user_account_status"],
  ];

  for (const [label, key] of labels) {
    sections.push(rowsToText(label.toUpperCase(), payload.data[key] as unknown[]));
  }

  sections.push(
    "\nNOTES",
    "-----",
    ...payload.notes.map((note) => `• ${note}`),
  );

  return sections.join("\n");
}

function rowsToHtml(title: string, rows: unknown[]) {
  if (!rows.length) {
    return `<section><h2>${escapeHtml(title)}</h2><p class="empty">No records.</p></section>`;
  }

  const cards = rows
    .map((row, index) => {
      if (!row || typeof row !== "object") {
        return `<article><h3>Record ${index + 1}</h3><p>${escapeHtml(row)}</p></article>`;
      }

      const fields = Object.entries(row as Record<string, unknown>)
        .map(
          ([key, value]) =>
            `<div class="field"><dt>${escapeHtml(titleFromKey(key))}</dt><dd>${escapeHtml(value)}</dd></div>`,
        )
        .join("");

      return `<article><h3>Record ${index + 1}</h3><dl>${fields}</dl></article>`;
    })
    .join("");

  return `<section><h2>${escapeHtml(title)}</h2>${cards}</section>`;
}

export function buildDanceFlowAccountHtmlReport(
  payload: Awaited<ReturnType<typeof buildDanceFlowAccountExport>>,
) {
  const sections: Array<[string, keyof typeof payload.data]> = [
    ["Profile", "profiles"],
    ["Dancer Profile", "dancer_profiles"],
    ["Partner Profile", "dancer_partner_profiles"],
    ["Connected Studios", "client_account_links"],
    ["Event Registrations", "event_registrations"],
    ["Favorites", "user_favorites"],
    ["Notification Preferences", "mobile_notification_preferences"],
    ["Push Notification Devices", "mobile_push_tokens"],
    ["Notification History", "mobile_notification_log"],
    ["Legal Agreement History", "legal_agreement_acceptances"],
    ["Account Status", "user_account_status"],
  ];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>DanceFlow Account Data</title>
<style>
  :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; background: #f8fafc; color: #0f172a; }
  main { max-width: 920px; margin: 0 auto; padding: 40px 20px 64px; }
  header { background: linear-gradient(135deg, #ede9fe, #e0f2fe); border: 1px solid #c4b5fd; border-radius: 24px; padding: 28px; }
  h1 { margin: 0 0 8px; font-size: 32px; }
  h2 { margin: 0 0 16px; font-size: 22px; }
  h3 { margin: 0 0 14px; font-size: 16px; }
  section { margin-top: 24px; background: white; border: 1px solid #e2e8f0; border-radius: 20px; padding: 22px; }
  article { border-top: 1px solid #e2e8f0; padding-top: 18px; margin-top: 18px; }
  article:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
  dl { margin: 0; }
  .field { display: grid; grid-template-columns: minmax(180px, 0.45fr) 1fr; gap: 16px; padding: 9px 0; }
  dt { font-weight: 700; color: #475569; }
  dd { margin: 0; overflow-wrap: anywhere; }
  .meta { color: #475569; line-height: 1.7; }
  .empty { color: #64748b; }
  ul { margin-bottom: 0; line-height: 1.7; }
  @media print { body { background: white; } main { max-width: none; padding: 0; } section, header { break-inside: avoid; } }
  @media (max-width: 640px) { .field { grid-template-columns: 1fr; gap: 4px; } }
</style>
</head>
<body>
<main>
<header>
  <h1>DanceFlow Account Data</h1>
  <div class="meta">
    <div><strong>Account:</strong> ${escapeHtml(payload.account.email)}</div>
    <div><strong>Generated:</strong> ${escapeHtml(payload.generatedAt)}</div>
  </div>
</header>
${sections.map(([label, key]) => rowsToHtml(label, payload.data[key] as unknown[])).join("")}
<section>
  <h2>Notes</h2>
  <ul>${payload.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>
</section>
</main>
</body>
</html>`;
}
