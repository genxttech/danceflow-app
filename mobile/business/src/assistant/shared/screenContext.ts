// GENERATED from mobile/shared/assistant/ by mobile/shared/sync-assistant.js. Do not edit here; edit the source and re-run.
import type { AssistantConfig, EntityIdKind, ScreenContext, ScreenSpec } from "./types";

/*
  Screen context sanitizer. A screen reports { screenId, entityIds }; the client NEVER sends names, emails, amounts or free text.
  This is a minimal-disclosure filter, not authorization: the server re-authorizes every id (see docs/mobile/assistant/A1_Design.md).
*/

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

export function isEntityId(kind: EntityIdKind, value: unknown): value is string {
  if (typeof value !== "string") return false;
  return kind === "uuid" ? UUID.test(value) : SLUG.test(value);
}

export function findScreen(config: AssistantConfig, screenId: string | null | undefined): ScreenSpec | null {
  if (!screenId) return null;
  return config.screens.find((s) => s.id === screenId) ?? null;
}

/**
 * Returns the context the assistant may use, or null when the screen is not on the allow-list. Unknown entity keys and malformed values are
 * dropped (the screen is still reported, without them); a spec key with a bad value is dropped, never repaired.
 */
export function sanitizeScreenContext(config: AssistantConfig, raw: unknown): ScreenContext | null {
  if (!raw || typeof raw !== "object") return null;
  const input = raw as { screenId?: unknown; entityIds?: unknown };
  if (typeof input.screenId !== "string") return null;
  const spec = findScreen(config, input.screenId);
  if (!spec) return null;

  const entityIds: Record<string, string> = {};
  const allowed = spec.entities ?? {};
  if (input.entityIds && typeof input.entityIds === "object") {
    for (const [key, value] of Object.entries(input.entityIds as Record<string, unknown>)) {
      const kind = Object.prototype.hasOwnProperty.call(allowed, key) ? allowed[key] : undefined;
      if (kind && isEntityId(kind, value)) entityIds[key] = value;
    }
  }
  return Object.keys(entityIds).length ? { screenId: spec.id, entityIds } : { screenId: spec.id };
}

export function sameContext(a: ScreenContext | null, b: ScreenContext | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.screenId !== b.screenId) return false;
  const x = a.entityIds ?? {};
  const y = b.entityIds ?? {};
  const keys = Object.keys(x);
  return keys.length === Object.keys(y).length && keys.every((k) => x[k] === y[k]);
}
