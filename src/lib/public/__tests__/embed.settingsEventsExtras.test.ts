import { describe, expect, it, vi } from "vitest";
import { embedCalendarPath, embedClassPath, parseEmbedOptions } from "../embedOptions";
import { appearanceDefaults, DEFAULT_EMBED_SETTINGS, embedGate, fetchEmbedGate, parseEmbedSettings, parseSettingsForm } from "../embedSettings";
import { eventDays, fetchPublicEmbedEvents, formatEventTimes, groupEventsByDay, parsePublicEmbedEvent } from "../embedEvents";
import { fetchClassExtras, formatClassPrice, parseClassExtras } from "../embedClassExtras";

const row = (over: Record<string, unknown> = {}) => ({
  embeds_enabled: true,
  show_events: true,
  show_class_description: false,
  show_class_price: false,
  default_view: "agenda",
  default_theme: "light",
  default_accent: null,
  ...over,
});

describe("stored embed settings", () => {
  it("parses a valid row and refuses a malformed one", () => {
    expect(parseEmbedSettings(row({ default_view: "month", default_theme: "dark", default_accent: "#AABBCC" }))).toEqual({
      embedsEnabled: true,
      showEvents: true,
      showClassDescription: false,
      showClassPrice: false,
      defaultView: "month",
      defaultTheme: "dark",
      defaultAccent: "#aabbcc",
    });
    for (const bad of [null, {}, row({ embeds_enabled: "yes" }), row({ default_view: "sideways" }), row({ default_theme: "blue" }), row({ default_accent: "red;}" })]) {
      expect(parseEmbedSettings(bad)).toBeNull();
    }
  });

  it("serves only when the studio is public and embeds are on; everything else fails closed", () => {
    expect(embedGate({ data: [row()], error: null }).state).toBe("ok");
    expect(embedGate({ data: [row({ embeds_enabled: false })], error: null }).state).toBe("off");
    expect(embedGate({ data: [], error: null }).state).toBe("unavailable"); // not a public studio
    expect(embedGate({ data: null, error: { message: "function does not exist" } }).state).toBe("unavailable"); // migration missing
    expect(embedGate({ data: [{ nonsense: true }], error: null }).state).toBe("unavailable");
  });

  it("fails closed when the call itself throws", async () => {
    const supabase = { rpc: vi.fn().mockRejectedValue(new Error("network")) };
    await expect(fetchEmbedGate(supabase as never, "studio")).resolves.toEqual({ state: "unavailable" });
    expect(supabase.rpc).toHaveBeenCalledWith("public_studio_embed_settings", { p_studio_slug: "studio" });
  });

  it("the built-in defaults are: embeds on, events on, description and price off", () => {
    expect(DEFAULT_EMBED_SETTINGS).toMatchObject({ embedsEnabled: true, showEvents: true, showClassDescription: false, showClassPrice: false });
  });

  it("validates the builder form and rejects anything unexpected", () => {
    const form = (o: Record<string, string>) => {
      const f = new FormData();
      for (const [k, v] of Object.entries(o)) f.set(k, v);
      return f;
    };
    const ok = parseSettingsForm(form({ embedsEnabled: "on", defaultView: "week", defaultTheme: "dark", defaultAccent: "#7A1F5C" }));
    expect(ok).toEqual({
      ok: true,
      value: { embedsEnabled: true, showEvents: false, showClassDescription: false, showClassPrice: false, defaultView: "week", defaultTheme: "dark", defaultAccent: "#7a1f5c" },
    });
    // an unchecked box is false: switching embeds off is a form with no embedsEnabled field
    expect(parseSettingsForm(form({ defaultView: "agenda", defaultTheme: "light", defaultAccent: "" }))).toMatchObject({ ok: true, value: { embedsEnabled: false, defaultAccent: null } });
    expect(parseSettingsForm(form({ defaultView: "x", defaultTheme: "light" })).ok).toBe(false);
    expect(parseSettingsForm(form({ defaultView: "agenda", defaultTheme: "neon" })).ok).toBe(false);
    expect(parseSettingsForm(form({ defaultView: "agenda", defaultTheme: "light", defaultAccent: "red;}</style>" })).ok).toBe(false);
  });
});

