/**
 * Micro-dollar price helpers. Pure and client-safe: NO server-only import, so a client component (the hardware-key signing screen) can use them.
 */

/** The kinds that are priced per segment and may carry a sub-cent price in micro-dollars (1 dollar = 1,000,000). Every other kind is whole cents. */
export const MICRO_PRICE_KINDS: readonly string[] = ["sms_usage", "sms_inbound"];
export const isMicroPriceKind = (kind: string): boolean => MICRO_PRICE_KINDS.includes(kind);

/** Micro-dollars to dollar text: 17000 to "$0.017", 20000 to "$0.020" (trailing zeros kept to three places, more only when they matter). */
export function microsToUsd(m: number | null): string {
  if (m === null || !Number.isFinite(m)) return "none";
  const s = (m / 1_000_000).toFixed(6).replace(/0+$/, "");
  const [whole, frac = ""] = s.split(".");
  return `$${whole}.${frac.padEnd(3, "0")}`;
}

/** Dollar text to whole micro-dollars ("0.017" to 17000); null unless a positive amount with at most six decimals up to $10.000000. */
export function usdToMicros(raw: string): number | null {
  const m = /^(\d{1,2})(?:\.(\d{1,6}))?$/.exec(raw.trim());
  if (!m) return null;
  const v = Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
  return v >= 1 && v <= 10_000_000 ? v : null;
}
