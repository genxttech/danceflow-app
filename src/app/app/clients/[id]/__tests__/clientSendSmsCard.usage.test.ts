import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TW-4F: the manual SMS card sends one idempotency key per composed message. There is no DOM library in this repo, so the component's hooks are
 * replaced by a minimal in-memory runtime and its handlers are driven directly from the element tree it returns.
 */

const rt = vi.hoisted(() => ({
  slots: [] as unknown[],
  index: 0,
  rerender: () => undefined as void,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const i = rt.index++;
      if (!(i in rt.slots)) rt.slots[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      const set = (value: unknown) => {
        rt.slots[i] = typeof value === "function" ? (value as (prev: unknown) => unknown)(rt.slots[i]) : value;
      };
      return [rt.slots[i], set];
    },
    useMemo: (fn: () => unknown) => fn(),
  };
});

import { ClientSendSmsCard } from "@/app/app/clients/[id]/ClientSendSmsCard";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const props = {
  clientId: CLIENT_ID,
  phone: "(555) 010-0123",
  canManage: true,
  permission: {
    id: "perm-1",
    studio_id: "11111111-1111-4111-8111-111111111111",
    organizer_id: null,
    client_id: CLIENT_ID,
    organizer_contact_id: null,
    phone_e164: "+15550100123",
    consent_status: "opted_in",
    consent_source: "studio_staff_manual",
    consent_note: null,
    consent_at: "2026-09-01T00:00:00.000Z",
    opted_out_at: null,
    opted_out_source: null,
    created_by: null,
    updated_by: null,
  },
} as never;

type El = { type?: unknown; props?: { children?: unknown; [k: string]: unknown } };

function render(): El {
  rt.index = 0;
  return (ClientSendSmsCard as unknown as (p: unknown) => El)(props);
}

function find(node: unknown, type: string): El | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, type);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as El;
  if (el.type === type) return el;
  return find(el.props?.children, type);
}

function text(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  if (Array.isArray(node)) return node.map(text).join(" ");
  return text((node as El).props?.children);
}

const type = (value: string) => {
  const area = find(render(), "textarea")!;
  (area.props!.onChange as (e: unknown) => void)({ target: { value } });
};

async function submit() {
  const form = find(render(), "form")!;
  await (form.props!.onSubmit as (e: unknown) => Promise<void>)({ preventDefault: () => undefined });
}

const fetchMock = vi.fn();
const sentKeys = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).idempotencyKey as string);

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  rt.slots = [];
  rt.index = 0;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("ClientSendSmsCard idempotency key", () => {
  it("the request carries the client, the message and a v4 uuid idempotencyKey", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, message: "Text queued for sending." }));
    type("Hello there");
    await submit();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/sms/send");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ clientId: CLIENT_ID, body: "Hello there" });
    expect(body.idempotencyKey).toMatch(UUID_V4);
  });

  it("a plain failure keeps the same key for the same message (a retry is recognized by the server)", async () => {
    fetchMock.mockResolvedValue(reply(500, { ok: false, error: "The text could not be sent. Please try again." }));
    type("Hello there");
    await submit();
    await submit();
    const [first, second] = sentKeys();
    expect(first).toBe(second);
  });

  it("an uncertain answer keeps the message and the key, and shows the do-not-resend note", async () => {
    fetchMock.mockResolvedValue(reply(202, { ok: false, uncertain: true, error: "Do not send it again." }));
    type("Hello there");
    await submit();
    expect(text(render())).toContain("Do not send it again.");
    await submit();
    const [first, second] = sentKeys();
    expect(first).toBe(second);
    const area = find(render(), "textarea")!;
    expect(area.props!.value).toBe("Hello there");
  });

  it("a successful send clears the message and the next message gets a new key", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, message: "Text queued for sending." }));
    type("First");
    await submit();
    expect(find(render(), "textarea")!.props!.value).toBe("");
    type("Second");
    await submit();
    const [first, second] = sentKeys();
    expect(first).toMatch(UUID_V4);
    expect(second).toMatch(UUID_V4);
    expect(second).not.toBe(first);
  });

  it("editing the message after an uncertain answer starts a new text with a new key", async () => {
    fetchMock.mockResolvedValue(reply(202, { ok: false, uncertain: true, error: "Do not send it again." }));
    type("Hello there");
    await submit();
    type("Hello there, again");
    await submit();
    const [first, second] = sentKeys();
    expect(second).not.toBe(first);
  });

  it("a network error shows an error and keeps the key", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    type("Hello there");
    await submit();
    expect(text(render())).toContain("The text could not be sent. Please try again.");
    fetchMock.mockResolvedValue(reply(200, { ok: true }));
    await submit();
    const [first, second] = sentKeys();
    expect(first).toBe(second);
  });

  it("an empty message is not sent", async () => {
    type("   ");
    await submit();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
