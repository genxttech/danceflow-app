// R-12 (owner ratification 2026-11-24): static pins of the authorization paths of the seven Studio/Custom operational behaviors.
// NO DATABASE. This reads the migration SQL text only: it proves the gates are WRITTEN as ratified, not that the database behaves
// as written (the SQL suites named in docs/competition/governance/r12-operational-verification.md do that, and are run separately).
// These are DanceFlow Studio/Custom policy pins, never governing-body requirements.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const MIG = join(ROOT, "src/lib/supabase/migrations");
const files = readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort();
const text = new Map(files.map((f) => [f, readFileSync(join(MIG, f), "utf8").replace(/\r/g, "")]));
const sql = (prefix: string) => {
  const f = files.find((x) => x.startsWith(prefix));
  if (!f) throw new Error(`migration ${prefix} not found`);
  return text.get(f)!;
};

/** Body of `create [or replace] function public.<name>(` up to the closing `$$;`. */
function fnBody(source: string, name: string): string {
  const re = new RegExp(`create (?:or replace )?function public\\.${name}\\(`);
  const m = re.exec(source);
  if (!m) throw new Error(`function ${name} not found`);
  const end = source.indexOf("\n$$;", m.index);
  return source.slice(m.index, end === -1 ? undefined : end + 4);
}
/** Number of migrations that (re)define public.<name>. 1 means the definition read here is the current one. */
function definitions(name: string): string[] {
  const re = new RegExp(`create (?:or replace )?function public\\.${name}\\(`);
  return files.filter((f) => re.test(text.get(f)!));
}
const all = [...text.values()].join("\n");

const A5 = sql("20270120094000");
const A6 = sql("20270120095000");
const A7 = sql("20270120095500");
const U66 = sql("20270120103000");
const R2 = sql("20270103090000");
const O1 = sql("20270106090000");
const E2 = sql("20270102090000");
const F2 = sql("20270114090000");
const F3 = sql("20270122090000");
const NS1 = sql("20270115090000");
const OJ1 = sql("20270215091000");

describe("R-12 current definitions are single-sourced (what is read here is what runs)", () => {
  const names = [
    "request_round_exclusion", "cosign_round_exclusion", "request_round_exclusion_reversal", "cosign_round_exclusion_reversal",
    "recover_correction_for_exclusion", "_r2_withdraw_entry", "_r2_apply_participation", "resolve_competition_refund_scope",
    "reopen_competition_round_ballots", "lock_competition_round_ballots", "publish_competition_round_result", "cancel_competition_round",
    "_compo1_guard_round_status", "set_competition_chair", "clear_competition_chair", "approve_competition_round_result",
    "calculate_competition_round", "complete_competition_round", "open_competition_round_correction", "_compe2_round_role",
  ];
  for (const n of names) {
    it(`${n} is defined by exactly one migration`, () => expect(definitions(n)).toHaveLength(1));
  }
  it("sync_competition_entries_from_registration: R2 is the last definition", () => {
    const d = definitions("sync_competition_entries_from_registration");
    expect(d[d.length - 1]).toBe("20270103090000_competition_r2_entry_refunds.sql");
  });
  it("_compe2_round_role is patched in place by OJ-1 (chair and scorer branches require an active team member)", () => {
    expect(OJ1).toContain("public._compe2_round_role(uuid)");
    expect(OJ1).toMatch(/o\.role = 'chair' and o\.status = 'active'\s+and public\._comp_e1_is_team_member/);
  });
});

