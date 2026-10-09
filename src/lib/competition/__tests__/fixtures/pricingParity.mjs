// Phase 10C pricing parity fixtures, shared by
//   src/lib/competition/__tests__/pricingParity.phase10c.test.ts   (TypeScript display quote)
//   src/lib/supabase/migrations/sql-tests/test_T_phase10c_pricing_parity.sql (generated; database quote)
// Expected values are computed by hand (see comments) so neither implementation grades itself.

const BASE = {
  contests: [
    { key: "cA", name: "ProAm Smooth", contest_type: "multi_dance", entry_format: "pro_am", rule: { dance_selection_mode: "individual", pricing_method: "per_dance", base_entry_fee: 0, minimum_dances: 1, maximum_dances: 3, minimum_participants: 2, maximum_participants: 2 } },
    { key: "cB", name: "Solo", contest_type: "single_dance", entry_format: "solo", rule: { dance_selection_mode: "none", pricing_method: "flat_entry", base_entry_fee: 40, minimum_dances: null, maximum_dances: null, minimum_participants: 1, maximum_participants: 1 } },
    { key: "cC", name: "Couples", contest_type: "multi_dance", entry_format: "couple", rule: { dance_selection_mode: "individual", pricing_method: "base_plus_dance", base_entry_fee: 10, minimum_dances: 1, maximum_dances: null, minimum_participants: 2, maximum_participants: 2 } },
    { key: "cD", name: "Team", contest_type: "team", entry_format: "team", rule: { dance_selection_mode: "prescribed_set", pricing_method: "included_set", base_entry_fee: 99.99, minimum_dances: null, maximum_dances: null, minimum_participants: 2, maximum_participants: 6 } },
  ],
  divisions: [
    { key: "dA", contest: "cA", name: "Bronze" },
    { key: "dB", contest: "cB", name: "Open" },
    { key: "dC", contest: "cC", name: "Open Couples" },
    { key: "dD", contest: "cD", name: "Formation" },
  ],
  dances: [
    { key: "nW", dance_key: "waltz", name: "Waltz" },
    { key: "nT", dance_key: "tango", name: "Tango" },
    { key: "nF", dance_key: "foxtrot", name: "Foxtrot" },
  ],
  offerings: [
    { key: "oA1", division: "dA", dance: "nW", entry_fee: 25, required: false, sort_order: 1 },
    { key: "oA2", division: "dA", dance: "nT", entry_fee: 30.5, required: false, sort_order: 2 },
    { key: "oA3", division: "dA", dance: "nF", entry_fee: 19.99, required: true, sort_order: 3 },
    { key: "oC1", division: "dC", dance: "nW", entry_fee: 12.34, required: false, sort_order: 1 },
    { key: "oD1", division: "dD", dance: "nW", entry_fee: 0, required: false, sort_order: 1 },
    { key: "oD2", division: "dD", dance: "nT", entry_fee: 5, required: false, sort_order: 2 },
  ],
};

const FEES_S4 = [
  { key: "f1", name: "Early bird", calculation_type: "discount_flat", registration_mode: "both", amount: 5, percentage: null, starts_at: "2026-01-01T00:00:00Z", ends_at: "2026-02-01T00:00:00Z", priority: 0 },
  { key: "f2", name: "Late fee", calculation_type: "flat_per_entry", registration_mode: "both", amount: 2.5, percentage: null, starts_at: "2026-02-01T00:00:00Z", ends_at: null, priority: 0 },
  { key: "f3", name: "Service", calculation_type: "percentage", registration_mode: "both", amount: 0, percentage: 3.3333, starts_at: null, ends_at: null, priority: 10 },
  { key: "f4", name: "Studio fee", calculation_type: "flat_per_cart", registration_mode: "studio", amount: 20, percentage: null, starts_at: null, ends_at: null, priority: 5 },
  { key: "f5", name: "Per dance surcharge", calculation_type: "flat_per_dance", registration_mode: "both", amount: 1, percentage: null, starts_at: null, ends_at: null, priority: 1, contest: "cA" },
  { key: "f6", name: "Per person", calculation_type: "flat_per_person", registration_mode: "both", amount: 0.75, percentage: null, starts_at: null, ends_at: null, priority: 2 },
];

const PEOPLE_SP = [
  { clientId: "s", firstName: "Sam", lastName: "Student", personType: "student" },
  { clientId: "p", firstName: "Pat", lastName: "Pro", personType: "professional" },
];
const ENTRY_A = (offerings, roles = { s: "student", p: "professional" }) => ({ clientId: "eA", contest: "cA", division: "dA", participantIds: ["s", "p"], participantRoles: roles, selectedOfferingIds: offerings });
const ENTRY_B = { clientId: "eB", contest: "cB", division: "dB", participantIds: ["s"], participantRoles: { s: "dancer" }, selectedOfferingIds: [] };

