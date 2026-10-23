import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 10C.5 registration isolation (20261115090000): competition draft creation, competition registration open/close
 * and ordinary event ticket registration are separate operations. Competition setup never writes the event's
 * registration_required, account_required_for_registration or registration window; wizard-created programs carry
 * their own competition registration settings; legacy programs keep the exact 10C gate.
 * Behaviour is exercised on DEV by sql-tests/test_T_phase10c5_competition_draft.sql (registration isolation section).
 */

const ROOT = join(__dirname, "..", "..", "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const sha = (path: string) => createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex");
const MIGRATIONS = "src/lib/supabase/migrations";
const ISO = read(`${MIGRATIONS}/20261115090000_phase10c5_registration_isolation.sql`);
const ROLLBACK = read(`${MIGRATIONS}/rollback/20261115090000_phase10c5_registration_isolation_rollback.sql`);

function fn(sql: string, signature: string) {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${signature}`);
  expect(start, signature).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf("\n$function$", start));
}
const DRAFT = fn(ISO, "create_competition_draft(");
const PROGRAM_OPEN = fn(ISO, "competition_registration_program_open(");
const OPEN = fn(ISO, "open_competition_registration(");
const START = fn(ISO, "start_competition_registration(");
const EVENT_FIELDS = /(registration_required|account_required_for_registration|registration_opens_at|registration_closes_at)\s*=/;

describe("registration isolation migration (20261115090000)", () => {
  it("is a forward migration: the applied 10C.5 migrations stay byte-identical", () => {
    expect(sha(`${MIGRATIONS}/20261113090000_phase10c5_competition_draft.sql`)).toBe("dcba340aa0f4836adf1327f44353464e3cc402576ff0992a22ca38eebd0ff332");
    expect(sha(`${MIGRATIONS}/20261114090000_phase10c5_profile_v3.sql`)).toBe("11da622af7d04f22bba75cbbf27b3942c708725a7756163452c563fde27a6022");
    expect(sha(`${MIGRATIONS}/rollback/20261114090000_phase10c5_profile_v3_rollback.sql`)).toBe("a1d8174e97459138255690dc928fcde83e326384ae6a66773164aec6afb3de19");
  });

  it("checks the exact 20261114090000 definitions before replacing anything, and the generated ones after", () => {
    const preflight = ISO.slice(0, ISO.indexOf("-- 1. competition_registration_account_required"));
    for (const md5 of ["a5bd1f13b01df19b4821073419076e67", "9e72b1af862446dc044fc50ea723c298", "040ed4e9444af229b40842ade65bf5e8", "573612a0b299bee1a434e68bf4c52dde"]) {
      expect(preflight).toContain(md5);
    }
    expect(ISO).toContain("Phase 10C.5 registration isolation postflight: a function is not the generated definition.");
    expect(ISO).toContain("Phase 10C.5 registration isolation postflight: function privileges are wrong.");
  });

  it("never touches rules profiles, existing programs or event rows", () => {
    expect(ISO).not.toMatch(/(update|delete from|insert into|truncate)\s+public\.competition_rules_profiles/i);
    // Outside function bodies the migration only creates/replaces functions and the guard trigger.
    const topLevel = ISO.replace(/\$function\$[\s\S]*?\$function\$/g, "").replace(/\$fn\$[\s\S]*?\$fn\$/g, "");
    expect(topLevel).not.toMatch(/(update|delete from|insert into|truncate)\s+public\./i);
  });

  it("the draft generator no longer writes the event's ordinary registration settings", () => {
    expect(DRAFT).not.toMatch(EVENT_FIELDS);
    // The event row is only written when the organizer changed its page, venue or dates.
    expect(DRAFT).toContain("if v_page <> '{}'::jsonb then\n  update public.events\n  set name = case when v_page ? 'name'");
    expect(DRAFT).toContain("'registration', jsonb_build_object('opens_at', v_opens, 'closes_at', v_closes, 'account_required', v_account),");
  });

  it("wizard programs use their own registration window; legacy programs keep the exact 10C predicate", () => {
    expect(PROGRAM_OPEN).toContain("when p.configuration #> '{setup,registration}' is not null then");
    const legacy = PROGRAM_OPEN.slice(PROGRAM_OPEN.indexOf("            else\n"));
    expect(legacy).toContain("e.registration_required\n              and (e.registration_opens_at is null or e.registration_opens_at <= now())\n              and (e.registration_closes_at is null or e.registration_closes_at >= now())");
    const setup = PROGRAM_OPEN.slice(PROGRAM_OPEN.indexOf("when p.configuration #> '{setup,registration}'"), PROGRAM_OPEN.indexOf("            else\n"));
    expect(setup).not.toMatch(/e\.registration/);
    // Every other condition of the released gate is unchanged.
    for (const condition of ["and e.status = 'published'", "and e.visibility in ('public', 'unlisted')", "and p.status in ('configured', 'active')", "and p.registration_status = 'open'", "and (p.rules_profile_key is null or p.profile_locked_at is not null)"]) {
      expect(PROGRAM_OPEN).toContain(condition);
    }
  });

  it("opening does not depend on, or change, ordinary registration; the commerce holds stay", () => {
    expect(OPEN).toContain("if v_program.configuration #> '{setup,registration}' is null and not v_event.registration_required then");
    expect(OPEN).not.toMatch(/update public\.events/);
    expect(OPEN).toContain("COMP10C_PRICING_PENDING");
    expect(OPEN).toContain("COMP10C_REGISTRATION_HOLD");
    expect(OPEN).toContain("not public.can_manage_event_competition(v_program.event_id)");
  });

  it("checkout's account requirement comes from the competition settings", () => {
    expect(START).toContain("if public.competition_registration_account_required(p_event_id) and p_actor_user_id is null then");
    expect(START).not.toMatch(/if v_event\.account_required_for_registration/);
    expect(ISO).toContain("grant execute on function public.competition_registration_account_required(uuid) to anon, authenticated, service_role;");
  });

  it("client sessions cannot forge or remove a program's competition registration settings", () => {
    const guard = ISO.slice(ISO.indexOf("create function public.protect_competition_program_registration_settings()"));
    expect(guard).toContain("if current_user in ('anon', 'authenticated') then");
    expect(guard).toContain("(tg_op = 'INSERT' and new.configuration #> '{setup,registration}' is not null)");
    expect(guard).toContain("(new.configuration #> '{setup,registration}') is distinct from (old.configuration #> '{setup,registration}')");
    expect(ISO).toContain("before insert or update on public.event_competition_programs");
  });

  it("the rollback refuses while a wizard program is open and restores the 20261114090000 definitions exactly", () => {
    expect(ROLLBACK).toContain("where p.configuration #> '{setup,registration}' is not null and p.registration_status = 'open'");
    for (const md5 of ["a5bd1f13b01df19b4821073419076e67", "9e72b1af862446dc044fc50ea723c298", "040ed4e9444af229b40842ade65bf5e8", "573612a0b299bee1a434e68bf4c52dde"]) {
      expect(ROLLBACK).toContain(md5);
    }
    expect(ROLLBACK).toContain("drop function public.competition_registration_account_required(uuid);");
    expect(ROLLBACK).toContain("drop trigger protect_competition_program_registration_settings on public.event_competition_programs;");
  });
});

describe("registration isolation in the app", () => {
  it("the setup wizard starts competition registration blank and never reads the event's ticket registration", () => {
    const page = read("src/app/app/events/[id]/competition/new/page.tsx");
    expect(page).toContain('initialRegistration={{ opens: "", closes: "", accountRequired: true }}');
    expect(page).not.toMatch(/registration_opens_at|registration_closes_at|account_required_for_registration|registration_required/);
    const wizard = read("src/app/app/events/[id]/competition/new/CompetitionSetupWizard.tsx");
    expect(wizard).toContain("These dates apply only to competition entries. Ticket sales and the event&apos;s own registration settings are not changed");
    expect(wizard).not.toMatch(/existingWindow|the dates here replace it|including any tickets/);
  });

  it("the draft action sends competition settings only to create_competition_draft and never updates the event", () => {
    const actions = read("src/app/app/events/[id]/competition/simpleActions.ts");
    expect(actions).not.toMatch(/from\("events"\)\s*\.update/);
    expect(actions).not.toMatch(/registration_required/);
  });

  it("the competition register page follows the competition gate, not the event's ticket settings", () => {
    const register = read("src/app/events/[slug]/competition/register/page.tsx");
    expect(register).toContain('supabase.rpc("competition_registration_event_open", { p_event_id: event.id })');
    expect(register).toContain('supabase.rpc("competition_registration_account_required", { p_event_id: event.id })');
    // Only an explicit true from the gate opens the form; an error or any other value keeps it closed.
    expect(register).toContain("if (openError || accountError) throw new Error(");
    expect(register).toContain("const registrationOpen = openResult === true;");
    expect(register).toContain("{!registrationOpen ? <div");
    expect(register).not.toMatch(/registration_required|account_required_for_registration|registration_opens_at|registration_closes_at/);
    expect(register).toContain("if (!isCompetitionRegistrationEnabled()) {\n    notFound();");
  });

  it("the public event page: tickets follow registration_required; the competition CTA follows the flag and the competition gate", () => {
    const page = read("src/app/events/[slug]/page.tsx");
    expect(page).toContain("const hasDanceFlowRegistration = typedEvent.registration_required;");
    expect(page).toContain('{ id: "tickets", label: "Tickets", show: hasDanceFlowRegistration }');
    expect(page).toContain(
      'const competitionRegistrationOpen =\n    isCompetitionRegistrationEnabled() &&\n    (typedEvent.event_type === "competition" || typedEvent.event_type === "showcase") &&\n    (await supabase.rpc("competition_registration_event_open", { p_event_id: typedEvent.id })).data === true;',
    );
    // The CTA is rendered after (outside) the ordinary ticket branch, so it does not depend on ticket checkout.
    const ordinaryEnd = page.indexOf("                  </>\n                  )}\n");
    const cta = page.indexOf("{competitionRegistrationOpen ? (");
    expect(ordinaryEnd).toBeGreaterThan(-1);
    expect(cta).toBeGreaterThan(ordinaryEnd);
    expect(page.indexOf("/competition/register")).toBeGreaterThan(cta);
    expect(page.indexOf("/competition/register") - cta).toBeLessThan(1500);
  });

  it("ordinary ticket checkout still requires the event's registration_required and window", () => {
    const checkout = read("src/app/api/events/cart/checkout/route.ts");
    expect(checkout).toMatch(/registration_required/);
    expect(checkout).toMatch(/registration_opens_at/);
    expect(checkout).toMatch(/registration_closes_at/);
  });
});
