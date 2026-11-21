/**
 * Website Embeds: class description and price, from public_group_class_extras (migration 20270216090000).
 *
 * The database applies every rule (class is public, studio is public, the studio turned the matching setting on, a price only when
 * the registration flow would charge it), so this module only parses and formats. If the function is not installed yet or errors, the
 * embed simply shows no description or price: that is a missing extra, never a wrong one.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export type ClassExtra = { description: string | null; priceLabel: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "$25", "$25.50". Whole dollars drop the cents. Anything that is not a positive finite number yields null. */
export function formatClassPrice(amount: unknown): string | null {
  const n = typeof amount === "number" ? amount : typeof amount === "string" ? Number(amount) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return null;
  const whole = Math.abs(n - Math.round(n)) < 0.005;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(n);
}

export function parseClassExtras(rows: unknown): Map<string, ClassExtra> {
  const map = new Map<string, ClassExtra>();
  if (!Array.isArray(rows)) return map;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    if (typeof r.appointment_id !== "string" || !UUID.test(r.appointment_id)) continue;
    const description = typeof r.description === "string" ? r.description.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, 2000) : "";
    map.set(r.appointment_id, { description: description || null, priceLabel: formatClassPrice(r.price_amount) });
  }
  return map;
}

export async function fetchClassExtras(supabase: SupabaseClient, studioSlug: string, appointmentIds: string[]): Promise<Map<string, ClassExtra>> {
  const ids = [...new Set(appointmentIds.filter((id) => UUID.test(id)))].slice(0, 100);
  if (ids.length === 0) return new Map();
  try {
    const { data, error } = await supabase.rpc("public_group_class_extras", { p_studio_slug: studioSlug, p_appointment_ids: ids });
    return error ? new Map() : parseClassExtras(data);
  } catch {
    return new Map();
  }
}
