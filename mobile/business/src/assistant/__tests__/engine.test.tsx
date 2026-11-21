import { act, renderHook } from "@testing-library/react-native";
import type { ReactNode } from "react";
import { AssistantProvider, useAssistant, useAssistantOptional, useAssistantScreen } from "../shared/provider";
import { createStubResponder } from "../shared/stubResponder";
import { resolveLink, resolveReplyLinks } from "../shared/links";
import { sanitizeScreenContext } from "../shared/screenContext";
import { conversationReducer, emptyConversation } from "../shared/reducer";
import { AssistantError, type AssistantConfig, type AssistantResponder } from "../shared/types";

const ID = "123e4567-e89b-42d3-a456-426614174000";

const config: AssistantConfig = {
  id: "aria",
  name: "TEST",
  tone: "concise",
  avatarInitials: "T",
  introText: "hi",
  disclaimer: "d",
  capabilities: [],
  flagKey: "x",
  screens: [
    { id: "today", label: "Today" },
    { id: "client-detail", label: "Client", entities: { clientId: "uuid" } },
  ],
  deepLinks: [
    { id: "client", template: "/clients/[id]", params: { id: "uuid" } },
    { id: "today", template: "/today" },
  ],
  promptsForScreen: (s) => [{ id: "p", text: s ?? "default" }],
};

describe("sanitizeScreenContext", () => {
  it("accepts an allowed screen and a well-formed id", () => {
    expect(sanitizeScreenContext(config, { screenId: "client-detail", entityIds: { clientId: ID } })).toEqual({ screenId: "client-detail", entityIds: { clientId: ID } });
  });
  it("drops unknown keys, malformed ids and extra fields (names, emails)", () => {
    expect(sanitizeScreenContext(config, { screenId: "client-detail", entityIds: { clientId: "not-a-uuid", email: "a@b.c", name: "Pat" }, name: "Pat" })).toEqual({
      screenId: "client-detail",
    });
  });
  it("rejects unknown screens and junk input", () => {
    expect(sanitizeScreenContext(config, { screenId: "admin" })).toBeNull();
    expect(sanitizeScreenContext(config, null)).toBeNull();
    expect(sanitizeScreenContext(config, "today")).toBeNull();
    expect(sanitizeScreenContext(config, { screenId: "__proto__" })).toBeNull();
  });
  it("ignores prototype keys", () => {
    expect(sanitizeScreenContext(config, { screenId: "client-detail", entityIds: { constructor: ID } })).toEqual({ screenId: "client-detail" });
  });
});

describe("resolveLink whitelist", () => {
  it("builds the href from the template", () => {
    expect(resolveLink(config, { target: "client", params: { id: ID }, label: " Open " })).toEqual({ target: "client", href: `/clients/${ID}`, label: "Open" });
    expect(resolveLink(config, { target: "today", label: "Today" })?.href).toBe("/today");
  });
  it("rejects unknown targets, bad ids, extra params, raw paths and URLs", () => {
    expect(resolveLink(config, { target: "settings", label: "x" })).toBeNull();
    expect(resolveLink(config, { target: "client", params: { id: "../../x" }, label: "x" })).toBeNull();
    expect(resolveLink(config, { target: "client", label: "x" })).toBeNull();
    expect(resolveLink(config, { target: "today", params: { id: ID }, label: "x" })).toBeNull();
    expect(resolveLink(config, { target: "https://evil.example", label: "x" })).toBeNull();
    expect(resolveLink(config, { target: "client", params: { id: ID }, label: "  " })).toBeNull();
  });
  it("shows a rejected link as plain text", () => {
    const r = resolveReplyLinks(config, "Here", [{ target: "nope", label: "Go somewhere" }, { target: "today", label: "Today" }]);
    expect(r.links).toHaveLength(1);
    expect(r.text).toBe("Here\n\nGo somewhere");
  });
});

describe("reducer", () => {
  const user = { id: "u", role: "user", text: "q", createdAt: 1, status: "sent" } as const;
  const pending = { id: "a", role: "assistant", text: "", createdAt: 1, status: "pending" } as const;
  it("ignores a late reply after cancel", () => {
    let s = conversationReducer(emptyConversation("c"), { type: "send", user, pending });
    s = conversationReducer(s, { type: "cancel", pendingId: "a" });
    s = conversationReducer(s, { type: "reply", pendingId: "a", text: "late", links: [], at: 2 });
    expect(s.messages.map((m) => m.id)).toEqual(["u"]);
  });
  it("allows one request at a time", () => {
    const s = conversationReducer(emptyConversation("c"), { type: "send", user, pending });
    expect(conversationReducer(s, { type: "send", user: { ...user, id: "u2" }, pending: { ...pending, id: "a2" } })).toBe(s);
  });
});

function setup(responder: AssistantResponder, timeoutMs = 1000) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AssistantProvider config={config} responder={responder} timeoutMs={timeoutMs}>
      {children}
    </AssistantProvider>
  );
  return renderHook(() => useAssistant(), { wrapper });
}

