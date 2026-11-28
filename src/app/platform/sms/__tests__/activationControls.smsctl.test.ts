import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The inbound route pin and the billed texting switch: authorization (the REAL session guard over scripted claims), validation, no write on any refusal,
 * the refusal sentences, the state reads and the rendering.
 */

vi.mock("server-only", () => ({}));

const redirects: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    redirects.push(url);
    throw new Error("NEXT_REDIRECT");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const cookieWrites: { name: string; value: string; options?: Record<string, unknown> }[] = [];
let cookieValue: string | undefined;
vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: (name: string, value: string, options?: Record<string, unknown>) => cookieWrites.push({ name, value, options }),
    get: () => (cookieValue === undefined ? undefined : { value: cookieValue }),
  }),
}));

const ADMIN = "a6000000-0000-4000-8000-00000000c001";
const FORGED = "a6000000-0000-4000-8000-00000000c009";
let platformAdmin = true;
vi.mock("@/lib/auth/platform", () => ({
  requirePlatformAdmin: async () => {
    if (!platformAdmin) throw new Error("NOT_PLATFORM_ADMIN");
    return { id: ADMIN };
  },
}));

// the real step-up guard runs; only the verified claims it reads are scripted
let aal = "aal2";
let codeAgeSeconds = 30;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getClaims: async () => {
        const now = Math.floor(Date.now() / 1000);
        return { data: { claims: { sub: ADMIN, exp: now + 3600, aal, amr: [{ method: "totp", timestamp: now - codeAgeSeconds }] } }, error: null };
      },
    },
  }),
}));

let rateAllowed = true;
const rateLimitCalls: string[] = [];
vi.mock("@/lib/security/rate-limit", () => ({
  rateLimitKey: (...p: unknown[]) => p.join(":"),
  checkRateLimit: (key: string) => {
    rateLimitCalls.push(key);
    return { allowed: rateAllowed };
  },
}));

type Reply = { data?: unknown; error?: { code?: string; message?: string } };
const rpc: { fn: string; args: Record<string, unknown> }[] = [];
let replies: Record<string, Reply | ((args: Record<string, unknown>) => Reply)> = {};
let clientsBuilt = 0;
const client = {
  rpc: async (fn: string, args: Record<string, unknown>) => {
    rpc.push({ fn, args });
    const scripted = replies[fn];
    const r = typeof scripted === "function" ? scripted(args) : scripted;
    if (!r) return { data: null, error: { code: "42883" } };
    return { data: r.data ?? null, error: r.error ?? null };
  },
};
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    clientsBuilt += 1;
    return client;
  },
}));

import {
  configuredInboundRoute, CONTROLS_FLASH_COOKIE, loadInboundPinState, pinRefusalMessage, switchRefusalMessage, SWITCH_ON_PHRASE,
} from "@/lib/sms/activationControls";
import { pinInboundRouteAction, switchBilledTextingOffAction, switchBilledTextingOnAction } from "../activationControlActions";
import ActivationControls from "../ActivationControls";
import ActivationControlsPanel from "../ActivationControlsPanel";

const ORIGIN = "https://app.example.test";
const STUDIO = "f0000001-0000-4000-8000-00000000c001";
const REASON = "synthetic reason for this change";

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const pinForm = (over: Record<string, string> = {}) => form({ shownOrigin: ORIGIN, reason: REASON, confirm: "on", ...over });
const onForm = (over: Record<string, string> = {}) => form({ reason: REASON, phrase: SWITCH_ON_PHRASE, confirm: "on", ...over });
const offForm = (over: Record<string, string> = {}) => form({ reason: REASON, confirm: "on", ...over });

