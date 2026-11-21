import { NextResponse } from "next/server";
import { requireStaffApi, type StaffApiContext } from "@/lib/auth/staffApiAuth";

/**
 * Write guard for the Business staff API (Business expansion plan, Phase 0, P0-1).
 *
 *   const guard = await requireStaffWrite(request, studioId, "clientNotes");
 *   if (!guard.ok) return guard.response;
 *
 * = requireStaffApi (bearer identity, membership, account status, rate limits) + a per-capability kill switch + a minimum-app-version gate.
 * Reads never call this and are never affected by it. The attendance route that shipped in v0.1 (PUT .../attendance/{clientId}) predates the
 * gate and is not behind it: those builds send no version header, so gating that route would break them (a later, separate decision).
 *
 * POLICY SOURCE (no migration): one JSON environment variable, STAFF_API_WRITE_POLICY, read on every request.
 *
 *   { "enabled": ["clientNotes", "classRoster"],
 *     "minimumCode": { "android": 2, "ios": 0 },        // optional; absent or 0 = no minimum for that platform
 *     "blockedCodes": { "android": [1], "ios": [] } }   // optional; a build code listed here is refused
 *
 * FAIL CLOSED: the variable unset, empty, not JSON, not an object, with a malformed field, or with the capability not listed in "enabled" means
 * that write is DISABLED (403 writes_disabled). Only an explicit listed capability enables a write. A malformed "minimumCode" / "blockedCodes"
 * disables every write rather than being guessed at, so a typo can never loosen the gate. Changing the variable needs a redeploy (as for every
 * other server setting); to switch writes off in an emergency, remove the variable or set it to {"enabled": []} and redeploy or roll back.
 *
 * VERSION HEADER (decided here; Student_Min_Version_And_Kill_Switch_Design.md is fail-OPEN for reads, this is for writes and is fail-CLOSED):
 *   X-DanceFlow-App: business/<versionName>/<versionCode>/<android|ios>      e.g. business/0.2.0/3/android
 * A write with a missing or malformed header, another app id, an unknown platform, a non-integer code, a code below the platform's minimum or a
 * blocked code is refused 426 upgrade_required. Rationale: every write capability ships only in builds new enough to send the header, so a client
 * without it is by definition an old or foreign client that cannot be trusted to handle the write contract. (Student reads stay fail-open.)
 *
 * ORDER: requireStaffApi first (401/403 identity, membership and pause refusals win; the rate limiter counts the request), then the kill switch
 * (403 writes_disabled), then the version gate (426 upgrade_required). A disabled capability therefore never reveals itself to an unauthenticated caller.
 */

export const STAFF_WRITE_CAPABILITIES = ["appointmentAttendance", "clientNotes", "clientCreate", "classRoster"] as const;
export type StaffWriteCapability = (typeof STAFF_WRITE_CAPABILITIES)[number];

export type StaffWriteErrorCode = "writes_disabled" | "upgrade_required";

type Platform = "android" | "ios";
export type StaffWritePolicy = {
  enabled: ReadonlySet<StaffWriteCapability>;
  minimumCode: Record<Platform, number>;
  blockedCodes: Record<Platform, ReadonlySet<number>>;
};

export type StaffWriteGuardResult = { ok: false; response: Response } | ({ ok: true } & StaffApiContext);

export const APP_HEADER = "x-danceflow-app";
const HEADER_PATTERN = /^business\/([0-9A-Za-z][0-9A-Za-z._+-]{0,31})\/(\d{1,9})\/(android|ios)$/;
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PLATFORMS: readonly Platform[] = ["android", "ios"];

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 2_000_000_000;

