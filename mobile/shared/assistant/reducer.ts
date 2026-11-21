import type { AssistantErrorKind, AssistantMessage, ResolvedLink } from "./types";

/* Pure conversation state. The provider owns timing and the responder; this owns what the thread looks like. */

export interface ConversationState {
  readonly conversationId: string;
  readonly messages: readonly AssistantMessage[];
  /** Id of the pending assistant placeholder while a request is in flight. */
  readonly pendingId: string | null;
}

export type ConversationAction =
  | { type: "send"; user: AssistantMessage; pending: AssistantMessage }
  | { type: "reply"; pendingId: string; text: string; links: readonly ResolvedLink[]; at: number }
  | { type: "fail"; pendingId: string; kind: AssistantErrorKind; at: number }
  | { type: "cancel"; pendingId: string }
  | { type: "retry"; failedId: string; pending: AssistantMessage }
  | { type: "clear"; conversationId: string };

export const MAX_MESSAGES = 60;

export function emptyConversation(conversationId: string): ConversationState {
  return { conversationId, messages: [], pendingId: null };
}

const cap = (messages: readonly AssistantMessage[]) => (messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : messages);

export function conversationReducer(state: ConversationState, action: ConversationAction): ConversationState {
  switch (action.type) {
    case "send":
      if (state.pendingId) return state; // one request at a time
      return { ...state, messages: cap([...state.messages, action.user, action.pending]), pendingId: action.pending.id };
    case "reply":
      if (state.pendingId !== action.pendingId) return state; // late reply for a cancelled or cleared request
      return {
        ...state,
        pendingId: null,
        messages: state.messages.map((m) =>
          m.id === action.pendingId
            ? { ...m, text: action.text, links: action.links.length ? action.links : undefined, status: "sent", createdAt: action.at }
            : m,
        ),
      };
    case "fail":
      if (state.pendingId !== action.pendingId) return state;
      return {
        ...state,
        pendingId: null,
        messages: state.messages.map((m) => (m.id === action.pendingId ? { ...m, status: "error", errorKind: action.kind, createdAt: action.at } : m)),
      };
    case "cancel":
      if (state.pendingId !== action.pendingId) return state;
      return { ...state, pendingId: null, messages: state.messages.filter((m) => m.id !== action.pendingId) };
    case "retry": {
      if (state.pendingId) return state;
      const failed = state.messages.find((m) => m.id === action.failedId);
      if (!failed || failed.status !== "error") return state;
      // The failed assistant bubble becomes the new pending placeholder.
      return { ...state, pendingId: action.pending.id, messages: state.messages.map((m) => (m.id === action.failedId ? action.pending : m)) };
    }
    case "clear":
      return emptyConversation(action.conversationId);
  }
}

/** The user message a failed or pending assistant message answers: the nearest earlier user message. */
export function questionFor(messages: readonly AssistantMessage[], assistantMessageId: string): AssistantMessage | null {
  const index = messages.findIndex((m) => m.id === assistantMessageId);
  for (let i = index - 1; i >= 0; i--) if (messages[i].role === "user") return messages[i];
  return null;
}

/** History for a request: sent messages only, bounded, oldest first, up to but excluding the user message being answered (beforeId). */
export function historyBefore(messages: readonly AssistantMessage[], beforeId: string, limit = 12): { role: "user" | "assistant"; text: string }[] {
  const index = messages.findIndex((m) => m.id === beforeId);
  const slice = index < 0 ? messages : messages.slice(0, index);
  return slice
    .filter((m) => m.status === "sent")
    .slice(-limit)
    .map((m) => ({ role: m.role, text: m.text }));
}