async function run(action: (f: FormData) => Promise<void>, data: FormData) {
  await expect(action(data)).rejects.toThrow("NEXT_REDIRECT");
}
const flash = () => JSON.parse(cookieWrites.at(-1)!.value) as { ok: boolean; message: string };
const expectNoWrite = () => {
  expect(rpc).toEqual([]);
  expect(clientsBuilt).toBe(0);
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", ORIGIN);
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  redirects.length = 0;
  cookieWrites.length = 0;
  cookieValue = undefined;
  rpc.length = 0;
  rateLimitCalls.length = 0;
  clientsBuilt = 0;
  rateAllowed = true;
  platformAdmin = true;
  aal = "aal2";
  codeAgeSeconds = 30;
  replies = {
    tw4_inbound_route_pin_set: (args) => ({ data: { origin: args.p_origin } }),
    tw4_usage_set_switch: (args) => ({ data: { enabled: args.p_enabled } }),
  };
});
afterEach(() => vi.unstubAllEnvs());

const ALL = [
  ["pin", pinInboundRouteAction, pinForm],
  ["switch on", switchBilledTextingOnAction, onForm],
  ["switch off", switchBilledTextingOffAction, offForm],
] as const;

describe("authorization", () => {
  for (const [name, action, data] of ALL) {
    it(`${name}: a non-administrator writes nothing`, async () => {
      platformAdmin = false;
      await expect(action(data())).rejects.toThrow("NOT_PLATFORM_ADMIN");
      expectNoWrite();
    });

    it(`${name}: a session without the authenticator step writes nothing`, async () => {
      aal = "aal1";
      await run(action, data());
      expect(redirects.at(-1)).toContain("/platform-mfa/challenge?stepup=1&reason=aal1");
      expectNoWrite();
    });
  }

  for (const [name, action, data] of ALL.slice(0, 2)) {
    it(`${name}: a code older than 15 minutes writes nothing`, async () => {
      codeAgeSeconds = 16 * 60;
      await run(action, data());
      expect(redirects.at(-1)).toContain("reason=stale");
      expectNoWrite();
    });
  }

  it("switch off: allowed with an older code, like the other stops", async () => {
    codeAgeSeconds = 6 * 60 * 60;
    await run(switchBilledTextingOffAction, offForm());
    expect(rpc).toEqual([{ fn: "tw4_usage_set_switch", args: { p_enabled: false, p_actor: ADMIN, p_reason: REASON } }]);
    expect(flash().ok).toBe(true);
  });
});

describe("the writes", () => {
  it("pins the configured origin with the session's administrator, whatever else the form claims", async () => {
    await run(pinInboundRouteAction, pinForm({ actor: FORGED, p_actor: FORGED, origin: "https://other.example.test", reason: `  ${REASON}​ ` }));
    expect(rpc).toEqual([{ fn: "tw4_inbound_route_pin_set", args: { p_actor: ADMIN, p_origin: ORIGIN, p_reason: REASON } }]);
    expect(flash()).toMatchObject({ ok: true });
    expect(flash().message).toContain(ORIGIN);
    expect(cookieWrites.at(-1)).toMatchObject({ name: CONTROLS_FLASH_COOKIE, options: { httpOnly: true, sameSite: "strict" } });
    expect(redirects.at(-1)).toBe("/platform/sms?controls=1#sms-activation-controls");
  });

  it("switches on and off with the session's administrator", async () => {
    await run(switchBilledTextingOnAction, onForm({ actor: FORGED, enabled: "false" }));
    expect(rpc).toEqual([{ fn: "tw4_usage_set_switch", args: { p_enabled: true, p_actor: ADMIN, p_reason: REASON } }]);
    expect(flash().message).toContain("now ON");
    rpc.length = 0;
    await run(switchBilledTextingOffAction, offForm({ enabled: "true" }));
    expect(rpc).toEqual([{ fn: "tw4_usage_set_switch", args: { p_enabled: false, p_actor: ADMIN, p_reason: REASON } }]);
    expect(flash().message).toContain("now OFF");
  });

  it("an answer that does not confirm the change is never reported as success", async () => {
    replies = { tw4_inbound_route_pin_set: { data: { origin: "https://other.example.test" } }, tw4_usage_set_switch: { data: { enabled: false } } };
    for (const [action, data] of [[pinInboundRouteAction, pinForm()], [switchBilledTextingOnAction, onForm()]] as const) {
      await run(action, data);
      expect(flash()).toMatchObject({ ok: false });
      expect(flash().message).toContain("did not confirm");
    }
    expect(redirects.at(-1)).toBe("/platform/sms?controls_error=1#sms-activation-controls");
  });

  it("a thrown call is reported as unconfirmed, without its text", async () => {
    replies = {
      tw4_usage_set_switch: () => {
        throw new Error("synthetic transport failure");
      },
    };
    await run(switchBilledTextingOffAction, offForm());
    expect(flash().ok).toBe(false);
    expect(flash().message).toContain("did not confirm");
    expect(flash().message).not.toContain("synthetic transport");
  });

  it("a database refusal is shown as a fixed sentence, never the database's text", async () => {
    replies = { tw4_usage_set_switch: { error: { code: "TW024", message: "billed texting cannot be switched on: the usage reconciler is not ready (stale) internal-text" } } };
    await run(switchBilledTextingOnAction, onForm());
    expect(flash().ok).toBe(false);
    expect(flash().message).toContain("more than 30 minutes old");
    expect(flash().message).not.toContain("internal-text");
  });
});

