/*
  Shared assistant types (LUMI in the Dancer app, ARIA in the Business app). SOURCE OF TRUTH: mobile/shared/assistant/.
  Each app holds a byte-identical copy under src/assistant/shared/ (run `node mobile/shared/sync-assistant.js`), and a parity
  test in each app fails if a copy drifts. Pure TypeScript: no react-native, expo or network imports, so it type-checks and
  runs anywhere. See docs/mobile/assistant/A1_Design.md.

  Trust model: everything the CLIENT sends about where the user is (ScreenContext) is a hint, never an authorization.
  The server (A2) must re-authorize every id against the signed-in user and must never act on client context alone.
*/

export type AssistantId = "lumi" | "aria";

// ---------------------------------------------------------------------------------------------------------------------
// Messages

export type MessageRole = "user" | "assistant";

/** "pending" is the placeholder shown while the responder runs; "error" keeps the text so Retry can resend it. */
export type MessageStatus = "sent" | "pending" | "error";

/** A suggestion link as the RESPONDER names it: a whitelisted target id plus params, never a raw path or URL. */
export interface AssistantLinkRequest {
  readonly target: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly label: string;
}

/** A link that passed the whitelist: `href` was built from a known template, `label` is plain text. */
export interface ResolvedLink {
  readonly target: string;
  readonly href: string;
  readonly label: string;
}

export interface AssistantMessage {
  readonly id: string;
  readonly role: MessageRole;
  readonly text: string;
  readonly createdAt: number;
  readonly status: MessageStatus;
  /** Only whitelist-resolved links are stored; rejected ones were folded into `text` by the engine. */
  readonly links?: readonly ResolvedLink[];
  readonly errorKind?: AssistantErrorKind;
}

// ---------------------------------------------------------------------------------------------------------------------
// Screen context (client-reported, UNTRUSTED)

export type EntityIdKind = "uuid" | "slug";

/** What a screen may report: its id from the assistant's allow-list, plus ids (never names, emails, amounts, free text). */
export interface ScreenContext {
  readonly screenId: string;
  readonly entityIds?: Readonly<Record<string, string>>;
}

export interface ScreenSpec {
  readonly id: string;
  /** Plain-language name used in the sheet header ("Appointment", "Your wallet"). Never includes entity data. */
  readonly label: string;
  /** The entity id keys this screen may report, and the shape each must have. Keys not listed are dropped. */
  readonly entities?: Readonly<Record<string, EntityIdKind>>;
  /** Ids of config suggestion prompts shown on the empty state for this screen. */
  readonly suggestedPromptIds?: readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Deep links (whitelist of existing app routes)

export interface DeepLinkSpec {
  readonly id: string;
  /** Existing expo-router path with `[param]` placeholders, e.g. "/events/[id]". The app tests that it names a real route file. */
  readonly template: string;
  readonly params?: Readonly<Record<string, EntityIdKind>>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Responder (the seam A2 plugs into)

export type AssistantErrorKind = "timeout" | "network" | "unavailable" | "rate_limited" | "refused" | "unknown";

export class AssistantError extends Error {
  readonly kind: AssistantErrorKind;
  constructor(kind: AssistantErrorKind, message?: string) {
    super(message ?? kind);
    this.name = "AssistantError";
    this.kind = kind;
  }
}

/** What goes to a responder. A2's server adapter must send only this, and the server treats `context` as untrusted. */
export interface AssistantRequest {
  readonly assistant: AssistantId;
  readonly conversationId: string;
  readonly message: string;
  /** The sanitized screen context at send time, or null when none was registered. */
  readonly context: ScreenContext | null;
  /** Recent turns (bounded by the engine), oldest first, errored and pending messages excluded. */
  readonly history: readonly { readonly role: MessageRole; readonly text: string }[];
}

export interface AssistantReply {
  readonly text: string;
  readonly links?: readonly AssistantLinkRequest[];
}

export interface AssistantRespondOptions {
  /** Aborted when the user cancels, the sheet is cleared, or the user switches. Responders must stop and reject. */
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

/**
 * Async, cancellable. Rejects with AssistantError (any other rejection is treated as "unknown"). A rejection after `signal`
 * aborts is ignored by the engine. A1 ships only a local deterministic stub; A2 supplies a server-backed one.
 */
export interface AssistantResponder {
  respond(request: AssistantRequest, options: AssistantRespondOptions): Promise<AssistantReply>;
}

// ---------------------------------------------------------------------------------------------------------------------
// Per-assistant configuration (identity is data; the engine is shared)

export interface SuggestedPrompt {
  readonly id: string;
  readonly text: string;
}

/** Capabilities are descriptive in A1 (shown in the intro/about text); they gate nothing until A2's server enforces them. */
export interface AssistantCapability {
  readonly id: string;
  readonly label: string;
}

export interface AssistantConfig {
  readonly id: AssistantId;
  /** "LUMI" / "ARIA": the only place the name is spelled for UI strings. */
  readonly name: string;
  /** One-word tone note for copy review and the stub ("warm", "concise"); not interpreted by code. */
  readonly tone: string;
  /** Initials shown in the launcher/avatar when no image asset is supplied. */
  readonly avatarInitials: string;
  readonly introText: string;
  readonly disclaimer: string;
  readonly capabilities: readonly AssistantCapability[];
  readonly screens: readonly ScreenSpec[];
  readonly deepLinks: readonly DeepLinkSpec[];
  /** Prompts for a screen id; an unknown or null screen gets `defaultPrompts`. */
  readonly promptsForScreen: (screenId: string | null) => readonly SuggestedPrompt[];
  /** Name of the feature flag that gates this assistant (documentation + tests; the app owns the actual read). */
  readonly flagKey: string;
}