export const SCENARIOS = [
  {
    // required oA3 (19.99) first, then selected oA1 (25.00) = 44.99
    name: "per-dance with a required offering",
    now: "2026-06-01T00:00:00Z", fees: [], mode: "individual", people: PEOPLE_SP, entries: [ENTRY_A(["oA1"])],
    expected: { valid: true, subtotalCents: 4499, discountCents: 0, totalCents: 4499, lines: ["dance:1999:1:1999", "dance:2500:1:2500"] },
  },
  {
    // solo flat 40.00 + couple base 10.00 + waltz 12.34 = 62.34
    name: "per-entry flat + base plus dance",
    now: "2026-06-01T00:00:00Z", fees: [], mode: "individual",
    people: [{ clientId: "x", firstName: "Xi", lastName: "Lead", personType: "dancer" }, { clientId: "y", firstName: "Yo", lastName: "Follow", personType: "dancer" }],
    entries: [
      { clientId: "eB", contest: "cB", division: "dB", participantIds: ["x"], participantRoles: { x: "dancer" }, selectedOfferingIds: [] },
      { clientId: "eC", contest: "cC", division: "dC", participantIds: ["x", "y"], participantRoles: { x: "leader", y: "follower" }, selectedOfferingIds: ["oC1"] },
    ],
    expected: { valid: true, subtotalCents: 6234, discountCents: 0, totalCents: 6234, lines: ["base_entry:4000:1:4000", "base_entry:1000:1:1000", "dance:1234:1:1234"] },
  },
  {
    // included set: base 99.99 only, both prescribed dances included at no extra charge
    name: "team included set",
    now: "2026-06-01T00:00:00Z", fees: [], mode: "individual",
    people: [{ clientId: "a", firstName: "Ann", lastName: "One", personType: "team_member" }, { clientId: "b", firstName: "Ben", lastName: "Two", personType: "team_member" }],
    entries: [{ clientId: "eD", contest: "cD", division: "dD", participantIds: ["a", "b"], participantRoles: { a: "team_member", b: "team_member" }, selectedOfferingIds: [], teamName: "Spinners" }],
    expected: { valid: true, subtotalCents: 9999, discountCents: 0, totalCents: 9999, lines: ["base_entry:9999:1:9999"] },
  },
  {
    // dances 19.99+25.00+30.50 = 75.49, solo 40 -> 115.49; early bird -5 (window open);
    // per-dance surcharge (cA scoped, 3 dances) 3.00; per person (2) 1.50;
    // service 3.3333% of 119.99 = 3.9996 -> 4.00; subtotal 123.99 - 5 = 118.99
    name: "early-bird window open",
    now: "2026-01-15T00:00:00Z", fees: FEES_S4, mode: "individual", people: PEOPLE_SP, entries: [ENTRY_A(["oA1", "oA2"]), ENTRY_B],
    expected: { valid: true, subtotalCents: 12399, discountCents: 500, totalCents: 11899,
      lines: ["dance:1999:1:1999", "dance:2500:1:2500", "dance:3050:1:3050", "base_entry:4000:1:4000", "discount:500:1:500", "fee:100:3:300", "fee:75:2:150", "fee:400:1:400"] },
  },
  {
    // early bird closed, late fee 2.50 x 2 entries = 5.00; service 3.3333% of 124.99 = 4.1663 -> 4.17
    name: "after early-bird: late fee window",
    now: "2026-03-01T00:00:00Z", fees: FEES_S4, mode: "individual", people: PEOPLE_SP, entries: [ENTRY_A(["oA1", "oA2"]), ENTRY_B],
    expected: { valid: true, subtotalCents: 12916, discountCents: 0, totalCents: 12916,
      lines: ["dance:1999:1:1999", "dance:2500:1:2500", "dance:3050:1:3050", "base_entry:4000:1:4000", "fee:250:2:500", "fee:100:3:300", "fee:75:2:150", "fee:417:1:417"] },
  },
  {
    // studio mode adds the studio-only per-cart fee 20.00 before the service fee:
    // service 3.3333% of 144.99 = 4.8330 -> 4.83
    name: "studio-only fee rule",
    now: "2026-03-01T00:00:00Z", fees: FEES_S4, mode: "studio", people: PEOPLE_SP, entries: [ENTRY_A(["oA1", "oA2"]), ENTRY_B],
    expected: { valid: true, subtotalCents: 14982, discountCents: 0, totalCents: 14982,
      lines: ["dance:1999:1:1999", "dance:2500:1:2500", "dance:3050:1:3050", "base_entry:4000:1:4000", "fee:250:2:500", "fee:100:3:300", "fee:75:2:150", "fee:2000:1:2000", "fee:483:1:483"] },
  },
  {
    // 10% of 40.00 = 4.00 discount, then a 100.00 discount: discount capped at the subtotal
    name: "discounts capped at subtotal",
    now: "2026-06-01T00:00:00Z", mode: "individual", people: PEOPLE_SP, entries: [ENTRY_B],
    fees: [
      { key: "f7", name: "Member discount", calculation_type: "discount_percentage", registration_mode: "both", amount: 0, percentage: 10, starts_at: null, ends_at: null, priority: 0 },
      { key: "f8", name: "Voucher", calculation_type: "discount_flat", registration_mode: "both", amount: 100, percentage: null, starts_at: null, ends_at: null, priority: 1 },
    ],
    expected: { valid: true, subtotalCents: 4000, discountCents: 4000, totalCents: 0, lines: ["base_entry:4000:1:4000", "discount:400:1:400", "discount:10000:1:10000"] },
  },
  {
    // same priority: name order (byte order) decides -> "A flat" (10.00) before "B pct" (10% of 50.00)
    name: "fee ordering by priority then name",
    now: "2026-06-01T00:00:00Z", mode: "individual", people: PEOPLE_SP, entries: [ENTRY_B],
    fees: [
      { key: "f9", name: "B pct", calculation_type: "percentage", registration_mode: "both", amount: 0, percentage: 10, starts_at: null, ends_at: null, priority: 0 },
      { key: "fa", name: "A flat", calculation_type: "flat_per_cart", registration_mode: "both", amount: 10, percentage: null, starts_at: null, ends_at: null, priority: 0 },
    ],
    expected: { valid: true, subtotalCents: 5500, discountCents: 0, totalCents: 5500, lines: ["base_entry:4000:1:4000", "fee:1000:1:1000", "fee:500:1:500"] },
  },
  {
    // starts_at == now is inside the window; ends_at == now is outside
    name: "window boundaries",
    now: "2026-05-01T00:00:00Z", mode: "individual", people: PEOPLE_SP, entries: [ENTRY_B],
    fees: [
      { key: "fb", name: "Starts now", calculation_type: "flat_per_cart", registration_mode: "both", amount: 3, percentage: null, starts_at: "2026-05-01T00:00:00Z", ends_at: null, priority: 0 },
      { key: "fc", name: "Ended now", calculation_type: "discount_flat", registration_mode: "both", amount: 1, percentage: null, starts_at: null, ends_at: "2026-05-01T00:00:00Z", priority: 0 },
    ],
    expected: { valid: true, subtotalCents: 4300, discountCents: 0, totalCents: 4300, lines: ["base_entry:4000:1:4000", "fee:300:1:300"] },
  },
  {
    // ProAm entries need student/professional roles
    name: "invalid roles are refused by both",
    now: "2026-06-01T00:00:00Z", fees: [], mode: "individual", people: PEOPLE_SP, entries: [ENTRY_A(["oA1"], { s: "leader", p: "follower" })],
    expected: { valid: false },
  },
];