describe("validation: nothing is written", () => {
  const badReasons = ["", "too short", "x".repeat(301), "line one is long\nline two"];
  for (const [name, action, data] of ALL) {
    it(`${name}: a missing or bad reason`, async () => {
      for (const reason of badReasons) await run(action, data({ reason }));
      expect(flash().message).toContain("Nothing changed");
      expect(rateLimitCalls).toEqual([]);
      expectNoWrite();
    });

    it(`${name}: no confirmation`, async () => {
      for (const confirm of ["", "off"]) await run(action, data({ confirm }));
      expect(flash().message).toContain("Confirm");
      expectNoWrite();
    });

    it(`${name}: rate limited`, async () => {
      rateAllowed = false;
      await run(action, data());
      expect(flash().message).toContain("Too many attempts");
      expectNoWrite();
    });
  }

  it("switch on needs the exact typed phrase", async () => {
    for (const phrase of ["", "switch on billed texting", "SWITCH ON", `${SWITCH_ON_PHRASE}!`]) await run(switchBilledTextingOnAction, onForm({ phrase }));
    expect(flash().message).toContain(SWITCH_ON_PHRASE);
    expectNoWrite();
  });

  it("pin refuses when the page showed another address", async () => {
    for (const shownOrigin of ["", "https://other.example.test", `${ORIGIN}:444`]) await run(pinInboundRouteAction, pinForm({ shownOrigin }));
    expect(flash().message).toContain("Reload the page");
    expectNoWrite();
  });

  it("pin refuses when the application URL is missing or not acceptable, even if the form echoes it", async () => {
    for (const url of ["", "http://app.example.test", "https://localhost:3000", "https://APP.example.test", "https://app.example.test/base"]) {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", url);
      await run(pinInboundRouteAction, pinForm({ shownOrigin: url }));
      expect(flash().ok).toBe(false);
    }
    expectNoWrite();
  });
});

describe("configured inbound route", () => {
  it("is the application URL (trailing slash dropped), with the site URL as the fallback", () => {
    expect(configuredInboundRoute({ NEXT_PUBLIC_APP_URL: `${ORIGIN}/` })).toEqual({ ok: true, origin: ORIGIN, inboundUrl: `${ORIGIN}/api/sms/twilio/inbound` });
    expect(configuredInboundRoute({ NEXT_PUBLIC_SITE_URL: "https://site.example.test:8443" })).toMatchObject({ ok: true, origin: "https://site.example.test:8443" });
  });

  it("has no default host", () => {
    expect(configuredInboundRoute({})).toMatchObject({ ok: false, origin: null });
  });

  it("applies the database's rule", () => {
    for (const url of ["https://127.0.0.1", "https://app.example.test?x=1", "https://app.example.test.", `https://${"a".repeat(250)}.example.test`]) {
      expect(configuredInboundRoute({ NEXT_PUBLIC_APP_URL: url }).ok).toBe(false);
    }
  });
});

