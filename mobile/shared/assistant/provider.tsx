import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { conversationReducer, emptyConversation, historyBefore, questionFor, type ConversationState } from "./reducer";
import { resolveReplyLinks } from "./links";
import { findScreen, sanitizeScreenContext } from "./screenContext";
import {
  AssistantError,
  type AssistantConfig,
  type AssistantMessage,
  type AssistantResponder,
  type ScreenContext,
  type SuggestedPrompt,
} from "./types";

/*
  The assistant state provider. Mount it ABOVE the navigator so the conversation survives navigation, and key it by user id so a sign-out
  or user switch drops it (in-memory only: nothing is persisted in A1). It does no I/O of its own: the responder is injected.
*/

export type SheetMode = "closed" | "sheet" | "full";

export const DEFAULT_TIMEOUT_MS = 20000;
export const MAX_MESSAGE_LENGTH = 1000;

export interface AssistantApi {
  readonly config: AssistantConfig;
  readonly messages: readonly AssistantMessage[];
  readonly busy: boolean;
  readonly mode: SheetMode;
  readonly open: boolean;
  readonly context: ScreenContext | null;
  readonly screenLabel: string | null;
  readonly suggestions: readonly SuggestedPrompt[];
  /** true while a screen/sheet has asked the launcher to step aside (modal, other sheet). */
  readonly suppressed: boolean;
  send(text: string): void;
  retry(messageId: string): void;
  /** Cancels the in-flight request; its placeholder is removed. */
  cancel(): void;
  /** Empties the thread and cancels any request. The sheet stays as it was. */
  clear(): void;
  setMode(mode: SheetMode): void;
  /** Registers a suppression reason; returns the release function. */
  suppress(): () => void;
  registerScreen(raw: unknown): () => void;
}

const Context = createContext<AssistantApi | null>(null);