describe("stored defaults and embed URLs", () => {
  const stored = { view: "month" as const, theme: "dark" as const, accent: "#7a1f5c" };

  it("applies stored defaults only where the URL is silent; an explicit option wins", () => {
    expect(parseEmbedOptions({}, stored)).toMatchObject({ view: "month", theme: "dark", accent: "#7a1f5c" });
    expect(parseEmbedOptions({ view: "agenda", theme: "light", accent: "112233" }, stored)).toMatchObject({ view: "agenda", theme: "light", accent: "#112233" });
    expect(parseEmbedOptions({ view: "bogus", theme: "bogus", accent: "bogus" }, stored)).toMatchObject({ view: "month", theme: "dark", accent: "#7a1f5c" });
    expect(parseEmbedOptions({})).toMatchObject({ view: "agenda", theme: "light" });
  });

  it("omits an option equal to the stored default and writes out one that differs", () => {
    expect(embedCalendarPath("s", { view: "month", theme: "dark", accent: "#7a1f5c" }, stored)).toBe("/embed/calendar/s");
    expect(embedCalendarPath("s", { view: "agenda", theme: "light" }, stored)).toBe("/embed/calendar/s?theme=light&view=agenda");
    expect(embedClassPath("abc", { theme: "dark" }, stored)).toBe("/embed/class/abc");
    // without a baseline the behavior is unchanged
    expect(embedCalendarPath("s", { view: "week", theme: "dark" })).toBe("/embed/calendar/s?theme=dark&view=week");
    expect(appearanceDefaults({ ...DEFAULT_EMBED_SETTINGS, defaultView: "week" })).toEqual({ accent: null, theme: "light", view: "week" });
  });
});

describe("public events in the embed", () => {
  const ev = (over: Record<string, unknown> = {}) => ({
    id: "e1",
    name: "Spring Social",
    slug: "spring-social",
    event_type: "social_dance",
    venue_name: "Main Hall",
    city: "Austin",
    state: "TX",
    timezone: "America/Chicago",
    start_date: "2030-03-01",
    end_date: "2030-03-03",
    start_time: "19:00:00",
    end_time: "22:30:00",
    registration_required: true,
    beginner_friendly: false,
    ...over,
  });

  it("maps a row to the safe shape and nothing else", () => {
    const e = parsePublicEmbedEvent({ ...ev(), attendee_email: "x@y.z", ticket_price: 99 });
    expect(Object.keys(e!).sort()).toEqual(
      ["beginnerFriendly", "endDate", "endTime", "id", "location", "name", "registrationRequired", "slug", "startDate", "startTime", "timeZone", "typeLabel"].sort(),
    );
    expect(e).toMatchObject({ typeLabel: "Social dance", location: "Main Hall, Austin, TX", startTime: "19:00", endTime: "22:30" });
    expect(JSON.stringify(e)).not.toMatch(/x@y\.z|99/);
  });

  it("drops events it cannot link or place, and repairs an end date before the start", () => {
    expect(parsePublicEmbedEvent(ev({ slug: null }))).toBeNull();
    expect(parsePublicEmbedEvent(ev({ slug: "../../admin" }))).toBeNull();
    expect(parsePublicEmbedEvent(ev({ start_date: "soon" }))).toBeNull();
    expect(parsePublicEmbedEvent(ev({ name: "  " }))).toBeNull();
    expect(parsePublicEmbedEvent(ev({ end_date: "2030-02-01" }))!.endDate).toBe("2030-03-01");
  });

  it("covers every day of a multi-day event and caps a runaway span", () => {
    expect(eventDays({ startDate: "2030-03-01", endDate: "2030-03-03" })).toEqual(["2030-03-01", "2030-03-02", "2030-03-03"]);
    expect(eventDays({ startDate: "2030-03-01", endDate: "2099-01-01" }).length).toBe(62);
    const by = groupEventsByDay([parsePublicEmbedEvent(ev())!]);
    expect([...by.keys()]).toEqual(["2030-03-01", "2030-03-02", "2030-03-03"]);
  });

  it("formats times in the event's own clock", () => {
    expect(formatEventTimes({ startTime: "19:00", endTime: "22:30" })).toBe("7:00 PM – 10:30 PM");
    expect(formatEventTimes({ startTime: "09:05", endTime: null })).toBe("9:05 AM");
    expect(formatEventTimes({ startTime: "00:00", endTime: "12:00" })).toBe("12:00 AM – 12:00 PM");
    expect(formatEventTimes({ startTime: null, endTime: null })).toBe("");
  });

  it("queries only public, directory-listed, published studio events and selects no private columns", async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "not", "gte", "order"]) q[m] = (...a: unknown[]) => (calls.push([m, ...a]), q);
    q.limit = () => Promise.resolve({ data: [ev(), ev({ id: "e2", slug: null })], error: null });
    const supabase = { from: vi.fn(() => q) };
    const events = await fetchPublicEmbedEvents(supabase as never, "studio-1", new Date("2030-01-01T12:00:00Z"));
    expect(events.map((e) => e.id)).toEqual(["e1"]);
    const sel = String(calls.find((c) => c[0] === "select")![1]);
    expect(sel).not.toMatch(/price|email|attendee|payment|stripe|notes|capacity|ticket/i);
    expect(sel).toContain("registration_required"); // only the yes/no flag, never registrations
    expect(calls).toContainEqual(["eq", "studio_id", "studio-1"]);
    expect(calls).toContainEqual(["eq", "visibility", "public"]);
    expect(calls).toContainEqual(["eq", "public_directory_enabled", true]);
    expect(calls).toContainEqual(["in", "status", ["published", "open"]]);
  });

  it("hides an event that has already ended", async () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "not", "gte", "order"]) q[m] = () => q;
    q.limit = () => Promise.resolve({ data: [ev({ start_date: "2020-01-01", end_date: "2020-01-02" })], error: null });
    expect(await fetchPublicEmbedEvents({ from: () => q } as never, "s", new Date("2030-01-01T12:00:00Z"))).toEqual([]);
  });

  it("returns nothing, not an error, when the read fails", async () => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "not", "gte", "order"]) q[m] = () => q;
    q.limit = () => Promise.resolve({ data: null, error: { message: "boom" } });
    expect(await fetchPublicEmbedEvents({ from: () => q } as never, "s")).toEqual([]);
  });
});