describe("AssistantProvider", () => {
  afterEach(() => jest.useRealTimers());

  it("replies deterministically and keeps the thread when the sheet closes", async () => {
    const stub = createStubResponder({ fallback: "ok" });
    const { result } = setup(stub);
    act(() => result.current.setMode("sheet"));
    await act(async () => result.current.send("  hello  "));
    await act(async () => undefined);
    expect(result.current.messages.map((m) => [m.role, m.text, m.status])).toEqual([["user", "hello", "sent"], ["assistant", "ok", "sent"]]);
    act(() => result.current.setMode("closed"));
    expect(result.current.messages).toHaveLength(2);
  });

  it("sends the screen context (sanitized) and bounded history", async () => {
    const seen: unknown[] = [];
    const responder: AssistantResponder = { respond: async (req) => (seen.push(req), { text: "r" }) };
    const { result } = setup(responder);
    // Registering from outside a screen component.
    act(() => void result.current.registerScreen({ screenId: "client-detail", entityIds: { clientId: ID, name: "Pat" } }));
    await act(async () => result.current.send("one"));
    await act(async () => undefined);
    await act(async () => result.current.send("two"));
    await act(async () => undefined);
    expect((seen[0] as { context: unknown }).context).toEqual({ screenId: "client-detail", entityIds: { clientId: ID } });
    expect((seen[1] as { history: unknown }).history).toEqual([{ role: "user", text: "one" }, { role: "assistant", text: "r" }]);
  });

  it("shows a typed error and retries the same question", async () => {
    const stub = createStubResponder({ fallback: "worked", failWith: "network", failOnCall: 1 });
    const { result } = setup(stub);
    await act(async () => result.current.send("q"));
    await act(async () => undefined);
    const failed = result.current.messages[1];
    expect(failed.status).toBe("error");
    expect(failed.errorKind).toBe("network");
    await act(async () => result.current.retry(failed.id));
    await act(async () => undefined);
    expect(result.current.messages.map((m) => m.status)).toEqual(["sent", "sent"]);
    expect(result.current.messages[1].text).toBe("worked");
  });

  it("times out", async () => {
    jest.useFakeTimers();
    const stub = createStubResponder({ fallback: "slow", delayMs: 5000 });
    const { result } = setup(stub, 100);
    act(() => result.current.send("q"));
    await act(async () => {
      jest.advanceTimersByTime(150);
    });
    expect(result.current.messages[1]).toMatchObject({ status: "error", errorKind: "timeout" });
  });

  it("cancel removes the placeholder and ignores the late reply", async () => {
    jest.useFakeTimers();
    const stub = createStubResponder({ fallback: "late", delayMs: 500 });
    const { result } = setup(stub);
    act(() => result.current.send("q"));
    act(() => result.current.cancel());
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(result.current.messages.map((m) => m.role)).toEqual(["user"]);
    expect(result.current.busy).toBe(false);
  });

  it("clear empties the thread and aborts the request", async () => {
    jest.useFakeTimers();
    const stub = createStubResponder({ fallback: "late", delayMs: 500 });
    const { result } = setup(stub);
    act(() => result.current.send("q"));
    act(() => result.current.clear());
    await act(async () => {
      jest.advanceTimersByTime(1000);
    });
    expect(result.current.messages).toEqual([]);
  });

  it("drops responder links that are not whitelisted", async () => {
    const responder: AssistantResponder = { respond: async () => ({ text: "see", links: [{ target: "https://x.y", label: "bad" }, { target: "today", label: "Today" }] }) };
    const { result } = setup(responder);
    await act(async () => result.current.send("q"));
    await act(async () => undefined);
    expect(result.current.messages[1].links).toEqual([{ target: "today", href: "/today", label: "Today" }]);
    expect(result.current.messages[1].text).toContain("bad");
  });

  it("an unknown rejection becomes kind unknown", async () => {
    const { result } = setup({ respond: () => Promise.reject(new Error("boom")) });
    await act(async () => result.current.send("q"));
    await act(async () => undefined);
    expect(result.current.messages[1].errorKind).toBe("unknown");
    expect(new AssistantError("timeout").kind).toBe("timeout");
  });

  it("useAssistantScreen registers while mounted; inert without a provider", () => {
    expect(renderHook(() => useAssistantOptional()).result.current).toBeNull();
    renderHook(() => useAssistantScreen({ screenId: "today" })); // no provider: must not throw
    const responder = createStubResponder({ fallback: "x" });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AssistantProvider config={config} responder={responder}>
        {children}
      </AssistantProvider>
    );
    const { result, rerender } = renderHook(({ on }: { on: boolean }) => ({ api: useAssistant(), _: useAssistantScreen(on ? { screenId: "today" } : null) }), {
      wrapper,
      initialProps: { on: true },
    });
    expect(result.current.api.context).toEqual({ screenId: "today" });
    rerender({ on: false });
    expect(result.current.api.context).toBeNull();
  });
});