describe("R-12 (1) organizer exclusion: request manager-only, independent co-sign, no ballot rewrite", () => {
  it("only a manager requests an exclusion or a reversal", () => {
    expect(fnBody(A5, "request_round_exclusion")).toMatch(/_compe2_round_role\(p_round_id\) is distinct from 'manager'/);
    expect(fnBody(A5, "request_round_exclusion_reversal")).toMatch(/_compe2_round_role\(p_round_id\) is distinct from 'manager'/);
  });
  it("co-sign is manager or chair, never the requester, never a replacement-ballot filer", () => {
    for (const n of ["cosign_round_exclusion", "cosign_round_exclusion_reversal"]) {
      const b = fnBody(A5, n);
      expect(b).toMatch(/not in \('manager', 'chair'\)/);
      expect(b).toContain("COMP_EXCLUSION_COSIGN_SAME_PERSON");
      expect(b).toContain("COMP_EXCLUSION_COSIGNER_FILED_BALLOT");
      expect(b).toContain("COMP_VERIFIED_EMAIL_REQUIRED");
    }
  });
  it("window is active/ballots_locked only and refused once a publication exists", () => {
    const b = fnBody(A5, "request_round_exclusion");
    expect(b).toContain("v_round.status not in ('active', 'ballots_locked')");
    expect(b).toContain("_a5_cf1_require_no_publication");
    expect(fnBody(A5, "_a5_cf1_require_no_publication")).toContain("COMP_EXCLUSION_PUBLICATION_EXISTS");
  });
  it("the exclusion functions never write ballots or marks", () => {
    for (const n of ["request_round_exclusion", "cosign_round_exclusion", "request_round_exclusion_reversal", "cosign_round_exclusion_reversal"]) {
      expect(fnBody(A5, n)).not.toMatch(/(insert into|update|delete from)\s+public\.event_competition_(ballots|marks)\b/);
    }
  });
  it("grants: authenticated only, revoked from public/anon/service_role; the table has no client grants", () => {
    for (const sig of ["request_round_exclusion(uuid, uuid, text, text, uuid)", "cosign_round_exclusion(uuid, uuid)",
      "request_round_exclusion_reversal(uuid, uuid, text, uuid)", "cosign_round_exclusion_reversal(uuid, uuid)"]) {
      expect(A5).toContain(`revoke all on function public.${sig} from public, anon, service_role;`);
      expect(A5).toContain(`grant execute on function public.${sig} to authenticated;`);
    }
    expect(sql("20270120085000")).toContain("revoke all on public.event_competition_round_exclusions from public, anon, authenticated, service_role;");
    expect(all).not.toMatch(/grant\s+[a-z, ]*(insert|update|delete)[a-z, ]*\s+on\s+(table\s+)?public\.event_competition_round_exclusions/i);
  });
  it("the label policy: no SQL string calls an exclusion a disqualification", () => {
    expect(fnBody(A5, "request_round_exclusion")).not.toMatch(/disqualif/i);
  });
});

describe("R-12 (2) correction recovery", () => {
  it("an exclusion decision is refused while a correction is open (A7 trigger, ENABLE ALWAYS)", () => {
    expect(A7).toContain("COMP_CORRECTION_EXCLUSION_DURING_CORRECTION");
    expect(A7).toContain("alter table public.event_competition_round_exclusions enable always trigger cf1_a7_guard_exclusion_during_correction;");
  });
  it("the U66 blockers include current publication, replacement ballot, co-sign, live result version and active advancement", () => {
    const b = fnBody(U66, "_cf1_u66_blockers");
    for (const k of ["current_publication", "replacement_ballot", "cosign", "live_result_version", "active_advancement"]) expect(b).toContain(`'${k}'`);
    expect(b).toMatch(/withdrawn_at is null and p\.superseded_by is null/);
    expect(b).toMatch(/v\.status in \('calculated', 'approved'\)/);
  });
  it("the wrong-shape publication lookup fails closed (treated as a current publication)", () => {
    expect(fnBody(U66, "_cf1_u66_blockers")).toMatch(/v_pub := true;/);
  });
  it("correction_open is cleared only by the trigger that needs the same-transaction U66 audit row; recovery is manager-only; nothing is deleted", () => {
    const t = fnBody(U66, "cf1_u66_clear_correction_open");
    expect(t).toContain("u66_recovery");
    expect(t).toContain("e.transaction_id = txid_current()");
    expect(U66).toContain("alter table public.event_competition_rounds enable always trigger zz_cf1_u66_clear_correction_open;");
    const r = fnBody(U66, "recover_correction_for_exclusion");
    expect(r).toMatch(/_compe2_round_role\(p_round_id\) is distinct from 'manager'/);
    expect(r).toMatch(/cardinality\(v_block\) > 0/);
    expect(r).not.toMatch(/delete from/i);
  });
  it("E2 reopen is blocked after a recovery until recalculation (COMP_REOPEN_RECOVERY_PENDING)", () => {
    expect(fnBody(U66, "cf1_u66_block_reopen")).toContain("COMP_REOPEN_RECOVERY_PENDING");
    expect(U66).toContain("alter table public.event_competition_rounds enable always trigger cf1_u66_block_reopen;");
  });
});