const KIND = { program: "1", contest: "2", division: "3", dance: "4", offering: "5", fee: "7", event: "e" };

/** Deterministic UUID for a symbolic id inside scenario n (hex only). */
export function uuidFor(scenarioIndex, kind, key) {
  const scenario = scenarioIndex.toString(16).padStart(2, "0");
  const index = key === "" ? "000" : (KEYS[kind].indexOf(key) + 1).toString(16).padStart(3, "0");
  return `00000000-0000-0000-0000-0c10cb${scenario}${KIND[kind]}${index}`;
}

const KEYS = {
  program: [""],
  event: [""],
  contest: BASE.contests.map((item) => item.key),
  division: BASE.divisions.map((item) => item.key),
  dance: BASE.dances.map((item) => item.key),
  offering: BASE.offerings.map((item) => item.key),
  fee: ["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "fa", "fb", "fc"],
};

/** Concrete catalog + draft for scenario n (shared by both implementations). */
export function materialize(index) {
  const scenario = SCENARIOS[index];
  const id = (kind, key) => uuidFor(index, kind, key);
  const programId = id("program", "");
  const contestById = Object.fromEntries(BASE.contests.map((item) => [item.key, item]));
  const catalog = {
    programs: [{ id: programId, name: "Parity", discipline_family: "ballroom" }],
    contests: BASE.contests.map((item) => ({ id: id("contest", item.key), program_id: programId, name: item.name, contest_type: item.contest_type, entry_format: item.entry_format })),
    divisions: BASE.divisions.map((item) => ({ id: id("division", item.key), program_id: programId, contest_id: id("contest", item.contest), name: item.name, age_label: null, skill_label: null, role_label: null })),
    offerings: BASE.offerings.map((item) => ({
      id: id("offering", item.key), program_id: programId, division_id: id("division", item.division), dance_id: id("dance", item.dance),
      entry_fee: item.entry_fee, currency: "USD", required: item.required, sort_order: item.sort_order,
      dance: { dance_key: BASE.dances.find((dance) => dance.key === item.dance).dance_key, name: BASE.dances.find((dance) => dance.key === item.dance).name, category_label: null },
    })),
    rules: BASE.contests.map((item) => ({
      id: `rule-${item.key}`, program_id: programId, contest_id: id("contest", item.key), ...item.rule, currency: "USD",
      requires_routine_title: false, requires_music: false, requires_duration: false, public_description: null, terminology: {},
    })),
    feeRules: scenario.fees.map((fee) => ({
      id: id("fee", fee.key), program_id: fee.contest ? programId : null, contest_id: fee.contest ? id("contest", fee.contest) : null, division_id: null,
      name: fee.name, calculation_type: fee.calculation_type, registration_mode: fee.registration_mode, amount: fee.amount, percentage: fee.percentage,
      currency: "USD", priority: fee.priority, starts_at: fee.starts_at, ends_at: fee.ends_at, active: true,
    })),
  };
  const draft = {
    registrationMode: scenario.mode,
    buyerName: "Parity Buyer",
    buyerEmail: "parity@example.test",
    ...(scenario.mode === "studio" ? { registeringStudioName: "Parity Studio" } : {}),
    people: scenario.people,
    entries: scenario.entries.map((entry) => ({
      clientId: entry.clientId, programId, contestId: id("contest", entry.contest), divisionId: id("division", entry.division),
      participantIds: entry.participantIds, participantRoles: entry.participantRoles,
      selectedOfferingIds: entry.selectedOfferingIds.map((key) => id("offering", key)),
      ...(entry.teamName ? { teamName: entry.teamName } : {}),
    })),
  };
  return { scenario, catalog, draft, contestById, eventId: id("event", "") };
}

function sqlString(value) {
  return value == null ? "null" : `'${String(value).replaceAll("'", "''")}'`;
}

/** The generated SQL parity suite (committed; a vitest test fails if it drifts from this generator). */
export function generateParitySql() {
  const out = [];
  out.push("-- GENERATED by src/lib/competition/__tests__/fixtures/pricingParity.mjs -- do not edit by hand.");
  out.push("-- Phase 10C: the database quote (_comp10c_quote) must produce exactly the hand-computed expectations");
  out.push("-- that the TypeScript display quote is also held to (pricingParity.phase10c.test.ts).");
  out.push("-- One transaction; the final block always raises, so nothing persists.");
  out.push("");
  out.push("begin;");
  out.push("create temp table t_results (name text, ok boolean, detail text) on commit drop;");
  out.push("insert into public.studios (id, name, slug) values ('00000000-0000-0000-0000-0c10cb00a001', 'P10C Parity Studio', 't-p10c-parity');");
  SCENARIOS.forEach((_, index) => {
    const { catalog, draft, eventId } = materialize(index);
    const program = catalog.programs[0];
    out.push(`-- scenario ${index}: ${SCENARIOS[index].name}`);
    out.push(`insert into public.events (id, studio_id, name, slug, event_type, start_date, end_date, status, visibility, registration_required, account_required_for_registration) values (${sqlString(eventId)}, '00000000-0000-0000-0000-0c10cb00a001', 'Parity ${index}', 't-p10c-parity-${index}', 'competition', current_date + 30, current_date + 30, 'published', 'public', true, false);`);
    out.push(`insert into public.event_competition_programs (id, event_id, studio_id, name, discipline_family, competition_mode, scoring_method, status) values (${sqlString(program.id)}, ${sqlString(eventId)}, '00000000-0000-0000-0000-0c10cb00a001', 'Parity', 'ballroom', 'relative', 'skating', 'configured');`);
    out.push(`update public.event_competition_programs set registration_status = 'open', registration_opened_at = now() where id = ${sqlString(program.id)};`);
    for (const contest of catalog.contests) {
      out.push(`insert into public.event_competition_contests (id, event_id, program_id, name, contest_type, entry_format, status) values (${sqlString(contest.id)}, ${sqlString(eventId)}, ${sqlString(program.id)}, ${sqlString(contest.name)}, ${sqlString(contest.contest_type)}, ${sqlString(contest.entry_format)}, 'open');`);
    }
    for (const rule of catalog.rules) {
      out.push(`update public.event_competition_contest_registration_rules set registration_open = true, dance_selection_mode = ${sqlString(rule.dance_selection_mode)}, pricing_method = ${sqlString(rule.pricing_method)}, base_entry_fee = ${rule.base_entry_fee}, currency = 'USD', minimum_dances = ${rule.minimum_dances ?? "null"}, maximum_dances = ${rule.maximum_dances ?? "null"}, minimum_participants = ${rule.minimum_participants}, maximum_participants = ${rule.maximum_participants}, requires_routine_title = false, requires_music = false, requires_duration = false where contest_id = ${sqlString(rule.contest_id)};`);
    }
    for (const division of catalog.divisions) {
      out.push(`insert into public.event_competition_divisions (id, event_id, program_id, contest_id, name, status) values (${sqlString(division.id)}, ${sqlString(eventId)}, ${sqlString(program.id)}, ${sqlString(division.contest_id)}, ${sqlString(division.name)}, 'open');`);
    }
    for (const dance of BASE.dances) {
      out.push(`insert into public.event_competition_dances (id, event_id, program_id, dance_key, name, active) values (${sqlString(uuidFor(index, "dance", dance.key))}, ${sqlString(eventId)}, ${sqlString(program.id)}, ${sqlString(dance.dance_key)}, ${sqlString(dance.name)}, true);`);
    }
    for (const offering of catalog.offerings) {
      out.push(`insert into public.event_competition_division_dances (id, event_id, program_id, division_id, dance_id, entry_fee, currency, required, active, sort_order) values (${sqlString(offering.id)}, ${sqlString(eventId)}, ${sqlString(program.id)}, ${sqlString(offering.division_id)}, ${sqlString(offering.dance_id)}, ${offering.entry_fee}, 'USD', ${offering.required}, true, ${offering.sort_order});`);
    }
    for (const fee of catalog.feeRules) {
      out.push(`insert into public.event_competition_fee_rules (id, event_id, program_id, contest_id, name, calculation_type, registration_mode, amount, percentage, currency, starts_at, ends_at, active, priority) values (${sqlString(fee.id)}, ${sqlString(eventId)}, ${sqlString(fee.program_id)}, ${sqlString(fee.contest_id)}, ${sqlString(fee.name)}, ${sqlString(fee.calculation_type)}, ${sqlString(fee.registration_mode)}, ${fee.amount}, ${fee.percentage ?? "null"}, 'USD', ${sqlString(fee.starts_at)}, ${sqlString(fee.ends_at)}, true, ${fee.priority});`);
    }
    const expected = SCENARIOS[index].expected;
    const quote = `public._comp10c_quote(${sqlString(eventId)}, ${sqlString(JSON.stringify(draft))}::jsonb, ${sqlString(SCENARIOS[index].now)}::timestamptz)`;
    if (expected.valid) {
      const lines = `(select coalesce(string_agg((l->>'lineType') || ':' || (l->>'unitCents') || ':' || (l->>'quantity') || ':' || (l->>'lineCents'), ',' order by o), '') from jsonb_array_elements(q->'lines') with ordinality x(l, o))`;
      out.push(`insert into t_results select ${sqlString(`parity ${index}: ${SCENARIOS[index].name}`)},`);
      out.push(`  (q->>'valid')::boolean and (q->>'subtotal_cents')::bigint = ${expected.subtotalCents} and (q->>'discount_cents')::bigint = ${expected.discountCents} and (q->>'total_cents')::bigint = ${expected.totalCents} and ${lines} = ${sqlString(expected.lines.join(","))},`);
      out.push(`  q::text from (select ${quote} as q) s;`);
    } else {
      out.push(`insert into t_results select ${sqlString(`parity ${index}: ${SCENARIOS[index].name}`)}, not (q->>'valid')::boolean, q::text from (select ${quote} as q) s;`);
    }
  });
  out.push("do $$");
  out.push("declare v_total int; v_failures text;");
  out.push("begin");
  out.push("  select count(*) into v_total from t_results;");
  out.push("  select string_agg(name || ' [' || detail || ']', '; ') into v_failures from t_results where not ok;");
  out.push("  if v_failures is null then raise exception 'PHASE 10C PRICING PARITY PASS (% scenarios)', v_total; end if;");
  out.push("  raise exception 'PHASE 10C PRICING PARITY FAIL: %', v_failures;");
  out.push("end $$;");
  return `${out.join("\n")}\n`;
}
