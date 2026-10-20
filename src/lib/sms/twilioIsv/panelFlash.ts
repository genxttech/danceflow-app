/**
 * TW-4F panel result banner. The text travels in a short-lived, httpOnly, same-site cookie written by the server action, never in the URL: a
 * crafted link can therefore not make the platform page show a fake "saved" or fake instructions. The URL only says which kind of result to
 * look for (`?panel=1` / `?panel_error=1`); without the matching cookie nothing is shown.
 */

export const PANEL_FLASH_COOKIE = "tw4_panel_flash";
export const PANEL_FLASH_MAX_AGE_SECONDS = 60;

export function encodePanelFlash(result: { ok: boolean; message: string }): string {
  return JSON.stringify({ ok: result.ok, message: result.message.slice(0, 400) });
}

/** The banner to show, or nothing: the cookie must parse and agree with the kind the URL asks for. */
export function readPanelFlash(raw: string | undefined, query: { panel: string | null; panelError: string | null }): { notice: string | null; error: string | null } {
  const none = { notice: null, error: null };
  if (!raw || (!query.panel && !query.panelError)) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return none;
  }
  const flash = parsed && typeof parsed === "object" ? (parsed as { ok?: unknown; message?: unknown }) : {};
  if (typeof flash.message !== "string" || typeof flash.ok !== "boolean") return none;
  const message = flash.message.slice(0, 400);
  if (flash.ok && query.panel) return { notice: message, error: null };
  if (!flash.ok && query.panelError) return { notice: null, error: message };
  return none;
}

/**
 * Per-request render inputs for the panel, produced once by the page (outside any component): the clock used to judge stale creations, and a fresh
 * one-time request key per studio card for the Create subaccount form (a resubmitted form reuses its own key; a fresh page gets new ones).
 */
export function panelRenderContext(studioIds: string[]): { now: number; requestKeys: Record<string, string> } {
  return { now: Date.now(), requestKeys: Object.fromEntries(studioIds.map((id) => [id, globalThis.crypto.randomUUID()])) };
}
