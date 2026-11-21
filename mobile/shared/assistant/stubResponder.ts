import { AssistantError, type AssistantErrorKind, type AssistantReply, type AssistantRequest, type AssistantRespondOptions, type AssistantResponder } from "./types";

/*
  Deterministic local stub. No network, no storage, no randomness: the same request gives the same reply. A2 replaces it with a
  server-backed AssistantResponder. `rules` let each app's config supply its own canned answers (and links) keyed on screen and words.
*/

export interface StubRule {
  readonly screenId?: string;
  readonly words?: readonly string[];
  readonly reply: AssistantReply;
}

export interface StubOptions {
  readonly rules?: readonly StubRule[];
  readonly fallback: string;
  readonly delayMs?: number;
  /** Test hook: reject every request (or only the Nth, 1-based, with failOnCall) with this kind. */
  readonly failWith?: AssistantErrorKind;
  readonly failOnCall?: number;
}

export interface StubResponder extends AssistantResponder {
  readonly calls: number;
}

export function createStubResponder(options: StubOptions): StubResponder {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    respond(request: AssistantRequest, { signal, timeoutMs }: AssistantRespondOptions): Promise<AssistantReply> {
      calls += 1;
      const call = calls;
      return new Promise<AssistantReply>((resolve, reject) => {
        if (signal.aborted) return reject(new AssistantError("unknown", "aborted"));
        let timer: ReturnType<typeof setTimeout> | undefined;
        let limit: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
          if (timer) clearTimeout(timer);
          if (limit) clearTimeout(limit);
          signal.removeEventListener("abort", onAbort);
        };
        const onAbort = () => {
          finish();
          reject(new AssistantError("unknown", "aborted"));
        };
        signal.addEventListener("abort", onAbort);
        limit = setTimeout(() => {
          finish();
          reject(new AssistantError("timeout"));
        }, timeoutMs);
        timer = setTimeout(() => {
          finish();
          if (options.failWith && (options.failOnCall === undefined || options.failOnCall === call)) return reject(new AssistantError(options.failWith));
          resolve(pick(options, request));
        }, options.delayMs ?? 0);
      });
    },
  };
}

function pick(options: StubOptions, request: AssistantRequest): AssistantReply {
  const text = request.message.toLowerCase();
  const screen = request.context?.screenId;
  for (const rule of options.rules ?? []) {
    if (rule.screenId && rule.screenId !== screen) continue;
    if (rule.words && !rule.words.some((w) => text.includes(w.toLowerCase()))) continue;
    return rule.reply;
  }
  return { text: options.fallback };
}
