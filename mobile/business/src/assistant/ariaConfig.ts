import type { AssistantConfig, SuggestedPrompt } from "./shared/types";
import type { StubRule } from "./shared/stubResponder";

/*
  ARIA: the Business app's studio-operations assistant. Identity lives here (name, tone, capabilities, screens, links); the engine is shared.
  A1 ships a local stub only: no network, no actions. Every link target is an existing READ route; no write route is a target.
*/

const DEFAULT_PROMPTS: readonly SuggestedPrompt[] = [
  { id: "what-can-you-do", text: "What can you help me with?" },
  { id: "today", text: "What should I focus on today?" },
];

const BY_SCREEN: Record<string, readonly SuggestedPrompt[]> = {
  today: [{ id: "today-focus", text: "What needs attention in today's schedule?" }, ...DEFAULT_PROMPTS.slice(0, 1)],
  "client-detail": [{ id: "client-next", text: "What should I follow up on with this client?" }, ...DEFAULT_PROMPTS.slice(0, 1)],
  "appointment-detail": [{ id: "appt-prep", text: "How do I prepare for this appointment?" }, ...DEFAULT_PROMPTS.slice(0, 1)],
  pulse: [{ id: "pulse-read", text: "Explain what I'm seeing in Pulse." }, ...DEFAULT_PROMPTS.slice(0, 1)],
  clients: [{ id: "clients-find", text: "How do I find a client quickly?" }, ...DEFAULT_PROMPTS.slice(0, 1)],
};

export const ariaConfig: AssistantConfig = {
  id: "aria",
  name: "ARIA",
  tone: "concise",
  avatarInitials: "AR",
  introText: "Hi, I'm ARIA, your studio assistant. This is a preview: I'm not connected yet, so my answers are placeholders.",
  disclaimer: "ARIA can't change anything in your studio. Check details in the app before you act on a suggestion.",
  capabilities: [
    { id: "explain", label: "Explain what you see on a screen" },
    { id: "navigate", label: "Point you to the right screen" },
  ],
  flagKey: "ariaAssistant",
  screens: [
    { id: "today", label: "Today" },
    { id: "client-detail", label: "Client", entities: { clientId: "uuid", studioId: "uuid" } },
    { id: "appointment-detail", label: "Appointment", entities: { appointmentId: "uuid", studioId: "uuid" } },
    { id: "pulse", label: "Pulse" },
    { id: "clients", label: "Clients" },
  ],
  deepLinks: [
    { id: "today", template: "/today" },
    { id: "pulse", template: "/pulse" },
    { id: "clients", template: "/clients" },
    { id: "client", template: "/clients/[id]?studioId=[studioId]", params: { id: "uuid", studioId: "uuid" } },
    { id: "appointment", template: "/appointments/[id]?studioId=[studioId]", params: { id: "uuid", studioId: "uuid" } },
  ],
  promptsForScreen: (screenId) => (screenId ? BY_SCREEN[screenId] ?? DEFAULT_PROMPTS : DEFAULT_PROMPTS),
};

export const ariaStubRules: readonly StubRule[] = [
  { words: ["pulse"], reply: { text: "Pulse summarizes how the studio is doing. (Preview answer.)", links: [{ target: "pulse", label: "Open Pulse" }] } },
  { words: ["client", "find"], reply: { text: "The Clients tab lists and searches your clients. (Preview answer.)", links: [{ target: "clients", label: "Open Clients" }] } },
  { words: ["today", "schedule", "focus"], reply: { text: "Today shows your day's schedule. (Preview answer.)", links: [{ target: "today", label: "Open Today" }] } },
];

export const ARIA_STUB_FALLBACK = "I'm a preview and can't answer that yet. Try asking about Today, Clients or Pulse.";