/** Parses the policy variable. Returns null when it cannot be trusted: the caller treats null as "every write disabled". */
export function parseStaffWritePolicy(raw: string | undefined | null): StaffWritePolicy | null {
  if (!raw || !raw.trim()) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (!Array.isArray(record.enabled)) return null;
  const enabled = new Set<StaffWriteCapability>();
  for (const item of record.enabled) {
    if (typeof item !== "string") return null;
    if ((STAFF_WRITE_CAPABILITIES as readonly string[]).includes(item)) enabled.add(item as StaffWriteCapability);
    // an unknown word is ignored (a newer config than this server), it never enables anything
  }

  const minimumCode: Record<Platform, number> = { android: 0, ios: 0 };
  if (record.minimumCode !== undefined) {
    if (record.minimumCode === null || typeof record.minimumCode !== "object" || Array.isArray(record.minimumCode)) return null;
    for (const platform of PLATFORMS) {
      const entry = (record.minimumCode as Record<string, unknown>)[platform];
      if (entry === undefined) continue;
      if (!isInt(entry)) return null;
      minimumCode[platform] = entry;
    }
  }

  const blockedCodes: Record<Platform, Set<number>> = { android: new Set(), ios: new Set() };
  if (record.blockedCodes !== undefined) {
    if (record.blockedCodes === null || typeof record.blockedCodes !== "object" || Array.isArray(record.blockedCodes)) return null;
    for (const platform of PLATFORMS) {
      const entry = (record.blockedCodes as Record<string, unknown>)[platform];
      if (entry === undefined) continue;
      if (!Array.isArray(entry) || !entry.every(isInt)) return null;
      for (const code of entry) blockedCodes[platform].add(code);
    }
  }

  return { enabled, minimumCode, blockedCodes };
}

export type ParsedAppHeader = { version: string; code: number; platform: Platform };

export function parseAppHeader(value: string | null | undefined): ParsedAppHeader | null {
  if (!value) return null;
  const match = HEADER_PATTERN.exec(value.trim());
  if (!match) return null;
  const code = Number(match[2]);
  if (!isInt(code)) return null;
  return { version: match[1], code, platform: match[3] as Platform };
}

export type WriteGateDecision = { allowed: true } | { allowed: false; code: StaffWriteErrorCode; message: string };

/** Pure decision: policy (null = untrusted) + capability + the raw header value. */
export function evaluateWriteGate(params: {
  policy: StaffWritePolicy | null;
  capability: StaffWriteCapability;
  appHeader: string | null | undefined;
}): WriteGateDecision {
  const { policy, capability, appHeader } = params;
  if (!policy || !policy.enabled.has(capability)) {
    return { allowed: false, code: "writes_disabled", message: "This change is turned off right now. Try again later." };
  }
  const app = parseAppHeader(appHeader);
  const upgrade: WriteGateDecision = { allowed: false, code: "upgrade_required", message: "Update DanceFlow Business to make this change." };
  if (!app) return upgrade;
  if (app.code < policy.minimumCode[app.platform]) return upgrade;
  if (policy.blockedCodes[app.platform].has(app.code)) return upgrade;
  return { allowed: true };
}

function writeGuardError(code: StaffWriteErrorCode, message: string) {
  return NextResponse.json(
    { error: message, code },
    { status: code === "upgrade_required" ? 426 : 403, headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function requireStaffWrite(
  request: Request,
  studioId: string,
  capability: StaffWriteCapability,
): Promise<StaffWriteGuardResult> {
  if (!(STAFF_WRITE_CAPABILITIES as readonly string[]).includes(capability)) {
    // a programming error in a route: fail closed rather than let an unknown key through
    return { ok: false, response: writeGuardError("writes_disabled", "This change is turned off right now. Try again later.") };
  }

  const guard = await requireStaffApi(request, studioId);
  if (!guard.ok) return { ok: false, response: guard.response };

  // Reads are never gated. A route that calls this for a GET is a mistake, but it must not lock reads out.
  if (!WRITE_METHODS.has(request.method.toUpperCase())) return guard;

  const decision = evaluateWriteGate({
    policy: parseStaffWritePolicy(process.env.STAFF_API_WRITE_POLICY),
    capability,
    appHeader: request.headers.get(APP_HEADER),
  });
  if (!decision.allowed) return { ok: false, response: writeGuardError(decision.code, decision.message) };

  return guard;
}
