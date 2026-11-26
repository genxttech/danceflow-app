import type { AssistantConfig, SuggestedPrompt } from "./shared/types";
import type { StubRule } from "./shared/stubResponder";

/*
  LUMI: the Dancer app's assistant (discovery, learning, events, personal progress). Identity lives here; the engine is shared.
  A1 ships a local stub only: no network, no actions. Every link target is an existing READ route.
  (The older template screen app/lumi.tsx is separate and unchanged.)
*/

const DEFAULT_PROMPTS: readonly SuggestedPrompt[] = [
  { id: "what-can-you-do", text: "What can you help me with?" },
  { id: "find-events", text: "Where can I find dance events?" },
];

const BY_SCREEN: Record<string, readonly SuggestedPrompt[]> = {
  today: [{ id: "today-next", text: "What's coming up for me?" }, DEFAULT_PROMPTS[1]],
  schedule: [{ id: "schedule-next", text: "How do I read my schedule?" }, DEFAULT_PROMPTS[1]],
  "event-detail": [{ id: "event-what", text: "What should I know before going to this event?" }, DEFAULT_PROMPTS[0]],
  wallet: [{ id: "wallet-what", text: "What's in my wallet?" }, DEFAULT_PROMPTS[0]],
  "events-list": [{ id: "events-pick", text: "How do I pick an event that suits me?" }, DEFAULT_PROMPTS[0]],
};

export const lumiConfig: AssistantConfig = {
  id: "lumi",
  name: "LUMI",
  tone: "warm",
  avatarInitials: "LU",
  introText: "Hi, I'm LUMI, your dance guide. This is a preview: I'm not connected yet, so my answers are placeholders.",
  disclaimer: "LUMI can't book, pay or change anything for you. Check details in the app before you act on a suggestion.",
  capabilities: [
    { id: "discover", label: "Help you find events and studios" },
    { id: "learn", label: "Explain your lessons and progress" },
    { id: "navigate", label: "Point you to the right screen" },
  ],
  flagKey: "lumiAssistant",
  screens: [
    { id: "today", label: "Today" },
    { id: "schedule", label: "Schedule" },
    { id: "event-detail", label: "Event", entities: { eventId: "uuid" } },
    { id: "wallet", label: "Wallet" },
    { id: "events-list", label: "Events" },
  ],
  deepLinks: [
    { id: "today", template: "/home" },
    { id: "schedule", template: "/schedule" },
    { id: "wallet", template: "/wallet" },
    { id: "events", template: "/discover/events" },
    { id: "event", template: "/events/[id]", params: { id: "uuid" } },
  ],
  promptsForScreen: (screenId) => (screenId ? BY_SCREEN[screenId] ?? DEFAULT_PROMPTS : DEFAULT_PROMPTS),
};

export const lumiStubRules: readonly StubRule[] = [
  { words: ["event", "dance", "social"], reply: { text: "The Events list shows what's on near you. (Preview answer.)", links: [{ target: "events", label: "Browse events" }] } },
  { words: ["wallet", "ticket", "package", "pass"], reply: { text: "Your Wallet holds your passes, packages and tickets. (Preview answer.)", links: [{ target: "wallet", label: "Open Wallet" }] } },
  { words: ["schedule", "lesson", "class", "coming up", "next"], reply: { text: "Your Schedule lists your upcoming lessons and classes. (Preview answer.)", links: [{ target: "schedule", label: "Open Schedule" }] } },
];

export const LUMI_STUB_FALLBACK = "I'm a preview and can't answer that yet. Try asking about events, your wallet or your schedule.";