let counter = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export function AssistantProvider({
  config,
  responder,
  children,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
}: {
  config: AssistantConfig;
  responder: AssistantResponder;
  children: ReactNode;
  timeoutMs?: number;
  now?: () => number;
}) {
  const [state, dispatch] = useReducer(conversationReducer, undefined, () => emptyConversation(nextId("conv")));
  const [mode, setModeState] = useState<SheetMode>("closed");
  const [suppressCount, setSuppressCount] = useState(0);
  const [screens, setScreens] = useState<{ key: number; context: ScreenContext }[]>([]);

  const stateRef = useRef<ConversationState>(state);
  // Refs are synced after each commit (not during render); the handlers below run after a commit.
  useEffect(() => {
    stateRef.current = state;
  });
  const controller = useRef<AbortController | null>(null);
  const screenKey = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  // The most recently registered live screen wins (a modal over a tab reports itself; closing it restores the tab).
  const context = screens.length ? screens[screens.length - 1].context : null;
  const contextRef = useRef<ScreenContext | null>(context);
  useEffect(() => {
    contextRef.current = context;
  });

  const run = useCallback(
    (pendingId: string, questionId: string, message: string, messages: readonly AssistantMessage[]) => {
      controller.current?.abort();
      const abort = new AbortController();
      controller.current = abort;
      const ctx = contextRef.current;
      responder
        .respond(
          {
            assistant: config.id,
            conversationId: stateRef.current.conversationId,
            message,
            context: ctx,
            history: historyBefore(messages, questionId),
          },
          { signal: abort.signal, timeoutMs },
        )
        .then(
          (reply) => {
            if (abort.signal.aborted || !mounted.current) return;
            const resolved = resolveReplyLinks(config, typeof reply?.text === "string" ? reply.text : "", reply?.links);
            dispatch({ type: "reply", pendingId, text: resolved.text, links: resolved.links, at: now() });
          },
          (error: unknown) => {
            if (abort.signal.aborted || !mounted.current) return;
            const kind = error instanceof AssistantError ? error.kind : "unknown";
            dispatch({ type: "fail", pendingId, kind, at: now() });
          },
        );
    },
    [config, responder, timeoutMs, now],
  );

  const send = useCallback(
    (raw: string) => {
      const text = raw.trim().slice(0, MAX_MESSAGE_LENGTH);
      if (!text || stateRef.current.pendingId) return;
      const at = now();
      const user: AssistantMessage = { id: nextId("u"), role: "user", text, createdAt: at, status: "sent" };
      const pending: AssistantMessage = { id: nextId("a"), role: "assistant", text: "", createdAt: at, status: "pending" };
      const messages = [...stateRef.current.messages, user, pending];
      dispatch({ type: "send", user, pending });
      run(pending.id, user.id, text, messages);
    },
    [now, run],
  );

  const retry = useCallback(
    (messageId: string) => {
      const current = stateRef.current;
      const question = questionFor(current.messages, messageId);
      const failed = current.messages.find((m) => m.id === messageId);
      if (!question || !failed || failed.status !== "error" || current.pendingId) return;
      const pending: AssistantMessage = { id: nextId("a"), role: "assistant", text: "", createdAt: now(), status: "pending" };
      const messages = current.messages.map((m) => (m.id === messageId ? pending : m));
      dispatch({ type: "retry", failedId: messageId, pending });
      run(pending.id, question.id, question.text, messages);
    },
    [now, run],
  );

  const cancel = useCallback(() => {
    const pendingId = stateRef.current.pendingId;
    if (!pendingId) return;
    controller.current?.abort();
    dispatch({ type: "cancel", pendingId });
  }, []);

  const clear = useCallback(() => {
    controller.current?.abort();
    dispatch({ type: "clear", conversationId: nextId("conv") });
  }, []);

  const registerScreen = useCallback(
    (raw: unknown) => {
      const clean = sanitizeScreenContext(config, raw);
      if (!clean) return () => undefined;
      const key = ++screenKey.current;
      setScreens((list) => [...list, { key, context: clean }]);
      return () => setScreens((list) => list.filter((s) => s.key !== key));
    },
    [config],
  );

  const suppress = useCallback(() => {
    setSuppressCount((n) => n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      setSuppressCount((n) => Math.max(0, n - 1));
    };
  }, []);

  const spec = findScreen(config, context?.screenId);
  const suggestions = useMemo(() => config.promptsForScreen(context?.screenId ?? null), [config, context?.screenId]);

  const value = useMemo<AssistantApi>(
    () => ({
      config,
      messages: state.messages,
      busy: state.pendingId !== null,
      mode,
      open: mode !== "closed",
      context,
      screenLabel: spec?.label ?? null,
      suggestions,
      suppressed: suppressCount > 0,
      send,
      retry,
      cancel,
      clear,
      setMode: setModeState,
      suppress,
      registerScreen,
    }),
    [config, state.messages, state.pendingId, mode, context, spec?.label, suggestions, suppressCount, send, retry, cancel, clear, suppress, registerScreen],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** The assistant API, or null when no provider is mounted (flag off): screens may call this unconditionally. */
export function useAssistantOptional(): AssistantApi | null {
  return useContext(Context);
}

export function useAssistant(): AssistantApi {
  const api = useContext(Context);
  if (!api) throw new Error("useAssistant must be used inside an AssistantProvider");
  return api;
}

/**
 * A screen registers its descriptor while mounted. Inert when the assistant is off (no provider). Pass `null` to register nothing
 * (e.g. while its entity id is still loading). `ctx` is compared by value, so an inline object does not re-register every render.
 */
export function useAssistantScreen(ctx: { screenId: string; entityIds?: Record<string, string> } | null): void {
  const api = useAssistantOptional();
  const register = api?.registerScreen;
  // Keyed by value so an inline object does not re-register every render.
  const key = ctx ? JSON.stringify({ s: ctx.screenId, e: ctx.entityIds ?? null }) : null;
  useEffect(() => {
    if (!register || !key) return undefined;
    const parsed = JSON.parse(key) as { s: string; e: Record<string, string> | null };
    return register({ screenId: parsed.s, entityIds: parsed.e ?? undefined });
  }, [register, key]);
}

/** While mounted (and `active`), asks the launcher to step aside: a modal or another sheet is up. Inert with no provider. */
export function useAssistantSuppressed(active: boolean): void {
  const suppress = useAssistantOptional()?.suppress;
  useEffect(() => {
    if (!suppress || !active) return undefined;
    return suppress();
  }, [suppress, active]);
}