describe("refusal sentences", () => {
  it("maps every known pin and switch refusal", () => {
    expect(pinRefusalMessage("42501")).toContain("platform administrator");
    expect(pinRefusalMessage("22023")).toContain("https");
    expect(pinRefusalMessage("23514")).toContain("Nothing changed");
    expect(pinRefusalMessage("PGRST202")).toContain("not available");
    expect(pinRefusalMessage("XX000")).toContain("did not confirm");
    expect(switchRefusalMessage("42501")).toContain("platform administrator");
    expect(switchRefusalMessage("22023")).toContain("reason");
    expect(switchRefusalMessage("55P03")).toContain("busy");
    expect(switchRefusalMessage("42883")).toContain("not available");
    expect(switchRefusalMessage("")).toContain("did not confirm");
  });

  it("reads only the fixed detail of TW024", () => {
    const refusal = (detail: string) => switchRefusalMessage("TW024", `billed texting cannot be switched on: the usage reconciler is not ready (${detail})`);
    expect(refusal("no_completed_run")).toContain("no reconciliation run has completed yet");
    expect(refusal("no_evidence_reads")).toContain("evidence reads are off");
    expect(refusal("evidence_failing")).toContain("settled nothing");
    expect(refusal("stuck_lease")).toContain("schedule has stopped");
    expect(refusal("something_new")).toBe("Billed texting was not switched on: the usage reconciler is not ready. Nothing changed.");
    expect(refusal("constructor")).toBe("Billed texting was not switched on: the usage reconciler is not ready. Nothing changed.");
    expect(switchRefusalMessage("TW024", "billed texting cannot be switched on: the usage ledger has reconciliation gaps")).toContain("reconciliation gaps");
    expect(switchRefusalMessage("TW024")).toContain("not ready");
  });
});

const checklist = (ok: boolean) => ({ data: { state: "campaign_pending", ready: false, ledger: {}, items: [{ id: "inbound_route_pinned", ok, detail: ok ? "ok" : "inbound_route_not_pinned" }] } });

describe("pin state", () => {
  it("reads the checklist item as the session's administrator", async () => {
    replies = { tw4_act_check: checklist(true) };
    expect(await loadInboundPinState(client as never, ADMIN, [STUDIO])).toBe("recorded");
    expect(rpc).toEqual([{ fn: "tw4_act_check", args: { p_studio_id: STUDIO, p_actor: ADMIN } }]);
    replies = { tw4_act_check: checklist(false) };
    expect(await loadInboundPinState(client as never, ADMIN, [STUDIO])).toBe("not_recorded");
  });

  it("is unknown, never guessed, without a location, on errors or when the item is absent or unrecognised; at most three tries", async () => {
    expect(await loadInboundPinState(client as never, ADMIN, [])).toBe("unknown");
    replies = {};
    expect(await loadInboundPinState(client as never, ADMIN, ["a", "b", "c", "d"])).toBe("unknown");
    expect(rpc).toHaveLength(3);
    replies = { tw4_act_check: { data: { items: [] } } };
    expect(await loadInboundPinState(client as never, ADMIN, [STUDIO])).toBe("unknown");
    replies = { tw4_act_check: { data: { items: [{ id: "inbound_route_pinned", ok: false, detail: "other" }] } } };
    expect(await loadInboundPinState(client as never, ADMIN, [STUDIO])).toBe("unknown");
  });
});

type Props = Parameters<typeof ActivationControls>[0];
const READY = { ok: true, detail: "ready" as const, lastSuccessAt: "2026-01-01T00:00:00Z" };
const OFF_STATE = { switchOn: false, usageGaps: 0, inboundGaps: 0 };
// the attribute, not the `disabled:` style classes
const DISABLED = 'disabled=""';
const render = (over: Partial<Props> = {}) =>
  renderToStaticMarkup(createElement(ActivationControls, { route: configuredInboundRoute({ NEXT_PUBLIC_APP_URL: ORIGIN }), pin: "not_recorded", usage: OFF_STATE, readiness: READY, notice: null, error: null, ...over }));