describe("class description and price", () => {
  const ID = "11111111-1111-4111-8111-111111111111";

  it("formats prices and refuses nonsense", () => {
    expect(formatClassPrice(25)).toBe("$25");
    expect(formatClassPrice("25.5")).toBe("$25.50");
    expect(formatClassPrice("19.999")).toBe("$20");
    for (const bad of [0, -5, null, undefined, "free", NaN, Infinity, 1e9]) expect(formatClassPrice(bad)).toBeNull();
  });

  it("parses rows, trimming descriptions and ignoring malformed ids", () => {
    const map = parseClassExtras([
      { appointment_id: ID, description: "  Bring flat shoes.\u0000 ", price_amount: 20 },
      { appointment_id: "not-a-uuid", description: "x", price_amount: 1 },
      { appointment_id: "22222222-2222-4222-8222-222222222222", description: "   ", price_amount: null },
    ]);
    expect(map.get(ID)).toEqual({ description: "Bring flat shoes.", priceLabel: "$20" });
    expect(map.size).toBe(2);
    expect(map.get("22222222-2222-4222-8222-222222222222")).toEqual({ description: null, priceLabel: null });
    expect(parseClassExtras(null).size).toBe(0);
  });

  it("calls the database function with the studio slug and at most 100 distinct valid ids", async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: [], error: null }) };
    const many = Array.from({ length: 150 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    await fetchClassExtras(supabase as never, "studio", [...many, ...many, "junk"]);
    const args = supabase.rpc.mock.calls[0][1] as { p_studio_slug: string; p_appointment_ids: string[] };
    expect(supabase.rpc.mock.calls[0][0]).toBe("public_group_class_extras");
    expect(args.p_studio_slug).toBe("studio");
    expect(args.p_appointment_ids).toHaveLength(100);
    expect(await fetchClassExtras(supabase as never, "studio", [])).toEqual(new Map());
  });

  it("degrades to no extras when the function is missing or the call throws", async () => {
    expect((await fetchClassExtras({ rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "no function" } }) } as never, "s", [ID])).size).toBe(0);
    expect((await fetchClassExtras({ rpc: vi.fn().mockRejectedValue(new Error("x")) } as never, "s", [ID])).size).toBe(0);
  });
});