describe("R-12 (3) refund-driven withdrawal: only entries that have not danced", () => {
  it("the participation class gates the automatic withdrawal; held entries raise an exception instead", () => {
    const b = fnBody(R2, "_r2_apply_participation");
    expect(b).toMatch(/v_class in \('unplaced', 'open'\)/);
    expect(b).toContain("_r2_withdraw_entry");
    expect(b).toContain("_r2_record_refund_exception");
    expect(b).toContain("'exception_open'");
  });
  it("the class treats a danced / disqualified placement and a heat on the floor as held", () => {
    const b = fnBody(R2, "_r2_entry_participation_class");
    expect(b).toMatch(/he\.status in \('danced', 'disqualified'\)/);
    expect(b).toMatch(/h\.status in \('active', 'complete'\)/);
  });
  it("the registration trigger skips danced and locked/certified entries and records an exception for held ones", () => {
    const b = fnBody(R2, "sync_competition_entries_from_registration");
    expect(b).toMatch(/h\.lock_state in \('locked', 'certified'\)/);
    expect(b).toMatch(/he\.status in \('danced', 'disqualified'\)/);
    expect(b).toMatch(/v_held\.cls in \('locked', 'certified'\)/);
  });
  it("scopes carry competitive_effect only with an entry; a financial-only parent writes no scope", () => {
    const b = fnBody(R2, "_r2_record_refund_exception");
    expect(b).toMatch(/if p_entry_id is not null then[\s\S]*insert into public\.event_competition_refund_exception_scopes/);
    expect(fnBody(R2, "_r2_record_unattributed")).toMatch(/_r2_record_refund_exception\('competition_refund_unattributed'[^;]*null,\s*v_r\.amount_cents/);
  });
  it("withdraw/participation helpers are not reachable by client roles; scope resolution needs an owner/admin", () => {
    expect(R2).toContain("revoke all on function public._r2_withdraw_entry(uuid, text, text) from public, anon, authenticated;");
    expect(R2).toContain("revoke all on function public._r2_apply_participation(uuid) from public, anon, authenticated;");
    expect(fnBody(R2, "resolve_competition_refund_scope")).toContain("_paywh1_actor_can_manage_exception");
  });
  it("exception scopes are append-only and have no client write grants", () => {
    expect(R2).toContain("revoke all on public.event_competition_refund_exception_scopes from public, anon, authenticated;");
    expect(R2).toContain("grant select on public.event_competition_refund_exception_scopes to authenticated;");
    expect(fnBody(R2, "_r2_protect_exception_scopes")).toContain("COMP_REFUND_SCOPE_IMMUTABLE");
  });
});

describe("R-12 (4) reopen ballots: manager, reason, locked and unapproved only", () => {
  const b = fnBody(E2, "reopen_competition_round_ballots");
  it("manager only (the chair is refused), reason required", () => {
    expect(b).toMatch(/v_role is distinct from 'manager'/);
    expect(b).toContain("COMP_RESULT_REASON_REQUIRED");
  });
  it("only ballots_locked; approved/published result versions and any publication row refuse; unknown shape fails closed", () => {
    expect(b).toMatch(/v_round\.status <> 'ballots_locked'/);
    expect(b).toMatch(/v\.status in \(''approved'', ''published''\)/);
    expect(b).toContain("event_competition_result_publications");
    expect(b).toContain("when undefined_column or undefined_table");
  });
  it("the ballots_locked -> active edge is written only by the lock/reopen functions (audit row in the same transaction)", () => {
    expect(fnBody(E2, "_compe2_guard_round_lock_edges")).toContain("e.transaction_id = txid_current()");
    expect(fnBody(O1, "_compo1_guard_round_status")).toMatch(/current_user in \('anon', 'authenticated', 'service_role', 'authenticator'\)/);
  });
});

describe("R-12 (5) publication holds: fail closed, no override parameter", () => {
  const b = fnBody(F3, "publish_competition_round_result");
  it("manager only with a verified email", () => {
    expect(b).toMatch(/_compe2_round_role\(p_round_id\) is distinct from 'manager'/);
    expect(b).toContain("COMP_VERIFIED_EMAIL_REQUIRED");
  });
  it("has no override/force/skip parameter", () => {
    const sig = /create function public\.publish_competition_round_result\(([\s\S]*?)\) returns/.exec(F3)![1];
    expect(sig).not.toMatch(/override|force|skip|ignore|bypass/i);
    expect(b).not.toMatch(/override/i);
  });
  it("stale hash, undecided tie, advancement mismatch, refund exception and roster each refuse", () => {
    expect(b).toContain("COMP_RESULT_STALE");
    expect(b).toMatch(/rr\.advanced is null/);
    expect(b).toContain("COMP_PUBLICATION_UNRESOLVED");
    expect(b).toMatch(/s\.round_id = \$1 and s\.competitive_effect and s\.resolved_at is null/);
    expect(b).toContain("COMP_PUBLICATION_BLOCKED_BY_EXCEPTION");
    expect(b).toContain("_cf1_require_roster_eligible(p_round_id, 'approve')");
  });
  it("an unknown exception-table shape fails closed, a deadlock/timeout is not swallowed", () => {
    expect(b).toMatch(/exception when undefined_table or undefined_column or datatype_mismatch/);
    expect(b).not.toMatch(/exception when others/);
  });
  it("publication rows have no client write grants", () => {
    expect(F3).toContain("revoke all on public.event_competition_result_publications from public, anon, authenticated, service_role;");
    expect(F3).toContain("grant select on public.event_competition_result_publications to authenticated;");
  });
  it("approve keeps the stale-hash check before the (reasoned) second-approver override; the override never skips it", () => {
    const a = fnBody(F2, "approve_competition_round_result");
    expect(a.indexOf("COMP_RESULT_STALE: the ballots changed")).toBeGreaterThan(-1);
    expect(a.indexOf("COMP_RESULT_STALE: the ballots changed")).toBeLessThan(a.indexOf("v_override :="));
  });
});

describe("R-12 (6) round cancellation", () => {
  const b = fnBody(O1, "cancel_competition_round");
  it("manager authorization, request id, validated reason", () => {
    expect(b).toContain("can_manage_event_competition(v_event)");
    expect(b).toContain("COMPO1_REASON_REQUIRED");
    expect(b).toMatch(/length\(v_reason\) < 3 or length\(v_reason\) > 500/);
  });
  it("refuses cancelled/complete, any publication and a heat on the floor", () => {
    expect(b).toMatch(/v_status in \('cancelled', 'complete'\)/);
    expect(b).toContain("COMPO1_PUBLISHED");
    expect(b).toMatch(/h\.status in \('staging', 'active'\)/);
    expect(b).toContain("COMPO1_HEAT_RUNNING");
  });
  it("only draft/scheduled open heats are cancelled; complete heats stay as the record", () => {
    expect(b).toMatch(/status in \('draft', 'scheduled'\) and lock_state = 'open'/);
    expect(b).not.toMatch(/delete from/i);
  });
  it("cancelled and complete are terminal for every status writer; client roles cannot write status", () => {
    const g = fnBody(O1, "_compo1_guard_round_status");
    expect(g).toMatch(/old\.status in \('cancelled', 'complete'\)/);
    expect(g).toContain("COMPO1_ROUND_TERMINAL");
    expect(g).toMatch(/new\.status in \('scheduled', 'cancelled'\)/);
  });
  it("grants: authenticated only", () => {
    expect(O1).toContain("revoke all on function public.cancel_competition_round(uuid, text, uuid) from public, anon;");
    expect(O1).toContain("grant execute on function public.cancel_competition_round(uuid, text, uuid) to authenticated;");
  });
});

describe("R-12 (7) Studio chair authority", () => {
  it("the chair may lock ballots, record absence, mark and void no-shows, and co-sign", () => {
    expect(fnBody(E2, "lock_competition_round_ballots")).toMatch(/not in \('manager', 'chair'\)/);
    expect(fnBody(E2, "record_competition_judge_attendance")).toMatch(/not in \('manager', 'chair'\)/);
    expect(NS1).toMatch(/mark_competition_heat_no_show[\s\S]*not in \('manager', 'chair'\)/);
    expect(fnBody(A5, "cosign_round_exclusion")).toMatch(/not in \('manager', 'chair'\)/);
    expect(A6).toMatch(/cosign_final_withdrawal_request[\s\S]*v_role not in \('manager', 'chair'\)/);
    expect(fnBody(A7, "cosign_competition_correction")).toMatch(/not in \('manager', 'chair'\)/);
  });
  it("the chair is refused: initiate exclusion/reversal, recover correction, reopen, approve, complete, open correction", () => {
    expect(fnBody(A5, "request_round_exclusion")).toMatch(/is distinct from 'manager'/);
    expect(fnBody(A5, "request_round_exclusion_reversal")).toMatch(/is distinct from 'manager'/);
    expect(fnBody(U66, "recover_correction_for_exclusion")).toMatch(/is distinct from 'manager'/);
    expect(fnBody(E2, "reopen_competition_round_ballots")).toMatch(/is distinct from 'manager'/);
    for (const n of ["approve_competition_round_result", "complete_competition_round", "open_competition_round_correction"]) {
      expect(fnBody(F2, n)).toMatch(/v_role is distinct from 'manager'/);
    }
    expect(fnBody(F3, "publish_competition_round_result")).toMatch(/is distinct from 'manager'/);
    expect(A6).toMatch(/_cf1_a6_request[\s\S]*_compe2_round_role\(p_round_id\) is distinct from 'manager'/);
  });
  it("the chair cannot calculate: only manager and scorer are allowed", () => {
    expect(fnBody(F2, "calculate_competition_round")).toMatch(/not in \('manager', 'scorer'\)/);
  });
  it("cancel and the running order (10D/O1 writers) are manager-gated by can_manage_event_competition, which has no chair branch", () => {
    for (const n of ["schedule_competition_round", "start_competition_round", "cancel_competition_round", "advance_competition_floor_heat"]) {
      expect(fnBody(O1, n)).toContain("can_manage_event_competition");
    }
    const d = sql("20261111090000");
    expect(fnBody(d, "_comp10d_require_draft")).toContain("can_manage_event_competition");
    for (const n of ["apply_competition_floor_plan", "move_competition_floor_heat", "insert_competition_floor_heat", "delete_competition_floor_heat"]) {
      expect(fnBody(d, n)).toContain("_comp10d_require_draft");
    }
    const mgr = fnBody(sql("20261107090000"), "can_manage_event_competition");
    expect(mgr).not.toMatch(/event_competition_officials/);
  });
  it("chair designation is a manager action and exactly one active chair per event (partial unique index)", () => {
    expect(sql("20270101090000")).toMatch(/on public\.event_competition_officials\(event_id\) where role = 'chair' and status = 'active'/);
    expect(fnBody(sql("20270101090000"), "set_competition_chair")).toContain("_comp_e1_authorize");
    expect(fnBody(sql("20270101090000"), "_comp_e1_authorize")).toContain("can_manage_event_competition");
  });
  it("no chair-precedence leak: _compe2_round_role tests manager first, then chair, then scorer", () => {
    const b = fnBody(E2, "_compe2_round_role");
    expect(b.indexOf("return 'manager'")).toBeLessThan(b.indexOf("return 'chair'"));
    expect(b.indexOf("return 'chair'")).toBeLessThan(b.indexOf("return 'scorer'"));
  });
});