const part = (html: string, testid: string) => {
  const at = html.indexOf(`data-testid="${testid}"`);
  return at < 0 ? "" : html.slice(html.lastIndexOf("<", at), html.indexOf("</form>", at));
};

describe("rendering", () => {
  it("shows what will be pinned before the confirmation, with nothing pre-ticked or pre-filled", () => {
    const html = render();
    const pin = part(html, "controls-pin-form");
    expect(pin).toContain(`${ORIGIN}/api/sms/twilio/inbound`);
    expect(pin.indexOf(ORIGIN)).toBeLessThan(pin.indexOf('type="checkbox"'));
    expect(pin.match(/value="/g)).toHaveLength(1);   // only the echo of the shown origin
    expect(html).toContain("No pin is recorded");
    expect(html).toContain("cannot show which address is pinned");
    expect(html).not.toContain('checked=""');
    expect(html).not.toMatch(/autofocus/i);
  });

  it("says unknown when the pin cannot be read, and offers no form without an acceptable address", () => {
    expect(render({ pin: "unknown" })).toContain("does not mean there is no pin");
    const html = render({ route: configuredInboundRoute({}) });
    expect(html).toContain("controls-pin-unavailable");
    expect(html).not.toContain("controls-pin-form");
  });

  it("switch on asks for more than switch off", () => {
    const html = render();
    expect(part(html, "controls-switch-on")).toContain('name="phrase"');
    expect(part(html, "controls-switch-on")).toContain('name="confirm"');
    expect(part(html, "controls-switch-off")).not.toContain('name="phrase"');
    expect(part(html, "controls-switch-off")).toContain('name="confirm"');
    expect(part(html, "controls-switch-on")).not.toContain(DISABLED);
    expect(html).toContain("Current state: OFF.");
  });

  it("disables switch on, with the reason, unless the database state allows it; switch off stays available", () => {
    const cases: [Partial<Props>, string][] = [
      [{ usage: { ...OFF_STATE, switchOn: true } }, "already on"],
      [{ usage: null, readiness: null }, "could not be read"],
      [{ readiness: null }, "readiness could not be read"],
      [{ readiness: { ok: false, detail: "stale", lastSuccessAt: null } }, "more than 30 minutes old"],
      [{ usage: { ...OFF_STATE, usageGaps: 2 } }, "2 outbound"],
      [{ usage: { ...OFF_STATE, inboundGaps: 1 } }, "1 inbound"],
    ];
    for (const [over, reason] of cases) {
      const html = render(over);
      expect(part(html, "controls-switch-on")).toContain(DISABLED);
      expect(part(html, "controls-switch-on")).toContain(reason);
      expect(part(html, "controls-switch-off")).toContain("Switch OFF");
      expect(part(html, "controls-switch-off")).not.toContain(DISABLED);
    }
    expect(render({ usage: null })).toContain("Current state: not known");
  });

  it("the server wrapper loads the pin, the configured route and only its own banner", async () => {
    replies = { tw4_act_check: checklist(true) };
    cookieValue = JSON.stringify({ ok: false, message: "synthetic banner" });
    const element = (await ActivationControlsPanel({
      adminId: ADMIN, locations: [{ studioId: "no-state", state: null }, { studioId: STUDIO, state: "campaign_pending" }], usage: OFF_STATE, readiness: READY, notice: null, error: "1",
    })) as ReactElement<Props>;
    expect(isValidElement(element)).toBe(true);
    expect(element.props).toMatchObject({ pin: "recorded", error: "synthetic banner", notice: null, route: { ok: true, origin: ORIGIN } });
    expect(rpc).toEqual([{ fn: "tw4_act_check", args: { p_studio_id: STUDIO, p_actor: ADMIN } }]);
  });

  it("the server wrapper reads nothing and says unknown with no location", async () => {
    const element = (await ActivationControlsPanel({ adminId: ADMIN, locations: [], usage: null, readiness: null, notice: null, error: null })) as ReactElement<Props>;
    expect(element.props.pin).toBe("unknown");
    expectNoWrite();
  });
});
