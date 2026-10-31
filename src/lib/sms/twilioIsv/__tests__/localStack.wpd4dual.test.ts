/**
 * WP-D4: dual-control simulation matrix with synthetic administrators, on a throwaway DEV-equivalent database.
 * Surfaces (every database-enforced two-person control in the TW-4F SMS chain): the dual request table (studio_sms_rfl_dual_requests) with its two consumers,
 *   ABS = tw4_rfl_exposure_dispose (absorb a provider-fee exposure)   CAN = tw4_rfl_cancel_authorize (release a phone number), read back by tw4_rfl_cancel_target
 * (SMS PRICING dual control was proved here in WP-D4 against a proposed correction; D4-1 made it a real migration and its matrix lives in localStack.pricedual.test.ts.)
 *
 * Cast (all synthetic, distinct ids): A, B platform administrators (aal2 sessions); C not an administrator; D administrator whose session is aal1 (see localStack.wpd4actions);
 * E deactivated administrator; F a third administrator; G administrator whose auth user is banned.
 *
 * LOCAL QA DATABASE ONLY: TW4A_LOCAL_DB_CONTAINER + TW4RFL_DB, and the tw4_local_qa_only marker. Nothing reaches Twilio, Stripe or any message channel.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  A, B, C, CR, D, E, F, G, NOTE, PG, DB, REASON, RUN, absorbRequest, absorbRequestErr, approve, approveErr, audit, auditActors, authorizeNum, bumpEpoch, call, callErr, cancelRequest,
  cancelRequestErr, codeOf, dispose, enabled, exposed, exposureOf, expire, hasCode, mkUser, money, num, psql, psqlError, ref, register, rejectErr, reqRow, reqStatus, replica, rows,
  seedCast, seedPrices, setRole, world,
} from "./wpd4Helpers";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

type Ctx = { w: ReturnType<typeof world>; resourceId: string; key: string | null; approval: string | null };
type Surface = {
  id: "ABS" | "CAN";
  setup: () => Ctx;
  request: (c: Ctx, actor: string) => { request_id: string; status: string; replayed: boolean };
  requestErr: (c: Ctx, actor: string) => string;
  exec: (c: Ctx, actor: string) => string; // "" = success, otherwise the psql error text
  done: (c: Ctx) => boolean; // did the guarded action take effect?
  mutate: (c: Ctx) => void; // a bound fact changes
};
const EXPECTED_NUMBER_COST = () => num(`select provider_cost_cents from public.studio_sms_price_list where kind = 'number' and active`);

const ABS: Surface = {
  id: "ABS",
  setup: () => {
    const w = world();
    const { res, key } = exposed(w, "number");
    return { w, resourceId: res.resource_id, key, approval: null };
  },
  request: (c, actor) => absorbRequest(c.resourceId, c.key!, actor),
  requestErr: (c, actor) => absorbRequestErr(c.resourceId, c.key!, actor),
  exec: (c, actor) => dispose(c.resourceId, c.key!, actor),
  done: (c) => exposureOf(c.resourceId, c.key!).state === "closed",
  mutate: (c) => void call("tw4_rfl_observe_provider_bill", c.resourceId, c.key, `INV-${RUN}-${c.w.n}-late`, EXPECTED_NUMBER_COST(), A),
};
const CAN: Surface = {
  id: "CAN",
  setup: () => {
    const w = world();
    const n = register(w, "number");
    return { w, resourceId: n.resource_id, key: null, approval: ref(`release-${w.n}`) };
  },
  request: (c, actor) => cancelRequest(c.resourceId, c.approval!, actor),
  requestErr: (c, actor) => cancelRequestErr(c.resourceId, c.approval!, actor),
  exec: (c, actor) => authorizeNum(c.resourceId, c.approval!, actor),
  done: (c) => num(`select count(*) from public.studio_sms_provider_cancel_ops where resource_id = '${c.resourceId}'`) === 1,
  mutate: (c) => bumpEpoch(c.resourceId),
};
const consumedAudit = (c: Ctx) => audit(c.w, "rfl_dual_consumed");

describe.skipIf(!enabled)("WP-D4 dual-control matrix (real schema, synthetic administrators)", () => {
  beforeAll(() => {
    expect(psql(`select to_regclass('public.studio_sms_rfl_dual_requests') is not null`)).toBe("t");
    seedCast();
    seedPrices();
    // the cast is what it claims to be
    expect(psql(`select string_agg(id::text || ':' || coalesce(platform_role, '-'), ',' order by id) from public.profiles where id in ('${A}','${B}','${C}','${D}','${E}','${F}','${G}')`))
      .toBe([`${A}:platform_admin`, `${B}:platform_admin`, `${C}:-`, `${D}:platform_admin`, `${E}:-`, `${F}:platform_admin`, `${G}:platform_admin`].sort().join(","));
    expect(new Set([A, B, C, D, E, F, G]).size).toBe(7);
  });

  for (const S of [ABS, CAN]) {
    describe(`${S.id}: ${S.id === "ABS" ? "absorbing a provider-fee exposure" : "releasing a phone number"}`, () => {
      it(`${S.id}-01 requester equals approver: refused 42501, the request stays pending, nothing is decided or audited as approved`, () => {
        const c = S.setup();
        const r = S.request(c, A);
        expect(r.status).toBe("pending");
        expect(codeOf(approveErr(r.request_id, A))).toBe("42501");
        expect(reqRow(r.request_id)).toMatchObject({ status: "pending", requested_by: A, decided_by: null });
        expect(audit(c.w, "rfl_dual_approved")).toBe(0);
        expect(S.done(c)).toBe(false);
      });

      it(`${S.id}-02 a second administrator approves: approved by B (not A), audited once; B's replay is idempotent; a third administrator cannot re-decide (TW041)`, () => {
        const c = S.setup();
        const r = S.request(c, A);
        expect(approve(r.request_id, B)).toMatchObject({ status: "approved" });
        expect(reqRow(r.request_id)).toMatchObject({ status: "approved", requested_by: A, decided_by: B });
        expect(reqRow(r.request_id).decision_note).toBe(NOTE);
        expect(approve(r.request_id, B)).toMatchObject({ status: "approved", replayed: true });
        expect(codeOf(approveErr(r.request_id, F))).toBe("TW041");
        expect(audit(c.w, "rfl_dual_approved")).toBe(1);
        expect(reqRow(r.request_id).decided_by).toBe(B);
        expect(S.done(c)).toBe(false); // approval alone changes nothing: the action is a separate step
      });

      it(`${S.id}-03 one administrator alone can never complete the action: no request, a pending request, and a self-approval attempt all end TW042 / 42501 with no effect`, () => {
        const c = S.setup();
        const before = money(c.w);
        expect(codeOf(S.exec(c, A))).toBe("TW042"); // no request at all
        const r = S.request(c, A);
        expect(codeOf(S.exec(c, A))).toBe("TW042"); // pending is not approved
        expect(codeOf(approveErr(r.request_id, A))).toBe("42501"); // cannot approve own
        expect(codeOf(S.exec(c, A))).toBe("TW042");
        expect(S.done(c)).toBe(false);
        expect(consumedAudit(c)).toBe(0);
        expect(money(c.w)).toBe(before);
        // the requester may withdraw (that is not an approval) and still nothing happens
        expect(call("tw4_rfl_dual_reject", r.request_id, A, "withdrawn by the requester without any approval")).toMatchObject({ status: "rejected" });
        expect(codeOf(S.exec(c, A))).toBe("TW042");
        expect(S.done(c)).toBe(false);
      });

      it(`${S.id}-04 after B approves, the action succeeds once and CONSUMES the approval (consumed_by recorded); audit rows requested / approved / consumed exist with the right actors`, () => {
        const c = S.setup();
        const r = S.request(c, A);
        approve(r.request_id, B);
        expect(S.exec(c, A)).toBe("");
        expect(S.done(c)).toBe(true);
        expect(reqRow(r.request_id)).toMatchObject({ status: "consumed", requested_by: A, decided_by: B, consumed_by: A });
        for (const a of ["rfl_dual_requested", "rfl_dual_approved", "rfl_dual_consumed"]) expect(audit(c.w, a), a).toBe(1);
        expect(auditActors(c.w, "rfl_dual_requested")).toEqual([{ actor_type: "platform_admin", actor_user_id: A }]);
        expect(auditActors(c.w, "rfl_dual_approved")).toEqual([{ actor_type: "platform_admin", actor_user_id: B }]);
        expect(auditActors(c.w, "rfl_dual_consumed")).toEqual([{ actor_type: "platform_admin", actor_user_id: A }]);
        expect(audit(c.w, S.id === "ABS" ? "rfl_exposure_disposed" : "rfl_cancel_authorized")).toBe(1);
      });

      it(`${S.id}-05 replay: the consumed approval cannot be approved, rejected or consumed again; a replay of the same action is idempotent; a second approval needs a NEW request`, () => {
        const c = S.setup();
        const r = S.request(c, A);
        approve(r.request_id, B);
        expect(S.exec(c, B)).toBe("");
        expect(codeOf(approveErr(r.request_id, B))).toBe("TW041"); // the decider replaying a consumed approval
        expect(codeOf(approveErr(r.request_id, F))).toBe("TW041");
        expect(codeOf(rejectErr(r.request_id, F))).toBe("TW041");
        expect(reqStatus(r.request_id)).toBe("consumed");
        const replay = S.id === "ABS" ? call<{ replayed: boolean }>("tw4_rfl_exposure_dispose", c.resourceId, c.key, B, "absorbed", REASON) : call<{ replayed: boolean }>("tw4_rfl_cancel_authorize", c.resourceId, B, c.approval, "owner_written", CR, true);
        expect(replay.replayed).toBe(true);
        expect(consumedAudit(c)).toBe(1);
        if (S.id === "ABS") {
          // reopen the exposure with a new bill: the old approval is gone for good and absorbing again needs a NEW request
          S.mutate(c);
          expect(exposureOf(c.resourceId, c.key!).state).toBe("open");
          expect(codeOf(S.exec(c, A))).toBe("TW042");
          const again = S.request(c, A);
          expect(again.request_id).not.toBe(r.request_id);
        } else {
          // the written reference is single-use for good: a new request with it is refused
          expect(codeOf(callErr("tw4_rfl_dual_request", A, "cancel_number", register(world(), "number").resource_id, null, CR, c.approval, "owner_written"))).toBe("TW043");
          expect(codeOf(S.requestErr(c, A))).toBe("TW043"); // and the same reference / an open cancellation is refused
        }
        expect(reqStatus(r.request_id)).toBe("consumed");
      });

      it(`${S.id}-06 facts changed BEFORE approval: B's approval comes back invalidated (persisted, audited), the action is refused TW042, a new request is needed`, () => {
        const c = S.setup();
        const r = S.request(c, A);
        S.mutate(c);
        expect(approve(r.request_id, B)).toMatchObject({ status: "invalidated" });
        expect(reqStatus(r.request_id)).toBe("invalidated");
        expect(audit(c.w, "rfl_dual_invalidated")).toBe(1);
        expect(approve(r.request_id, B)).toMatchObject({ status: "invalidated", replayed: true });
        expect(codeOf(S.exec(c, A))).toBe("TW042");
        expect(S.done(c)).toBe(false);
      });

      it(`${S.id}-07 facts changed AFTER approval: the action is refused TW042 and the approval is not consumed; the next request supersedes (invalidates) the stale one`, () => {
        const c = S.setup();
        const r = S.request(c, A);
        approve(r.request_id, B);
        S.mutate(c);
        expect(codeOf(S.exec(c, A))).toBe("TW042");
        expect(S.done(c)).toBe(false);
        expect(reqStatus(r.request_id)).toBe("approved"); // the refusal rolled back
        expect(consumedAudit(c)).toBe(0);
        const next = S.request(c, B);
        expect(next.request_id).not.toBe(r.request_id);
        expect(reqStatus(r.request_id)).toBe("invalidated");
        expect(codeOf(approveErr(next.request_id, B))).toBe("42501"); // B is the requester of the new one
        expect(approve(next.request_id, A)).toMatchObject({ status: "approved" });
        expect(S.exec(c, F)).toBe("");
        expect(S.done(c)).toBe(true);
      });

      it(`${S.id}-08 expiry (24 h): an unapproved request comes back expired and is persisted; an approved one is refused TW042 and the next request replaces it`, () => {
        const c = S.setup();
        const old = S.request(c, A);
        expire(old.request_id);
        expect(approve(old.request_id, B)).toMatchObject({ status: "expired" });
        expect(reqStatus(old.request_id)).toBe("expired");
        expect(approve(old.request_id, B)).toMatchObject({ status: "expired", replayed: true });
        const fresh = S.request(c, A);
        expect(fresh.request_id).not.toBe(old.request_id);
        approve(fresh.request_id, B);
        expire(fresh.request_id);
        expect(codeOf(S.exec(c, A))).toBe("TW042");
        expect(S.done(c)).toBe(false);
        const third = S.request(c, F);
        expect(third.request_id).not.toBe(fresh.request_id);
        expect(reqStatus(fresh.request_id)).toBe("expired");
      });

      it(`${S.id}-09 rejection: B rejects (audited); a rejected request cannot be approved (TW041) or used (TW042); rejection is allowed after approval and before use`, () => {
        const c = S.setup();
        const r = S.request(c, A);
        expect(call("tw4_rfl_dual_reject", r.request_id, B, "rejected by the second administrator after review")).toMatchObject({ status: "rejected" });
        expect(reqRow(r.request_id)).toMatchObject({ status: "rejected", decided_by: B });
        expect(audit(c.w, "rfl_dual_rejected")).toBe(1);
        expect(codeOf(approveErr(r.request_id, F))).toBe("TW041");
        expect(codeOf(S.exec(c, A))).toBe("TW042");
        const r2 = S.request(c, A);
        approve(r2.request_id, B);
        expect(call("tw4_rfl_dual_reject", r2.request_id, F, "rejected by a third administrator before use")).toMatchObject({ status: "rejected" });
        expect(codeOf(S.exec(c, A))).toBe("TW042");
        expect(S.done(c)).toBe(false);
        expect(audit(c.w, "rfl_dual_rejected")).toBe(2);
      });

      it(`${S.id}-10 third party C (not an administrator): request, approve, reject, execute and list are all refused 42501 and create / change nothing`, () => {
        const c = S.setup();
        expect(codeOf(S.requestErr(c, C))).toBe("42501");
        expect(num(`select count(*) from public.studio_sms_rfl_dual_requests where resource_id = '${c.resourceId}'`)).toBe(0);
        const r = S.request(c, A);
        expect(codeOf(approveErr(r.request_id, C))).toBe("42501");
        expect(codeOf(rejectErr(r.request_id, C))).toBe("42501");
        expect(codeOf(callErr("tw4_rfl_dual_list", C))).toBe("42501");
        approve(r.request_id, B);
        expect(codeOf(S.exec(c, C))).toBe("42501"); // an approval on file does not let a non-administrator act
        expect(reqStatus(r.request_id)).toBe("approved");
        expect(S.done(c)).toBe(false);
        expect(consumedAudit(c)).toBe(0);
      });

      it(`${S.id}-11 deactivated administrator E (role removed): cannot request, approve, reject or execute (42501); a deactivated approver or requester voids the approval (TW042 / invalidated)`, () => {
        const c = S.setup();
        expect(codeOf(S.requestErr(c, E))).toBe("42501");
        const r = S.request(c, A);
        expect(codeOf(approveErr(r.request_id, E))).toBe("42501");
        expect(codeOf(rejectErr(r.request_id, E))).toBe("42501");
        approve(r.request_id, B);
        expect(codeOf(S.exec(c, E))).toBe("42501");
        // approver deactivated after approving (trigger fires): the approval dies at once and re-promotion revives nothing
        const x = mkUser({ admin: true, label: "approver-x" });
        const r2 = S.request(c, A); // same open request replays
        expect(r2.request_id).toBe(r.request_id);
        const y = S.setup();
        const ry = S.request(y, A);
        approve(ry.request_id, x);
        setRole(x, false);
        expect(reqStatus(ry.request_id)).toBe("invalidated");
        setRole(x, true);
        expect(reqStatus(ry.request_id)).toBe("invalidated");
        expect(codeOf(S.exec(y, A))).toBe("TW042");
        // requester deactivated before approval: invalidated at approval
        const z = mkUser({ admin: true, label: "requester-z" });
        const rz = S.request(S.setup(), z);
        setRole(z, false);
        expect(reqStatus(rz.request_id)).toBe("invalidated");
        expect(approve(rz.request_id, B)).toMatchObject({ status: "invalidated", replayed: true });
      });

      it(`${S.id}-12 a request is only ever created pending and undecided: an owner-level insert cannot fabricate an approved or consumed row, and an approved row cannot name its requester as decider`, () => {
        const c = S.setup();
        const r = S.request(c, A);
        const id = r.request_id;
        expect(psqlError(`begin; select set_config('tw4.rflops_write', 'on', true); update public.studio_sms_rfl_dual_requests set status = 'approved', decided_by = requested_by, decided_at = now(), decision_note = '${NOTE}' where id = '${id}'; commit;`)).toMatch(/studio_sms_rfl_dual_requests_distinct/);
        expect(psqlError(`update public.studio_sms_rfl_dual_requests set status = 'approved', decided_by = '${B}', decided_at = now(), decision_note = '${NOTE}' where id = '${id}';`)).toMatch(/only through the dual-control functions/);
        expect(psqlError(`begin; select set_config('tw4.rflops_write', 'on', true); update public.studio_sms_rfl_dual_requests set status = 'consumed', consumed_at = now(), consumed_by = '${B}' where id = '${id}'; commit;`)).toMatch(/not a legal transition/);
        expect(psqlError(`delete from public.studio_sms_rfl_dual_requests where id = '${id}';`)).toMatch(/never deleted/);
        expect(reqStatus(id)).toBe("pending");
        expect(S.done(c)).toBe(false);
      });
    });
  }

  describe("CAN: what the release runner reads back (tw4_rfl_cancel_target)", () => {
    it("CAN-13 a consumed two-administrator approval is returned with requester != decider; a non-administrator actor is refused 42501; an unknown operation yields no target", () => {
      const c = CAN.setup();
      const r = CAN.request(c, A);
      approve(r.request_id, B);
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", c.resourceId, A, c.approval, "owner_written", CR, true);
      const target = call<{ dual_control: { request_id: string; resource_id: string; requested_by: string; decided_by: string } | null }>("tw4_rfl_cancel_target", op.operation_id, A);
      expect(target.dual_control).toMatchObject({ request_id: r.request_id, resource_id: c.resourceId, requested_by: A, decided_by: B });
      expect(target.dual_control!.requested_by).not.toBe(target.dual_control!.decided_by);
      expect(codeOf(callErr("tw4_rfl_cancel_target", op.operation_id, C))).toBe("42501");
      expect(codeOf(callErr("tw4_rfl_cancel_target", op.operation_id, E))).toBe("42501");
      expect(psql(`select public.tw4_rfl_cancel_target('${crypto.randomUUID()}'::uuid, '${A}'::uuid) is null`)).toBe("t");
    });
    it("CAN-14 fail closed: a number cancellation operation whose approval is not a consumed two-person approval (fixture: authorization row without it) yields NO target for the runner", () => {
      const c = CAN.setup();
      const r = CAN.request(c, A);
      approve(r.request_id, B);
      const op = call<{ operation_id: string }>("tw4_rfl_cancel_authorize", c.resourceId, A, c.approval, "owner_written", CR, true);
      // damage the evidence the way an owner-level mistake would: the consumer recorded on the request is someone other than the authorizer
      replica(`update public.studio_sms_rfl_dual_requests set consumed_by = '${F}' where id = '${r.request_id}';`);
      expect(psql(`select public.tw4_rfl_cancel_target('${op.operation_id}'::uuid, '${A}'::uuid) is null`)).toBe("t");
    });
  });

  describe("privileges and the table itself (aal1 cannot reach these functions directly)", () => {
    it("PRIV-15 dual-control functions are executable by the service role only (never public, anon, authenticated): an aal1 or aal2 JWT cannot call them; the table has no API-role privilege and RLS is on", () => {
      const fns = [
        "tw4_rfl_dual_request(uuid,text,uuid,text,text,text,text)", "tw4_rfl_dual_approve(uuid,uuid,text)", "tw4_rfl_dual_reject(uuid,uuid,text)", "tw4_rfl_dual_list(uuid)",
        "tw4_rfl_exposure_dispose(uuid,text,uuid,text,text)", "tw4_rfl_cancel_authorize(uuid,uuid,text,text,text,boolean)", "tw4_rfl_cancel_target(uuid,uuid)", "tw4_price_set(text,int,int,text,uuid)",
      ];
      for (const f of fns) {
        for (const role of ["anon", "authenticated", "public"]) expect(psql(`select has_function_privilege('${role === "public" ? "public" : role}', 'public.${f}', 'execute')`), `${role} ${f}`).toBe("f");
        expect(psql(`select has_function_privilege('service_role', 'public.${f}', 'execute')`), `service_role ${f}`).toBe("t");
        expect(psql(`select p.prosecdef::text || ':' || coalesce(array_to_string(p.proconfig, ','), '') from pg_proc p where p.oid = 'public.${f}'::regprocedure`), f).toBe("true:search_path=pg_catalog, public, pg_temp");
      }
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect(psql(`select count(*) from information_schema.role_table_grants where table_schema = 'public' and table_name = 'studio_sms_rfl_dual_requests' and grantee = '${role}'`)).toBe("0");
      }
      expect(psql(`select relrowsecurity::text from pg_class where oid = 'public.studio_sms_rfl_dual_requests'::regclass`)).toBe("true");
    });

    it("PRIV-16 banned auth user G still holds platform_role: the database trusts profiles.platform_role only (OBSERVATION: the Auth server refuses G a session, so no JWT for G exists; G as a p_actor is accepted by the definer functions)", () => {
      const c = ABS.setup();
      const r = ABS.request(c, G);
      expect(reqRow(r.request_id)).toMatchObject({ status: "pending", requested_by: G });
      expect(psql(`select banned_until is not null from auth.users where id = '${G}'`)).toBe("t");
      expect(approve(r.request_id, B)).toMatchObject({ status: "approved" });
    });
  });

  // SMS pricing dual control (tw4_price_propose / approve / reject, tw4_price_set closed) moved to localStack.pricedual.test.ts when it became a real migration (D4-1).

  it("DB-LEVEL aal1 NOTE: the dual-control RPCs take p_actor from the service-role caller and check the profile role only; AAL is enforced by requirePlatformStepUp in the server action (see localStack.wpd4actions)", () => {
    expect(hasCode(callErr("tw4_rfl_dual_list", D), "42501")).toBe(false); // D (an administrator whose session is aal1) is accepted by the DATABASE; the action layer is what refuses D
    expect(PG && DB).toBeTruthy();
  });
});
