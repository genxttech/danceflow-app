### WP-D0 function coverage (scope: tw4, 421 probe names)
- volatile functions in scope: **277**; called by at least one suite: **248**; never called: **29**
- suites with coverage data: 41/41

| Suite | Result | Coverage captured |
|---|---|---|
| localStack.aal2 | PASS | yes |
| localStack.tw4f3bpay | PASS | yes |
| localStack.tw4f3bui | PASS | yes |
| localStack.tw4monthly | PASS | yes |
| localStack.tw4payhardening | KNOWN | yes |
| localStack.tw4recexec | PASS | yes |
| localStack.tw4recurring | PASS | yes |
| localStack.f3recon | FAIL | yes |
| localStack.tw4inbound | PASS | yes |
| localStack.tw4recon | PASS | yes |
| localStack.tw4rv | PASS | yes |
| localStack.tw4sender | PASS | yes |
| localStack.tw4usage | PASS | yes |
| localStack.tw4a | KNOWN | yes |
| localStack.j2owner | FAIL | yes |
| localStack.j3owner | PASS | yes |
| localStack.r2ci1 | PASS | yes |
| localStack.r2ci2 | PASS | yes |
| isolatedQa.canary | BLOCKED | yes |
| localStack.f1funding | PASS | yes |
| localStack.f4recovery | PASS | yes |
| localStack.f5canceltarget | PASS | yes |
| localStack.feeres | PASS | yes |
| localStack.j4activation | FAIL | yes |
| localStack.r2a | FAIL | yes |
| localStack.r2b | FAIL | yes |
| localStack.r2bp2.rfl | KNOWN | yes |
| localStack.r2brfl | PASS | yes |
| localStack.tw4a9 | PASS | yes |
| localStack.tw4f1b | KNOWN | yes |
| localStack.tw4f3a | PASS | yes |
| localStack.tw4f3b0 | PASS | yes |
| localStack.tw4fi | PASS | yes |
| localStack.tw4fj1 | PASS | yes |
| localStack.tw4pilothard | PASS | yes |
| localStack.tw4r1 | PASS | yes |
| localStack.tw4rfl | PASS | yes |
| localStack.tw4rfld5 | PASS | yes |
| localStack.tw4rflevid | PASS | yes |
| localStack.tw4rflops | PASS | yes |
| localStack.tw4rflspend | PASS | yes |

| Function | Volatility | Suites that called it | Calls |
|---|---|---|---|
| _sms_consent_clear_context() | volatile | localStack.tw4recon (15) | 15 |
| _sms_consent_set_context(p_event_type text, p_actor_type text, p_actor_user_id uuid, p_actor_role text, p_actor_name text) | volatile | localStack.tw4recon (30) | 30 |
| _sms_onb_append_only() | volatile | localStack.tw4a (12), localStack.tw4f1b (117), localStack.tw4f3a (130), localStack.tw4r1 (93) | 352 |
| _sms_onb_audit(p_studio_id uuid, p_onboarding_id uuid, p_actor_type text, p_action text, p_from text, p_to text, p_note text) | volatile | localStack.aal2 (2), localStack.tw4a (8), localStack.tw4f1b (10), localStack.tw4f3a (9), localStack.tw4r1 (7) | 36 |
| _sms_onb_integrity() | volatile | localStack.tw4a (27), localStack.f1funding (39), localStack.f4recovery (22), localStack.feeres (170), localStack.r2a (306), localStack.tw4f1b (122), localStack.tw4f3a (84), localStack.tw4fi (4), localStack.tw4r1 (87), localStack.j4activation (38), localStack.r2brfl (35), localStack.tw4fj1 (44), localStack.tw4rfld5 (1) | 979 |
| _sms_onb_refuse_truncate() | volatile | - | 0 |
| _sms_onb_steps_guard() | volatile | localStack.tw4f1b (106), localStack.tw4f3a (78), localStack.tw4r1 (97) | 281 |
| _sms_webhook_receipts_guard() | volatile | - | 0 |
| _tw4_r1_audit(p_o studio_sms_onboarding, p_actor uuid, p_action text, p_from text, p_to text, p_note text) | volatile | localStack.r2ci1 (2), localStack.f1funding (44), localStack.f4recovery (27), localStack.feeres (175), localStack.r2a (266), localStack.tw4f1b (83), localStack.tw4f3a (58), localStack.tw4r1 (66), localStack.j4activation (56), localStack.r2brfl (45), localStack.tw4fj1 (37), localStack.tw4rfld5 (1) | 860 |
| _tw4_r1_lease(p_onboarding_id uuid, p_lease_owner text) | volatile | localStack.f1funding (35), localStack.f4recovery (23), localStack.feeres (229), localStack.r2a (478), localStack.tw4f1b (165), localStack.tw4f3a (155), localStack.tw4fi (29), localStack.tw4r1 (138), localStack.j4activation (30), localStack.r2brfl (35), localStack.tw4fj1 (63), localStack.tw4rfld5 (1) | 1381 |
| _tw4act_lock_funding(p_studio_id uuid) | volatile | localStack.f1funding (9), localStack.j4activation (88) | 97 |
| _tw4c_admin(p_actor uuid) | volatile | localStack.tw4f3bpay (2), localStack.tw4monthly (60), localStack.tw4payhardening (17), localStack.tw4recexec (117), localStack.tw4recurring (101), localStack.f3recon (16), localStack.tw4inbound (60), localStack.tw4recon (91), localStack.tw4rv (93), localStack.tw4sender (96), localStack.tw4usage (86), localStack.f1funding (109), localStack.f4recovery (66), localStack.feeres (11), localStack.r2a (30), localStack.tw4f3a (18), localStack.tw4f3b0 (23), localStack.tw4fi (31), localStack.f5canceltarget (17), localStack.j4activation (214), localStack.r2brfl (109), localStack.tw4fj1 (6), localStack.tw4pilothard (19), localStack.tw4rfl (617), localStack.tw4rfld5 (60), localStack.tw4rflevid (174), localStack.tw4rflspend (35), localStack.tw4rflops (541) | 2819 |
| _tw4c_immutable_guard() | volatile | localStack.tw4f3bpay (119), localStack.tw4f3bui (8), localStack.tw4monthly (186), localStack.tw4payhardening (1440), localStack.tw4recexec (493), localStack.tw4recurring (584), localStack.f3recon (8), localStack.tw4inbound (454), localStack.tw4recon (432), localStack.tw4rv (11), localStack.tw4sender (119), localStack.tw4usage (334), localStack.j3owner (1), localStack.f1funding (55), localStack.f4recovery (55), localStack.feeres (40), localStack.r2a (102), localStack.tw4f3a (19), localStack.tw4f3b0 (86), localStack.tw4fi (73), localStack.j4activation (40), localStack.r2brfl (76), localStack.tw4fj1 (3), localStack.tw4pilothard (5), localStack.tw4rfl (262), localStack.tw4rfld5 (17), localStack.tw4rflevid (52), localStack.tw4rflspend (4), localStack.tw4rflops (138) | 5216 |
| _tw4c_lock(p_entity uuid) | volatile | localStack.tw4f3bpay (142), localStack.tw4f3bui (15), localStack.tw4monthly (268), localStack.tw4payhardening (1513), localStack.tw4recexec (356), localStack.tw4recurring (452), localStack.f3recon (11), localStack.tw4inbound (471), localStack.tw4recon (533), localStack.tw4rv (19), localStack.tw4sender (118), localStack.tw4usage (418), localStack.j3owner (1), localStack.f1funding (133), localStack.f4recovery (81), localStack.feeres (44), localStack.r2a (120), localStack.tw4f3a (28), localStack.tw4f3b0 (126), localStack.tw4fi (65), localStack.j4activation (150), localStack.r2brfl (152), localStack.tw4fj1 (10), localStack.tw4pilothard (13), localStack.tw4rfl (680), localStack.tw4rfld5 (59), localStack.tw4rflevid (134), localStack.tw4rflspend (7), localStack.tw4rflops (477) | 6596 |
| _tw4c_pilot_cap_guard() | volatile | localStack.tw4f3a (3) | 3 |
| _tw4c_post(p_entity uuid, p_studio uuid, p_kind text, p_bdelta bigint, p_rdelta bigint, p_key text, p_reservation uuid, p_ref text, p_actor uuid, p_note text) | volatile | localStack.tw4f3bpay (43), localStack.tw4f3bui (2), localStack.tw4monthly (69), localStack.tw4payhardening (431), localStack.tw4recexec (165), localStack.tw4recurring (193), localStack.f3recon (3), localStack.tw4inbound (196), localStack.tw4recon (164), localStack.tw4rv (4), localStack.tw4sender (49), localStack.tw4usage (126), localStack.f1funding (16), localStack.f4recovery (24), localStack.feeres (15), localStack.r2a (34), localStack.tw4f3a (7), localStack.tw4f3b0 (41), localStack.tw4fi (28), localStack.j4activation (14), localStack.r2brfl (36), localStack.tw4pilothard (1), localStack.tw4rfl (120), localStack.tw4rfld5 (1), localStack.tw4rflevid (1), localStack.tw4rflspend (1), localStack.tw4rflops (67) | 1851 |
| _tw4c_require_funds(a studio_sms_credit_accounts, p_cents bigint) | volatile | localStack.tw4f3bpay (2), localStack.tw4monthly (39), localStack.f3recon (2), localStack.tw4inbound (2), localStack.tw4recon (62), localStack.tw4rv (2), localStack.tw4sender (29), localStack.tw4usage (61), localStack.feeres (5), localStack.r2a (10), localStack.tw4f3a (3), localStack.tw4f3b0 (18), localStack.tw4fi (13) | 248 |
| _tw4c_truncate_guard() | volatile | - | 0 |
| _tw4f1b_confirmations_guard() | volatile | localStack.tw4f1b (8), localStack.tw4f3a (8), localStack.tw4r1 (8) | 24 |
| _tw4f1b_confirmations_truncate_guard() | volatile | - | 0 |
| _tw4f3a_audit(p_studio uuid, p_actor uuid, p_action text, p_note text) | volatile | localStack.tw4monthly (1), localStack.f1funding (19), localStack.f4recovery (7), localStack.feeres (25), localStack.r2a (52), localStack.tw4f3a (37), localStack.tw4fi (57), localStack.j4activation (10), localStack.tw4fj1 (9), localStack.tw4pilothard (19), localStack.tw4rfl (8), localStack.tw4rfld5 (15), localStack.tw4rflevid (50), localStack.tw4rflspend (48), localStack.tw4rflops (1) | 358 |
| _tw4f3a_evidence_guard() | volatile | localStack.tw4monthly (1), localStack.f1funding (19), localStack.f4recovery (4), localStack.feeres (15), localStack.r2a (26), localStack.tw4f3a (21), localStack.tw4fi (41), localStack.j4activation (10), localStack.tw4fj1 (3), localStack.tw4pilothard (3), localStack.tw4rfl (7), localStack.tw4rfld5 (15), localStack.tw4rflevid (50), localStack.tw4rflspend (2), localStack.tw4rflops (1) | 218 |
| _tw4f3a_steps_account_guard() | volatile | localStack.tw4f1b (106), localStack.tw4f3a (76), localStack.tw4r1 (97) | 279 |
| _tw4f4_retry(p_studio_id uuid, p_kind text) | volatile | localStack.f4recovery (3), localStack.r2brfl (5) | 8 |
| _tw4fi_append_only() | volatile | - | 0 |
| _tw4fi_ceiling_ref_trigger() | volatile | localStack.tw4monthly (3), localStack.tw4usage (1), localStack.tw4fi (4) | 8 |
| _tw4fi_pilot_ref_trigger() | volatile | localStack.tw4monthly (3), localStack.tw4recexec (10), localStack.tw4inbound (2), localStack.tw4recon (1), localStack.tw4sender (1), localStack.tw4usage (1), localStack.j3owner (3), localStack.f1funding (1), localStack.f4recovery (1), localStack.feeres (1), localStack.r2a (2), localStack.tw4f3a (1), localStack.tw4fi (1), localStack.j4activation (2), localStack.r2brfl (1), localStack.tw4fj1 (1), localStack.tw4pilothard (1), localStack.tw4rfl (1), localStack.tw4rfld5 (1), localStack.tw4rflevid (1), localStack.tw4rflspend (1), localStack.tw4rflops (1) | 38 |
| _tw4fi_register(p_raw text, p_source text, p_entity uuid, p_studio uuid, p_spend uuid, p_kind text, p_cents integer, p_funding text, p_actor uuid) | volatile | localStack.tw4monthly (4), localStack.tw4recexec (10), localStack.tw4inbound (2), localStack.tw4recon (1), localStack.tw4sender (1), localStack.tw4usage (1), localStack.j3owner (4), localStack.f1funding (20), localStack.f4recovery (9), localStack.feeres (11), localStack.r2a (24), localStack.tw4f3a (8), localStack.tw4fi (35), localStack.j4activation (12), localStack.r2brfl (7), localStack.tw4fj1 (4), localStack.tw4pilothard (29), localStack.tw4rfl (52), localStack.tw4rfld5 (16), localStack.tw4rflevid (51), localStack.tw4rflspend (49), localStack.tw4rflops (16) | 366 |
| _tw4fi_require_path_kind(p_studio_id uuid, p_kind text) | volatile | localStack.tw4monthly (31), localStack.tw4recexec (72), localStack.tw4recurring (98), localStack.f3recon (3), localStack.tw4inbound (26), localStack.tw4recon (63), localStack.tw4rv (2), localStack.tw4sender (29), localStack.tw4usage (60), localStack.j3owner (3), localStack.f1funding (45), localStack.f4recovery (20), localStack.feeres (25), localStack.r2a (56), localStack.tw4f3a (12), localStack.tw4fi (55), localStack.j4activation (38), localStack.r2brfl (3), localStack.tw4fj1 (6), localStack.tw4pilothard (32), localStack.tw4rfl (63), localStack.tw4rfld5 (57), localStack.tw4rflevid (105), localStack.tw4rflspend (50), localStack.tw4rflops (2) | 956 |
| _tw4fi_reservation_path_trigger() | volatile | localStack.tw4monthly (14), localStack.tw4recexec (57), localStack.tw4recurring (60), localStack.f3recon (3), localStack.tw4inbound (15), localStack.tw4recon (63), localStack.tw4rv (2), localStack.tw4sender (29), localStack.tw4usage (59), localStack.j3owner (2), localStack.f1funding (26), localStack.f4recovery (12), localStack.feeres (12), localStack.r2a (22), localStack.tw4f3a (4), localStack.tw4fi (15), localStack.j4activation (20), localStack.r2brfl (7), localStack.tw4fj1 (3), localStack.tw4pilothard (3), localStack.tw4rfl (52), localStack.tw4rfld5 (42), localStack.tw4rflevid (55), localStack.tw4rflspend (2), localStack.tw4rflops (1) | 580 |
| _tw4fi_spend_path_trigger() | volatile | localStack.tw4monthly (1), localStack.j3owner (1), localStack.f1funding (19), localStack.f4recovery (8), localStack.feeres (10), localStack.r2a (22), localStack.tw4f3a (8), localStack.tw4fi (39), localStack.j4activation (10), localStack.tw4fj1 (3), localStack.tw4pilothard (29), localStack.tw4rfl (11), localStack.tw4rfld5 (15), localStack.tw4rflevid (50), localStack.tw4rflspend (48), localStack.tw4rflops (1) | 275 |
| _tw4fi_spend_ref_trigger() | volatile | localStack.tw4monthly (1), localStack.j3owner (1), localStack.f1funding (19), localStack.f4recovery (8), localStack.feeres (10), localStack.r2a (22), localStack.tw4f3a (7), localStack.tw4fi (34), localStack.j4activation (10), localStack.tw4fj1 (3), localStack.tw4pilothard (28), localStack.tw4rfl (10), localStack.tw4rfld5 (15), localStack.tw4rflevid (50), localStack.tw4rflspend (48), localStack.tw4rflops (1) | 267 |
| _tw4ml_apply_limit(p_entity uuid, p_audit_studio uuid, p_actor uuid, p_role text, p_limit integer, p_effective text, p_reason text, p_require_recent_signin boolean) | volatile | localStack.tw4f3bpay (2), localStack.tw4monthly (44), localStack.tw4recexec (4), localStack.tw4recurring (2), localStack.f3recon (1), localStack.tw4inbound (15), localStack.tw4recon (35), localStack.tw4rv (1), localStack.tw4sender (1), localStack.tw4usage (27), localStack.f1funding (16), localStack.feeres (3), localStack.r2a (6), localStack.tw4f3b0 (2), localStack.tw4fi (1), localStack.j4activation (6), localStack.r2brfl (28), localStack.tw4pilothard (1), localStack.tw4rfl (96), localStack.tw4rfld5 (1), localStack.tw4rflevid (1), localStack.tw4rflspend (1), localStack.tw4rflops (67) | 361 |
| _tw4ml_apply_timezone(p_entity uuid, p_audit_studio uuid, p_actor uuid, p_role text, p_timezone text, p_reason text) | volatile | localStack.tw4monthly (5) | 5 |
| _tw4ml_ensure_tz(p_entity uuid) | volatile | localStack.tw4f3bpay (7), localStack.tw4monthly (147), localStack.tw4recexec (75), localStack.tw4recurring (112), localStack.f3recon (3), localStack.tw4inbound (217), localStack.tw4recon (140), localStack.tw4rv (3), localStack.tw4sender (30), localStack.tw4usage (89), localStack.f1funding (16), localStack.feeres (6), localStack.r2a (20), localStack.tw4f3a (1), localStack.tw4f3b0 (28), localStack.tw4fi (6), localStack.j4activation (14), localStack.r2brfl (39), localStack.tw4pilothard (1), localStack.tw4rfl (128), localStack.tw4rfld5 (1), localStack.tw4rflevid (1), localStack.tw4rflspend (1), localStack.tw4rflops (68) | 1153 |
| _tw4ml_guard() | volatile | - | 0 |
| _tw4ml_require_room(p_entity uuid, p_cents bigint, p_already_counted bigint) | volatile | localStack.tw4f3bpay (2), localStack.tw4monthly (34), localStack.tw4recexec (34), localStack.tw4recurring (42), localStack.f3recon (2), localStack.tw4inbound (13), localStack.tw4recon (62), localStack.tw4rv (2), localStack.tw4sender (29), localStack.tw4usage (59), localStack.feeres (3), localStack.r2a (10), localStack.tw4f3b0 (18), localStack.tw4fi (1), localStack.j4activation (8), localStack.tw4rfl (18) | 337 |
| _tw4num_free_selection(p_selection uuid, p_actor uuid, p_note text) | volatile | - | 0 |
| _tw4num_guard() | volatile | localStack.j3owner (2), localStack.f1funding (1), localStack.f4recovery (4), localStack.r2brfl (14), localStack.tw4fj1 (5) | 26 |
| _tw4num_on_number_cancelled(p_studio_id uuid, p_provider_sid text, p_op uuid, p_actor uuid) | volatile | localStack.r2brfl (7), localStack.tw4rfl (8), localStack.tw4rflops (2) | 17 |
| _tw4num_register_owned(p_op uuid) | volatile | localStack.f1funding (34), localStack.f4recovery (1), localStack.j4activation (10), localStack.r2brfl (29), localStack.tw4fj1 (2), localStack.tw4rfld5 (1) | 77 |
| _tw4num_reserve(p_o studio_sms_onboarding, p_op uuid, p_expected_cents integer) | volatile | localStack.tw4fj1 (1) | 1 |
| _tw4num_settle_if_held(p_op uuid, p_outcome text, p_ref text) | volatile | localStack.f1funding (34), localStack.f4recovery (2), localStack.j4activation (10), localStack.r2brfl (28), localStack.tw4fj1 (2), localStack.tw4rfld5 (1) | 77 |
| _tw4p1_guard() | volatile | - | 0 |
| _tw4p2_event(p_orphan uuid, p_event text, p_actor uuid, p_detail text) | volatile | localStack.r2bp2.rfl (5) | 5 |
| _tw4p2_guard() | volatile | localStack.r2bp2.rfl (10) | 10 |
| _tw4p2_no_recon_ops() | volatile | localStack.feeres (11), localStack.r2a (20), localStack.tw4fj1 (4) | 35 |
| _tw4p_append_only_guard() | volatile | - | 0 |
| _tw4prov2_close_scan() | volatile | localStack.r2ci1 (2), localStack.feeres (23), localStack.r2a (32), localStack.tw4fj1 (2) | 59 |
| _tw4prov2_guard() | volatile | localStack.feeres (6) | 6 |
| _tw4prov2_orphan_block() | volatile | localStack.feeres (11), localStack.r2a (20), localStack.tw4fj1 (4) | 35 |
| _tw4prov2_orphan_scan(p_op uuid) | volatile | localStack.feeres (24), localStack.r2a (12), localStack.tw4fj1 (1) | 37 |
| _tw4prov2_refusal_disposition() | volatile | localStack.r2ci1 (2), localStack.feeres (23), localStack.r2a (32), localStack.tw4fj1 (2) | 59 |
| _tw4prov2_refusal_guard() | volatile | localStack.r2ci1 (2), localStack.feeres (23), localStack.r2a (32), localStack.tw4fj1 (2) | 59 |
| _tw4prov2_reservation_disposition() | volatile | localStack.tw4monthly (10), localStack.tw4recexec (55), localStack.tw4recurring (60), localStack.tw4inbound (15), localStack.tw4recon (32), localStack.tw4rv (1), localStack.tw4sender (19), localStack.tw4usage (24), localStack.f1funding (19), localStack.f4recovery (7), localStack.feeres (6), localStack.r2a (14), localStack.tw4f3a (4), localStack.tw4fi (13), localStack.j4activation (10), localStack.r2brfl (4), localStack.tw4fj1 (3), localStack.tw4pilothard (3), localStack.tw4rfl (13), localStack.tw4rfld5 (15), localStack.tw4rflevid (50), localStack.tw4rflspend (2), localStack.tw4rflops (1) | 380 |
| _tw4prov_guard() | volatile | localStack.r2ci1 (2), localStack.f4recovery (3), localStack.feeres (36), localStack.r2a (122), localStack.tw4fj1 (11) | 174 |
| _tw4prov_register_verified(p_op uuid) | volatile | localStack.f4recovery (15), localStack.r2a (4), localStack.tw4fj1 (1) | 20 |
| _tw4prov_reserve(p_o studio_sms_onboarding, p_kind text, p_op uuid) | volatile | localStack.feeres (9), localStack.r2a (16), localStack.tw4fj1 (2) | 27 |
| _tw4prov_settle(p_op uuid, p_kind text, p_outcome text, p_ref text) | volatile | localStack.f4recovery (5), localStack.feeres (6), localStack.r2a (14), localStack.tw4fj1 (3) | 28 |
| _tw4pse_guard() | volatile | localStack.j3owner (4), localStack.f1funding (20), localStack.f4recovery (8), localStack.feeres (5), localStack.r2a (12), localStack.tw4f3a (3), localStack.j4activation (12), localStack.r2brfl (1), localStack.tw4fj1 (4), localStack.tw4pilothard (24), localStack.tw4rfl (9), localStack.tw4rfld5 (16), localStack.tw4rflevid (51), localStack.tw4rflspend (48), localStack.tw4rflops (2) | 219 |
| _tw4psh_event_evidence_check() | volatile | localStack.j3owner (1), localStack.f1funding (19), localStack.f4recovery (7), localStack.feeres (4), localStack.r2a (10), localStack.tw4f3a (2), localStack.j4activation (10), localStack.tw4fj1 (3), localStack.tw4pilothard (17), localStack.tw4rfl (8), localStack.tw4rfld5 (15), localStack.tw4rflevid (50), localStack.tw4rflspend (46), localStack.tw4rflops (1) | 193 |
| _tw4psh_exception_evidence_check() | volatile | localStack.j3owner (3), localStack.f1funding (1), localStack.f4recovery (1), localStack.feeres (1), localStack.r2a (6), localStack.tw4f3a (1), localStack.j4activation (2), localStack.r2brfl (1), localStack.tw4fj1 (3), localStack.tw4pilothard (23), localStack.tw4rfl (11), localStack.tw4rfld5 (27), localStack.tw4rflevid (63), localStack.tw4rflspend (88), localStack.tw4rflops (2) | 233 |
| _tw4psh_spend_authorize(p_entity_id uuid, p_kind text, p_amount_cents integer, p_approval_ref text, p_actor uuid, p_funding text, p_studio_id uuid, p_evidence_authorized_on date, p_evidence_role text, p_evidence_scope text, p_evidence_amount_cents integer, p_evidence_period_key text, p_evidence_document_ref text, p_evidence_sha256 text) | volatile | localStack.tw4monthly (1), localStack.f1funding (19), localStack.f4recovery (2), localStack.feeres (10), localStack.r2a (24), localStack.tw4f3a (8), localStack.tw4fi (37), localStack.j4activation (10), localStack.tw4fj1 (3), localStack.tw4pilothard (20), localStack.tw4rfl (8), localStack.tw4rfld5 (15), localStack.tw4rflevid (50), localStack.tw4rflspend (50), localStack.tw4rflops (1) | 258 |
| _tw4rc_guard() | volatile | localStack.tw4monthly (4), localStack.tw4recexec (6), localStack.tw4recurring (18), localStack.tw4inbound (1), localStack.tw4fi (1), localStack.r2brfl (1), localStack.tw4rfl (5) | 36 |
| _tw4rc_release_commitment(p_authorization_id uuid) | volatile | localStack.tw4monthly (4), localStack.tw4recexec (70), localStack.tw4recurring (87), localStack.tw4inbound (22), localStack.tw4usage (1), localStack.tw4fi (1), localStack.tw4rfl (2) | 187 |
| _tw4rc_run_guard() | volatile | localStack.tw4recexec (24) | 24 |
| _tw4rfl_alert(p_entity uuid, p_studio uuid, p_resource uuid, p_kind text, p_dedupe text, p_audience text, p_severity text, p_summary text) | volatile | localStack.f4recovery (8), localStack.feeres (19), localStack.r2bp2.rfl (4), localStack.r2brfl (8), localStack.tw4rfl (149), localStack.tw4rfld5 (28), localStack.tw4rflops (191) | 407 |
| _tw4rfl_audit(p_studio uuid, p_actor uuid, p_action text, p_note text) | volatile | localStack.f1funding (86), localStack.f4recovery (20), localStack.feeres (2), localStack.r2a (4), localStack.j4activation (30), localStack.r2brfl (66), localStack.tw4fj1 (2), localStack.tw4pilothard (8), localStack.tw4rfl (389), localStack.tw4rfld5 (57), localStack.tw4rflevid (114), localStack.tw4rflspend (4), localStack.tw4rflops (378) | 1160 |
| _tw4rfl_auth_guard() | volatile | localStack.tw4monthly (9), localStack.tw4recexec (34), localStack.tw4recurring (42), localStack.tw4inbound (13), localStack.tw4usage (1), localStack.feeres (3), localStack.r2a (6), localStack.tw4fi (2), localStack.j4activation (8), localStack.tw4rfl (15) | 133 |
| _tw4rfl_evid_guard() | volatile | localStack.f1funding (19), localStack.f4recovery (2), localStack.j4activation (10), localStack.tw4pilothard (3), localStack.tw4rfl (7), localStack.tw4rfld5 (15), localStack.tw4rflevid (51), localStack.tw4rflspend (2), localStack.tw4rflops (1) | 110 |
| _tw4rfl_guard() | volatile | localStack.feeres (6), localStack.r2brfl (18), localStack.tw4rfl (143), localStack.tw4rfld5 (12), localStack.tw4rflevid (2), localStack.tw4rflops (87) | 268 |
| _tw4rfl_lock(p_entity uuid) | volatile | localStack.f1funding (88), localStack.f4recovery (52), localStack.feeres (2), localStack.r2a (8), localStack.j4activation (30), localStack.r2brfl (77), localStack.tw4fj1 (4), localStack.tw4pilothard (11), localStack.tw4rfl (422), localStack.tw4rfld5 (57), localStack.tw4rflevid (132), localStack.tw4rflspend (5), localStack.tw4rflops (339) | 1227 |
| _tw4rfl_mark_cancelled(r studio_sms_provider_resources, p_actor uuid, p_evidence text, p_op uuid, p_not_before timestamp with time zone) | volatile | localStack.r2brfl (6), localStack.tw4rfl (23), localStack.tw4rflops (2) | 31 |
| _tw4rfl_oneoff_guard() | volatile | localStack.tw4monthly (12), localStack.tw4recexec (55), localStack.tw4recurring (60), localStack.f3recon (2), localStack.tw4inbound (15), localStack.tw4recon (62), localStack.tw4rv (2), localStack.tw4sender (29), localStack.tw4usage (59), localStack.f1funding (40), localStack.f4recovery (4), localStack.feeres (22), localStack.r2a (44), localStack.tw4f3a (12), localStack.tw4fi (52), localStack.j4activation (28), localStack.r2brfl (4), localStack.tw4fj1 (6), localStack.tw4pilothard (25), localStack.tw4rfl (33), localStack.tw4rfld5 (30), localStack.tw4rflevid (100), localStack.tw4rflspend (50), localStack.tw4rflops (2) | 748 |
| _tw4rfl_register_core(p_studio_id uuid, p_actor uuid, p_kind text, p_provider_sid text, p_account_sid text, p_e164 text, p_source text, p_source_operation uuid, p_initial_reservation uuid, p_system boolean) | volatile | localStack.f1funding (66), localStack.f4recovery (16), localStack.feeres (1), localStack.r2a (4), localStack.j4activation (20), localStack.r2brfl (36), localStack.tw4fj1 (3), localStack.tw4pilothard (5), localStack.tw4rfl (119), localStack.tw4rfld5 (25), localStack.tw4rflevid (62), localStack.tw4rflspend (2), localStack.tw4rflops (60) | 419 |
| _tw4rflops_consume(p_action text, r studio_sms_provider_resources, p_period text, p_ref text, p_reason text, p_decided_by text, p_actor uuid) | volatile | localStack.r2brfl (6), localStack.tw4rfl (18), localStack.tw4rflops (25) | 49 |
| _tw4rflops_demotion() | volatile | localStack.aal2 (1), localStack.tw4a (1), localStack.tw4f1b (1), localStack.tw4f3a (1), localStack.tw4r1 (1), localStack.tw4rflops (6) | 11 |
| _tw4rflops_epoch() | volatile | localStack.r2brfl (24), localStack.tw4rfl (156), localStack.tw4rfld5 (1), localStack.tw4rflops (52) | 233 |
| _tw4rflops_guard() | volatile | localStack.r2brfl (30), localStack.tw4rfl (140), localStack.tw4rflops (117) | 287 |
| _tw4rflops_lock_parties(p_action text, p_resource uuid, p_period text) | volatile | localStack.r2brfl (6), localStack.tw4rfl (65), localStack.tw4rflops (80) | 151 |
| _tw4rflops_request_insert() | volatile | localStack.r2brfl (6), localStack.tw4rfl (18), localStack.tw4rflops (61) | 85 |
| _tw4sr_append(p_from studio_sms_billed_senders, p_status text, p_actor uuid, p_reason text, p_verification uuid) | volatile | localStack.f3recon (1), localStack.tw4recon (2), localStack.tw4rv (48), localStack.tw4sender (28), localStack.tw4usage (5), localStack.j4activation (12), localStack.tw4rfl (12), localStack.tw4rflops (2) | 110 |
| _tw4sr_apply(p_studio_id uuid, p_sender_id uuid, p_actor uuid, p_evidence jsonb, p_attested boolean, p_source text) | volatile | localStack.f3recon (1), localStack.tw4recon (2), localStack.tw4rv (76), localStack.tw4sender (42), localStack.tw4usage (4), localStack.j4activation (6) | 131 |
| _tw4sr_audit(p_studio uuid, p_actor uuid, p_action text, p_note text) | volatile | localStack.f3recon (2), localStack.tw4recon (4), localStack.tw4rv (117), localStack.tw4sender (78), localStack.tw4usage (9), localStack.j4activation (26), localStack.tw4fj1 (1), localStack.tw4rfl (12), localStack.tw4rflops (2) | 251 |
| _tw4sr_flag(p_studio_id uuid, p_code text, p_account_sid text, p_messaging_service_sid text, p_sender_e164 text) | volatile | localStack.tw4sender (3) | 3 |
| _tw4sr_lock(p_studio_id uuid) | volatile | localStack.f3recon (2), localStack.tw4recon (4), localStack.tw4rv (119), localStack.tw4sender (94), localStack.tw4usage (9), localStack.j3owner (19), localStack.f1funding (30), localStack.f4recovery (16), localStack.j4activation (142), localStack.r2brfl (46), localStack.tw4fj1 (1), localStack.tw4rfl (175), localStack.tw4rflops (221) | 878 |
| _tw4ur_attempt_event() | volatile | localStack.f3recon (2), localStack.tw4recon (301), localStack.tw4rv (4), localStack.tw4sender (59), localStack.tw4usage (215) | 581 |
| _tw4ur_fence(p_run_id uuid, p_job text) | volatile | localStack.tw4recon (78), localStack.tw4rv (40), localStack.tw4sender (5) | 123 |
| _tw4ur_guard() | volatile | localStack.f3recon (3), localStack.tw4recon (47), localStack.tw4rv (36), localStack.tw4sender (5), localStack.tw4a9 (8) | 99 |
| _tw4us_append_only() | volatile | - | 0 |
| _tw4us_attempt_guard() | volatile | localStack.tw4recon (239), localStack.tw4rv (2), localStack.tw4sender (30), localStack.tw4usage (158) | 429 |
| _tw4us_charge(a studio_sms_usage_attempts, p_segments integer, p_ref text) | volatile | localStack.tw4recon (24), localStack.tw4usage (14) | 38 |
| _tw4us_lock_attempt(p_attempt uuid) | volatile | localStack.tw4recon (155), localStack.tw4rv (2), localStack.tw4sender (29), localStack.tw4usage (108) | 294 |
| _tw4us_release_reservation(a studio_sms_usage_attempts, p_ref text) | volatile | localStack.tw4recon (32), localStack.tw4rv (1), localStack.tw4sender (19), localStack.tw4usage (25) | 77 |
| _tw4us_write() | volatile | localStack.tw4recon (225), localStack.tw4rv (2), localStack.tw4sender (34), localStack.tw4usage (159) | 420 |
| _tw4usage_reconciler_ready() | volatile | localStack.f3recon (37), localStack.tw4recon (97), localStack.tw4rv (11), localStack.tw4sender (36), localStack.tw4usage (114), localStack.j2owner (3), localStack.f1funding (17), localStack.j4activation (152) | 467 |
| cancel_sms_onboarding(p_studio_id uuid) | volatile | localStack.tw4a (2) | 2 |
| log_sms_consent_history() | volatile | localStack.tw4recon (15) | 15 |
| prevent_sms_consent_history_change() | volatile | - | 0 |
| purge_due_sms_onboarding_eins() | volatile | - | 0 |
| purge_sms_onboarding_ein(p_onboarding_id uuid, p_reason text) | volatile | localStack.tw4a (2), localStack.tw4r1 (1) | 3 |
| record_sms_inbound_opt_event(p_studio_id uuid, p_phone_e164 text, p_event text) | volatile | localStack.tw4recon (15) | 15 |
| record_sms_public_opt_in(p_studio_id uuid, p_client_id uuid, p_phone_e164 text, p_source text, p_note text) | volatile | - | 0 |
| save_sms_onboarding_draft(p_studio_id uuid, p_fields jsonb) | volatile | localStack.tw4a (4), localStack.tw4f1b (3), localStack.tw4f3a (3), localStack.tw4r1 (3) | 13 |
| set_sms_onboarding_access(p_studio_id uuid, p_enabled boolean, p_reason text) | volatile | localStack.aal2 (2), localStack.tw4a (3), localStack.tw4f1b (3), localStack.tw4f3a (3), localStack.tw4r1 (2) | 13 |
| sms_location_attest(p_studio_id uuid, p_claimed_legal_name text, p_claimed_ein_last4 text, p_attestation_version text) | volatile | localStack.tw4f3a (3) | 3 |
| sms_location_fee_kinds(p_studio_id uuid) | volatile | localStack.tw4recurring (11), localStack.tw4fi (3) | 14 |
| sms_webhook_receipt_record(p_kind text, p_event_key text, p_account_sid text) | volatile | - | 0 |
| store_sms_onboarding_ein(p_studio_id uuid, p_actor uuid, p_ciphertext text, p_key_id text, p_last4 text) | volatile | localStack.tw4a (2), localStack.tw4f1b (3), localStack.tw4f3a (3), localStack.tw4r1 (2) | 10 |
| studio_sms_registrations_integrity() | volatile | localStack.aal2 (5), localStack.tw4a (2), localStack.tw4f1b (1), localStack.tw4f3a (3), localStack.tw4r1 (6) | 17 |
| submit_sms_onboarding(p_studio_id uuid, p_attestation jsonb) | volatile | localStack.tw4a (1), localStack.tw4f1b (4), localStack.tw4f3a (3), localStack.tw4r1 (3) | 11 |
| touch_sms_updated_at() | volatile | localStack.tw4recon (84), localStack.tw4rv (1), localStack.tw4sender (21), localStack.tw4usage (58) | 164 |
| tw4_act_activate(p_studio_id uuid, p_actor uuid, p_note text) | volatile | localStack.j4activation (6) | 6 |
| tw4_act_attest(p_studio_id uuid, p_actor uuid, p_checklist jsonb, p_evidence_ref text) | volatile | localStack.j4activation (4) | 4 |
| tw4_act_check(p_studio_id uuid, p_actor uuid) | volatile | localStack.j4activation (20) | 20 |
| tw4_act_compliance_record(p_studio_id uuid, p_actor uuid, p_facts jsonb, p_expected_inbound text, p_source text, p_digest text) | volatile | localStack.j4activation (4) | 4 |
| tw4_act_exposure(p_actor uuid) | volatile | localStack.f1funding (2) | 2 |
| tw4_act_mark_ready(p_studio_id uuid, p_actor uuid, p_note text) | volatile | localStack.j4activation (6) | 6 |
| tw4_act_suspend(p_studio_id uuid, p_actor uuid, p_reason text) | volatile | localStack.f1funding (4), localStack.j4activation (6) | 10 |
| tw4_act_verify_sender(p_studio_id uuid, p_sender_id uuid, p_actor uuid, p_evidence jsonb, p_source text) | volatile | localStack.j4activation (6) | 6 |
| tw4_admin_deferred_retire(p_studio_id uuid, p_phone_number_sid text, p_actor uuid, p_note text) | volatile | localStack.f4recovery (3) | 3 |
| tw4_admin_registration_retry(p_studio_id uuid, p_actor uuid, p_kind text, p_note text) | volatile | localStack.f4recovery (6) | 6 |
| tw4_credit_adjust(p_entity_id uuid, p_amount_cents bigint, p_key text, p_note text, p_actor uuid) | volatile | localStack.tw4monthly (4), localStack.tw4payhardening (3), localStack.tw4recexec (27), localStack.tw4recurring (35), localStack.tw4inbound (2), localStack.tw4usage (2), localStack.f1funding (16), localStack.f4recovery (23), localStack.tw4f3b0 (4), localStack.j4activation (6), localStack.r2brfl (28), localStack.tw4pilothard (1), localStack.tw4rfl (96), localStack.tw4rfld5 (1), localStack.tw4rflevid (1), localStack.tw4rflspend (1), localStack.tw4rflops (67) | 317 |
| tw4_credit_apply_dispute(p_payment_ref text, p_dispute_id text, p_amount_cents integer, p_action text, p_event_id text) | volatile | localStack.tw4f3bpay (14), localStack.tw4payhardening (660), localStack.tw4f3b0 (1) | 675 |
| tw4_credit_apply_refund(p_payment_ref text, p_cumulative_refunded_cents integer, p_event_id text, p_reason text) | volatile | localStack.tw4f3bpay (11), localStack.tw4f3bui (1), localStack.tw4payhardening (116), localStack.tw4f3b0 (4) | 132 |
| tw4_credit_debit_usage(p_entity_id uuid, p_studio_id uuid, p_cents integer, p_key text, p_ref text) | volatile | localStack.tw4f3bpay (2), localStack.tw4monthly (25), localStack.tw4f3b0 (17) | 44 |
| tw4_credit_record_provider_charge(p_entity_id uuid, p_studio_id uuid, p_kind text, p_provider_ref text, p_provider_cost_cents integer, p_actor uuid) | volatile | localStack.tw4f3b0 (3), localStack.tw4rfl (15), localStack.tw4rflops (6) | 24 |
| tw4_credit_refund_usage(p_entity_id uuid, p_cents integer, p_key text, p_original_key text) | volatile | localStack.tw4monthly (1), localStack.tw4f3b0 (4) | 5 |
| tw4_credit_resolve_reservation(p_reservation_id uuid, p_outcome text, p_actor uuid, p_note text) | volatile | localStack.tw4f3a (2) | 2 |
| tw4_credit_set_hold(p_entity_id uuid, p_hold boolean, p_reason text, p_actor uuid) | volatile | localStack.tw4monthly (3), localStack.tw4payhardening (12), localStack.tw4recexec (52), localStack.tw4recurring (60), localStack.tw4inbound (2), localStack.tw4recon (2), localStack.tw4usage (2), localStack.f1funding (4), localStack.r2a (4), localStack.tw4f3b0 (2), localStack.j4activation (4), localStack.tw4rfl (9), localStack.tw4rflops (3) | 159 |
| tw4_credit_set_threshold(p_entity_id uuid, p_cents integer, p_actor uuid) | volatile | localStack.tw4f3b0 (2) | 2 |
| tw4_credit_settle_topup(p_entity_id uuid, p_paid_by_studio_id uuid, p_provider_ref text, p_amount_cents integer, p_event_id text, p_payment_intent text, p_require_pending boolean) | volatile | localStack.tw4f3bpay (27), localStack.tw4f3bui (1), localStack.tw4monthly (18), localStack.tw4payhardening (109), localStack.tw4recexec (28), localStack.tw4recurring (38), localStack.f3recon (1), localStack.tw4inbound (22), localStack.tw4recon (35), localStack.tw4rv (1), localStack.tw4sender (1), localStack.tw4usage (27), localStack.feeres (3), localStack.r2a (8), localStack.tw4f3a (1), localStack.tw4f3b0 (13), localStack.tw4fi (2) | 335 |
| tw4_credit_topup_failed(p_provider_ref text, p_event_id text) | volatile | localStack.tw4f3bpay (8), localStack.tw4f3bui (1), localStack.tw4f3b0 (12) | 21 |
| tw4_credit_topup_pending(p_entity_id uuid, p_paid_by_studio_id uuid, p_provider_ref text, p_amount_cents integer, p_expires_at timestamp with time zone) | volatile | localStack.tw4f3bpay (24), localStack.tw4f3bui (8), localStack.tw4monthly (18), localStack.tw4payhardening (120), localStack.tw4recexec (28), localStack.tw4recurring (38), localStack.f3recon (1), localStack.tw4inbound (22), localStack.tw4recon (35), localStack.tw4rv (1), localStack.tw4sender (1), localStack.tw4usage (27), localStack.feeres (3), localStack.r2a (10), localStack.tw4f3b0 (13), localStack.tw4fi (2) | 351 |
| tw4_credit_verify(p_entity_id uuid) | volatile | localStack.tw4f3bpay (7), localStack.tw4monthly (5), localStack.tw4payhardening (14), localStack.tw4recurring (6), localStack.tw4inbound (3), localStack.tw4usage (2), localStack.tw4f3a (3), localStack.tw4f3b0 (8), localStack.tw4fi (1) | 49 |
| tw4_entity_create_for_studio(p_studio_id uuid, p_actor uuid, p_verification_note text) | volatile | localStack.tw4f3a (2) | 2 |
| tw4_entity_decide_link(p_request_id uuid, p_entity_id uuid, p_actor uuid, p_approve boolean, p_note text) | volatile | localStack.tw4f3a (3) | 3 |
| tw4_entity_for_studio(p_studio_id uuid, p_actor uuid) | volatile | localStack.tw4f3a (7), localStack.tw4fj1 (16) | 23 |
| tw4_entity_set_spend_cap(p_entity_id uuid, p_cents integer, p_actor uuid) | volatile | localStack.tw4f3a (3) | 3 |
| tw4_entity_timezone_set(p_studio_id uuid, p_user_id uuid, p_timezone text, p_reason text) | volatile | localStack.tw4monthly (3) | 3 |
| tw4_entity_timezone_set_admin(p_entity_id uuid, p_actor uuid, p_timezone text, p_reason text) | volatile | localStack.tw4monthly (2) | 2 |
| tw4_inbound_exposure_set(p_entity_id uuid, p_actor uuid, p_cents integer, p_reason text) | volatile | localStack.tw4inbound (2), localStack.tw4recon (1) | 3 |
| tw4_inbound_note_unresolved(p_run_id uuid, p_account_sid text, p_provider_sid text, p_code text) | volatile | localStack.tw4recon (1) | 1 |
| tw4_inbound_record(p_studio_id uuid, p_signer_account text, p_provider_sid text, p_segments integer, p_media integer, p_classification text, p_reply_body text, p_received_at timestamp with time zone, p_source text) | volatile | localStack.tw4inbound (188), localStack.tw4recon (43), localStack.tw4rfl (3) | 234 |
| tw4_inbound_recover(p_run_id uuid, p_account_sid text, p_evidence jsonb) | volatile | localStack.tw4recon (49) | 49 |
| tw4_inbound_reply_allowed(p_account_sid text, p_sender_hash text, p_kind text, p_limit integer) | volatile | localStack.tw4inbound (11) | 11 |
| tw4_inbound_route_pin_set(p_actor uuid, p_origin text, p_reason text) | volatile | localStack.j4activation (2) | 2 |
| tw4_inbound_scan_advance(p_run_id uuid, p_account_sid text, p_through timestamp with time zone) | volatile | localStack.tw4recon (13) | 13 |
| tw4_limit_ceiling_approve_entity(p_entity_id uuid, p_actor uuid, p_cents integer, p_approval_ref text) | volatile | localStack.tw4monthly (1), localStack.tw4usage (1), localStack.tw4fi (4) | 6 |
| tw4_limit_ceiling_set_platform(p_actor uuid, p_cents integer, p_approval_ref text) | volatile | localStack.tw4monthly (2) | 2 |
| tw4_location_fee_kinds(p_studio_id uuid) | volatile | localStack.tw4recurring (11), localStack.j2owner (3), localStack.r2ci1 (14), localStack.f1funding (85), localStack.f4recovery (154), localStack.feeres (22), localStack.r2a (152), localStack.tw4fi (4), localStack.j4activation (164), localStack.tw4fj1 (16), localStack.tw4rfl (50), localStack.tw4rflops (14) | 689 |
| tw4_monthly_limit_set(p_studio_id uuid, p_user_id uuid, p_limit_cents integer, p_effective_month text, p_confirmed boolean, p_reason text) | volatile | localStack.tw4monthly (9) | 9 |
| tw4_monthly_limit_set_admin(p_entity_id uuid, p_actor uuid, p_limit_cents integer, p_effective_month text, p_reason text) | volatile | localStack.tw4f3bpay (2), localStack.tw4monthly (35), localStack.tw4recexec (4), localStack.tw4recurring (2), localStack.f3recon (1), localStack.tw4inbound (15), localStack.tw4recon (35), localStack.tw4rv (1), localStack.tw4sender (1), localStack.tw4usage (27), localStack.f1funding (16), localStack.feeres (3), localStack.r2a (6), localStack.tw4f3b0 (2), localStack.tw4fi (1), localStack.j4activation (6), localStack.r2brfl (28), localStack.tw4pilothard (1), localStack.tw4rfl (96), localStack.tw4rfld5 (1), localStack.tw4rflevid (1), localStack.tw4rflspend (1), localStack.tw4rflops (67) | 352 |
| tw4_num_begin(p_onboarding_id uuid, p_lease_owner text, p_op_kind text, p_friendly_name text, p_request_digest text, p_params jsonb, p_actor uuid) | volatile | localStack.tw4fj1 (4) | 4 |
| tw4_num_claim(p_studio_id uuid, p_actor uuid, p_lease_owner text, p_lease_seconds integer, p_mode text) | volatile | localStack.tw4fj1 (6) | 6 |
| tw4_num_context(p_onboarding_id uuid, p_lease_owner text) | volatile | localStack.tw4fj1 (6) | 6 |
| tw4_num_finish(p_onboarding_id uuid, p_lease_owner text, p_operation_id uuid, p_status text, p_provider_sid text, p_error_code text, p_error_detail text) | volatile | localStack.tw4fj1 (2) | 2 |
| tw4_num_history_observe(p_onboarding_id uuid, p_lease_owner text, p_facts jsonb, p_source text, p_digest text) | volatile | - | 0 |
| tw4_num_identity_observe(p_onboarding_id uuid, p_lease_owner text, p_facts jsonb, p_source text, p_digest text) | volatile | - | 0 |
| tw4_num_inventory_ack(p_studio_id uuid, p_actor uuid, p_phone_number_sid text, p_note text) | volatile | - | 0 |
| tw4_num_inventory_observe(p_onboarding_id uuid, p_lease_owner text, p_numbers jsonb, p_source text, p_listed_at timestamp with time zone) | volatile | localStack.j4activation (10), localStack.tw4fj1 (1) | 11 |
| tw4_num_inventory_status(p_studio_id uuid, p_actor uuid) | volatile | - | 0 |
| tw4_num_observe(p_onboarding_id uuid, p_lease_owner text, p_operation_id uuid, p_facts jsonb, p_source text, p_digest text) | volatile | localStack.f1funding (35), localStack.f4recovery (2), localStack.j4activation (20), localStack.r2brfl (35), localStack.tw4fj1 (4), localStack.tw4rfld5 (1) | 97 |
| tw4_num_offer_record(p_studio_id uuid, p_actor uuid, p_account_sid text, p_search jsonb, p_candidates jsonb, p_source text, p_digest text) | volatile | localStack.tw4fj1 (1) | 1 |
| tw4_num_orphan_escalate(p_limit integer) | volatile | localStack.r2bp2.rfl (5) | 5 |
| tw4_num_orphan_exposure(p_actor uuid) | volatile | - | 0 |
| tw4_num_orphan_resolve(p_orphan_id uuid, p_actor uuid, p_resolution text, p_note text) | volatile | - | 0 |
| tw4_num_recon_claim(p_studio_id uuid, p_lease_owner text, p_lease_seconds integer) | volatile | - | 0 |
| tw4_num_recon_mark(p_entity uuid) | volatile | - | 0 |
| tw4_num_record_sender(p_studio_id uuid, p_actor uuid) | volatile | localStack.j4activation (10) | 10 |
| tw4_num_registration_retry(p_studio_id uuid, p_actor uuid) | volatile | localStack.f4recovery (1), localStack.r2brfl (5) | 6 |
| tw4_num_reopen(p_studio_id uuid, p_actor uuid, p_reason text) | volatile | - | 0 |
| tw4_num_resolve(p_operation_id uuid, p_actor uuid, p_resolution text, p_provider_sid text, p_note text) | volatile | - | 0 |
| tw4_num_retire(p_studio_id uuid, p_actor uuid, p_note text) | volatile | localStack.r2brfl (2) | 2 |
| tw4_num_select(p_studio_id uuid, p_actor uuid, p_offer_id uuid, p_e164 text, p_ack_price_cents integer, p_approval_ref text) | volatile | localStack.j3owner (7), localStack.tw4fj1 (1) | 8 |
| tw4_num_select_as_owner(p_studio_id uuid, p_offer_id uuid, p_e164 text, p_ack_price_cents integer) | volatile | localStack.j3owner (7), localStack.tw4fj1 (1) | 8 |
| tw4_num_settle_admin(p_operation_id uuid, p_actor uuid, p_outcome text, p_note text) | volatile | - | 0 |
| tw4_num_status(p_studio_id uuid, p_actor uuid) | volatile | localStack.tw4fj1 (1) | 1 |
| tw4_num_withdraw(p_studio_id uuid, p_actor uuid, p_selection_id uuid, p_note text) | volatile | localStack.j3owner (3) | 3 |
| tw4_num_withdraw_as_owner(p_studio_id uuid, p_selection_id uuid, p_note text) | volatile | localStack.j3owner (3) | 3 |
| tw4_onboarding_decide_tier(p_studio_id uuid, p_actor uuid, p_tier text, p_reason text, p_eligibility jsonb) | volatile | localStack.feeres (1), localStack.r2a (2), localStack.tw4fi (4) | 7 |
| tw4_onboarding_set_tier(p_studio_id uuid, p_actor uuid, p_tier text, p_reason text) | volatile | localStack.tw4fi (1) | 1 |
| tw4_panel_subaccount_confirm(p_request_key uuid, p_studio_id uuid, p_actor uuid) | volatile | - | 0 |
| tw4_pilot_exception_create(p_entity_id uuid, p_ceiling_cents integer, p_approval_ref text, p_actor uuid, p_evidence_authorized_on date, p_evidence_role text, p_evidence_scope text, p_evidence_amount_cents integer, p_evidence_document_ref text, p_evidence_sha256 text) | volatile | localStack.f1funding (1), localStack.f4recovery (1), localStack.feeres (1), localStack.r2a (2), localStack.tw4f3a (2), localStack.j4activation (2), localStack.r2brfl (1), localStack.tw4fj1 (1), localStack.tw4pilothard (1), localStack.tw4rfl (1), localStack.tw4rfld5 (1), localStack.tw4rflevid (1), localStack.tw4rflspend (2), localStack.tw4rflops (1) | 18 |
| tw4_price_set(p_kind text, p_customer_cents integer, p_provider_cents integer, p_description text, p_actor uuid) | volatile | localStack.tw4monthly (4), localStack.tw4recexec (6), localStack.tw4recurring (4), localStack.f3recon (1), localStack.tw4inbound (34), localStack.tw4recon (2), localStack.tw4rv (1), localStack.tw4sender (1), localStack.tw4usage (4), localStack.f1funding (2), localStack.f4recovery (1), localStack.feeres (3), localStack.r2a (6), localStack.tw4f3a (3), localStack.tw4f3b0 (2), localStack.tw4fi (2), localStack.j4activation (4), localStack.r2brfl (2), localStack.tw4fj1 (3), localStack.tw4pilothard (4), localStack.tw4rfl (2), localStack.tw4rfld5 (2), localStack.tw4rflevid (2), localStack.tw4rflspend (4), localStack.tw4rflops (2) | 101 |
| tw4_prov_begin(p_onboarding_id uuid, p_lease_owner text, p_op_kind text, p_friendly_name text, p_request_digest text, p_params jsonb, p_actor uuid) | volatile | localStack.feeres (27), localStack.r2a (80), localStack.tw4fj1 (7) | 114 |
| tw4_prov_claim(p_studio_id uuid, p_actor uuid, p_lease_owner text, p_lease_seconds integer, p_mode text) | volatile | localStack.feeres (14), localStack.r2a (88), localStack.tw4fj1 (7) | 109 |
| tw4_prov_context(p_onboarding_id uuid, p_lease_owner text) | volatile | localStack.feeres (14), localStack.r2a (80), localStack.tw4fj1 (7) | 101 |
| tw4_prov_evidence_claim(p_studio_id uuid, p_actor uuid, p_lease_owner text, p_lease_seconds integer) | volatile | localStack.feeres (61), localStack.r2a (4) | 65 |
| tw4_prov_evidence_targets(p_onboarding_id uuid, p_lease_owner text) | volatile | localStack.feeres (36), localStack.r2a (4) | 40 |
| tw4_prov_finish(p_onboarding_id uuid, p_lease_owner text, p_operation_id uuid, p_status text, p_provider_sid text, p_error_code text, p_error_detail text) | volatile | localStack.feeres (17), localStack.r2a (30), localStack.tw4fj1 (2) | 49 |
| tw4_prov_listing_record(p_onboarding_id uuid, p_lease_owner text, p_operation_id uuid, p_facts jsonb, p_source text, p_digest text) | volatile | localStack.feeres (44), localStack.r2a (4) | 48 |
| tw4_prov_observe(p_onboarding_id uuid, p_lease_owner text, p_operation_id uuid, p_facts jsonb, p_expected_inbound text, p_source text, p_digest text) | volatile | localStack.f4recovery (21), localStack.feeres (14), localStack.r2a (104), localStack.tw4fj1 (11) | 150 |
| tw4_prov_orphan_close(p_orphan_id uuid, p_actor uuid, p_note text) | volatile | localStack.feeres (5) | 5 |
| tw4_prov_orphan_register(p_orphan_id uuid, p_actor uuid) | volatile | localStack.feeres (2) | 2 |
| tw4_prov_reopen(p_studio_id uuid, p_actor uuid, p_reason text) | volatile | localStack.r2a (2) | 2 |
| tw4_prov_resolve(p_operation_id uuid, p_actor uuid, p_resolution text, p_provider_sid text, p_note text) | volatile | localStack.r2ci1 (2), localStack.feeres (3), localStack.r2a (2) | 7 |
| tw4_prov_settle_admin(p_operation_id uuid, p_actor uuid, p_kind text, p_outcome text, p_note text) | volatile | localStack.feeres (1) | 1 |
| tw4_prov_status(p_studio_id uuid, p_actor uuid) | volatile | localStack.r2ci1 (15), localStack.r2a (2) | 17 |
| tw4_reconcile_run_begin(p_job text, p_runner text, p_lease_seconds integer) | volatile | localStack.f3recon (2), localStack.tw4recon (50), localStack.tw4rv (44), localStack.tw4sender (5), localStack.tw4a9 (9) | 110 |
| tw4_reconcile_run_finish(p_run_id uuid, p_status text, p_summary jsonb, p_error text) | volatile | localStack.f3recon (2), localStack.tw4recon (45), localStack.tw4rv (35), localStack.tw4sender (5), localStack.tw4a9 (7) | 94 |
| tw4_recurring_authorize(p_studio_id uuid, p_user_id uuid, p_kind text, p_acknowledged_price_cents integer, p_term_months integer, p_total_limit_cents integer) | volatile | localStack.tw4monthly (9), localStack.tw4recexec (34), localStack.tw4recurring (42), localStack.tw4inbound (13), localStack.tw4usage (1), localStack.feeres (3), localStack.r2a (6), localStack.tw4fi (1), localStack.j4activation (8), localStack.tw4rfl (15) | 132 |
| tw4_recurring_charge(p_authorization_id uuid, p_period_key text, p_run_id uuid) | volatile | localStack.tw4monthly (17), localStack.tw4recexec (31), localStack.tw4recurring (52), localStack.tw4inbound (6), localStack.r2brfl (11), localStack.tw4rfl (10) | 127 |
| tw4_recurring_release_ended() | volatile | localStack.tw4monthly (2), localStack.tw4recexec (12), localStack.tw4recurring (6) | 20 |
| tw4_recurring_revoke(p_authorization_id uuid, p_user_id uuid) | volatile | localStack.tw4monthly (3), localStack.tw4recexec (2), localStack.tw4recurring (11), localStack.tw4inbound (1), localStack.tw4fi (1), localStack.tw4rfl (1) | 19 |
| tw4_recurring_run_begin(p_runner text, p_lease_seconds integer) | volatile | localStack.tw4recexec (56) | 56 |
| tw4_recurring_run_finish(p_run_id uuid, p_status text, p_summary jsonb, p_error text) | volatile | localStack.tw4recexec (24) | 24 |
| tw4_recurring_set_switch(p_enabled boolean, p_actor uuid, p_reason text) | volatile | localStack.tw4recexec (24), localStack.j4activation (2) | 26 |
| tw4_rfl_alert_delivery_record(p_alert_id uuid, p_claim_token uuid, p_recipient_ref text, p_recipient_kind text, p_outcome text) | volatile | localStack.feeres (2), localStack.tw4rflops (11) | 13 |
| tw4_rfl_alert_finish(p_alert_id uuid, p_claim_token uuid, p_delivered boolean, p_error text) | volatile | localStack.feeres (3), localStack.tw4rfl (4), localStack.tw4rflops (3) | 10 |
| tw4_rfl_alert_release(p_alert_id uuid, p_claim_token uuid) | volatile | localStack.tw4rflops (34) | 34 |
| tw4_rfl_alerts_claim(p_limit integer) | volatile | localStack.feeres (3), localStack.r2bp2.rfl (1), localStack.tw4rfl (6), localStack.tw4rflops (17) | 27 |
| tw4_rfl_cancel_authorize(p_resource_id uuid, p_actor uuid, p_approval_ref text, p_decided_by text, p_reason text, p_irreversible_ack boolean) | volatile | localStack.r2brfl (6), localStack.tw4rfl (42), localStack.tw4rflops (16) | 64 |
| tw4_rfl_cancel_begin(p_operation_id uuid, p_actor uuid) | volatile | localStack.r2brfl (6), localStack.tw4rfl (37), localStack.tw4rflops (2) | 45 |
| tw4_rfl_cancel_finish(p_operation_id uuid, p_actor uuid, p_outcome text, p_evidence_digest text, p_error_code text) | volatile | localStack.r2brfl (6), localStack.tw4rfl (29), localStack.tw4rflops (2) | 37 |
| tw4_rfl_cancel_resolve(p_operation_id uuid, p_actor uuid, p_resolution text, p_evidence_digest text, p_note text) | volatile | localStack.tw4rfl (9) | 9 |
| tw4_rfl_cancel_withdraw(p_operation_id uuid, p_actor uuid, p_note text) | volatile | localStack.tw4rfl (3), localStack.tw4rflops (1) | 4 |
| tw4_rfl_dual_approve(p_request_id uuid, p_actor uuid, p_note text) | volatile | localStack.r2brfl (6), localStack.tw4rfl (18), localStack.tw4rflops (47) | 71 |
| tw4_rfl_dual_list(p_actor uuid) | volatile | localStack.tw4rflops (21) | 21 |
| tw4_rfl_dual_reject(p_request_id uuid, p_actor uuid, p_note text) | volatile | localStack.tw4rflops (5) | 5 |
| tw4_rfl_dual_request(p_actor uuid, p_action text, p_resource_id uuid, p_period_key text, p_reason text, p_approval_ref text, p_decided_by text) | volatile | localStack.r2brfl (6), localStack.tw4rfl (18), localStack.tw4rflops (69) | 93 |
| tw4_rfl_escalate_delivery() | volatile | localStack.feeres (1), localStack.tw4rflops (4) | 5 |
| tw4_rfl_exposure_dispose(p_resource_id uuid, p_period_key text, p_actor uuid, p_disposition text, p_note text) | volatile | localStack.tw4rfl (6), localStack.tw4rflops (23) | 29 |
| tw4_rfl_inventory_gaps() | volatile | localStack.tw4rfl (5) | 5 |
| tw4_rfl_observe_provider_bill(p_resource_id uuid, p_period_key text, p_provider_ref text, p_cost_cents integer, p_actor uuid) | volatile | localStack.tw4rfl (15), localStack.tw4rflops (6) | 21 |
| tw4_rfl_pilot_cover(p_resource_id uuid, p_period_key text, p_approval_ref text, p_actor uuid, p_authorized_on date, p_authorized_by_role text, p_scope text, p_amount_cents integer, p_evidence_period_key text, p_document_ref text, p_document_sha256 text) | volatile | localStack.f1funding (19), localStack.f4recovery (2), localStack.j4activation (10), localStack.tw4pilothard (3), localStack.tw4rfl (8), localStack.tw4rfld5 (16), localStack.tw4rflevid (52), localStack.tw4rflspend (3), localStack.tw4rflops (1) | 114 |
| tw4_rfl_register(p_studio_id uuid, p_actor uuid, p_kind text, p_provider_sid text, p_account_sid text, p_e164 text, p_source text, p_source_operation uuid, p_initial_reservation uuid) | volatile | localStack.f1funding (32), localStack.feeres (1), localStack.j4activation (10), localStack.r2brfl (7), localStack.tw4pilothard (5), localStack.tw4rfl (119), localStack.tw4rfld5 (24), localStack.tw4rflevid (62), localStack.tw4rflspend (2), localStack.tw4rflops (60) | 322 |
| tw4_rfl_scan_begin(p_runner text, p_lease_seconds integer) | volatile | localStack.tw4rflops (17) | 17 |
| tw4_rfl_scan_entity(p_entity_id uuid) | volatile | localStack.tw4rfl (48), localStack.tw4rfld5 (1), localStack.tw4rflops (50) | 99 |
| tw4_rfl_scan_finish(p_run_id uuid, p_status text, p_summary jsonb, p_error text) | volatile | localStack.tw4rflops (8) | 8 |
| tw4_rfl_set_switch(p_switch text, p_enabled boolean, p_actor uuid, p_reason text) | volatile | localStack.feeres (2), localStack.j4activation (4), localStack.tw4rfl (4), localStack.tw4rflops (35) | 45 |
| tw4_rfl_suspend_df(p_studio_id uuid, p_actor uuid, p_reason text, p_hold boolean) | volatile | localStack.tw4rfl (12), localStack.tw4rflops (5) | 17 |
| tw4_rfl_variance_ack(p_charge_id uuid, p_actor uuid, p_note text) | volatile | localStack.tw4rflops (2) | 2 |
| tw4_runner_account(p_onboarding_id uuid, p_lease_owner text) | volatile | localStack.feeres (45), localStack.r2a (88), localStack.tw4f3a (14), localStack.tw4fj1 (13) | 160 |
| tw4_runner_begin_step(p_onboarding_id uuid, p_lease_owner text, p_step_key text, p_friendly_name text, p_fee_bearing boolean, p_fee_confirmed_by uuid, p_mock boolean) | volatile | localStack.tw4f1b (50), localStack.tw4f3a (36), localStack.tw4r1 (46) | 132 |
| tw4_runner_brand_approved(p_onboarding_id uuid, p_lease_owner text) | volatile | localStack.tw4r1 (1) | 1 |
| tw4_runner_claim(p_studio_id uuid, p_actor uuid, p_lease_owner text, p_lease_seconds integer, p_mode text) | volatile | localStack.tw4f1b (24), localStack.tw4f3a (16), localStack.tw4r1 (11) | 51 |
| tw4_runner_confirm_submission(p_onboarding_id uuid, p_lease_owner text, p_step_key text, p_actor uuid) | volatile | localStack.tw4f1b (5), localStack.tw4f3a (4), localStack.tw4r1 (4) | 13 |
| tw4_runner_fee_kinds(p_onboarding_id uuid, p_lease_owner text) | volatile | localStack.tw4fi (1) | 1 |
| tw4_runner_finish_step(p_onboarding_id uuid, p_lease_owner text, p_step_key text, p_status text, p_provider_sid text, p_error_code text, p_error_detail text) | volatile | localStack.tw4f1b (50), localStack.tw4f3a (36), localStack.tw4r1 (46) | 132 |
| tw4_runner_get_ein(p_onboarding_id uuid, p_lease_owner text, p_actor uuid) | volatile | localStack.tw4f1b (4), localStack.tw4f3a (2), localStack.tw4r1 (3) | 9 |
| tw4_runner_get_inputs(p_onboarding_id uuid, p_lease_owner text) | volatile | localStack.feeres (14), localStack.r2a (60), localStack.tw4f1b (8), localStack.tw4f3a (12), localStack.tw4r1 (9), localStack.tw4fj1 (5) | 108 |
| tw4_runner_record_brand(p_onboarding_id uuid, p_lease_owner text, p_brand_sid text, p_brand_status text) | volatile | localStack.tw4f1b (1), localStack.tw4f3a (3), localStack.tw4r1 (4) | 8 |
| tw4_runner_record_evaluation(p_onboarding_id uuid, p_lease_owner text, p_step_key text, p_verdict text, p_context text) | volatile | localStack.tw4f1b (11), localStack.tw4f3a (8), localStack.tw4r1 (9) | 28 |
| tw4_runner_release(p_onboarding_id uuid, p_lease_owner text) | volatile | localStack.feeres (65), localStack.r2a (92), localStack.tw4f1b (24), localStack.tw4f3a (16), localStack.tw4r1 (11), localStack.tw4fj1 (13) | 221 |
| tw4_runner_set_window(p_studio_id uuid, p_actor uuid, p_hours integer, p_reason text) | volatile | localStack.feeres (5), localStack.r2a (14), localStack.tw4f1b (3), localStack.tw4f3a (3), localStack.tw4r1 (4), localStack.tw4fj1 (2) | 31 |
| tw4_runner_tier(p_onboarding_id uuid, p_lease_owner text) | volatile | localStack.tw4f1b (8), localStack.tw4f3a (12), localStack.tw4r1 (9) | 29 |
| tw4_runner_transition(p_onboarding_id uuid, p_lease_owner text, p_to_state text, p_step text, p_error_code text, p_error_field text) | volatile | localStack.feeres (2), localStack.tw4f1b (5), localStack.tw4f3a (5), localStack.tw4r1 (7) | 19 |
| tw4_sender_record(p_studio_id uuid, p_actor uuid, p_messaging_service_sid text, p_campaign_sid text, p_phone_number_sid text, p_sender_e164 text, p_reason text) | volatile | localStack.f3recon (1), localStack.tw4recon (2), localStack.tw4rv (39), localStack.tw4sender (24), localStack.tw4usage (4), localStack.j4activation (6) | 76 |
| tw4_sender_reverify(p_studio_id uuid, p_sender_id uuid, p_evidence jsonb, p_source text) | volatile | localStack.tw4rv (39), localStack.tw4sender (5) | 44 |
| tw4_sender_reverify_run(p_run_id uuid, p_studio_id uuid, p_sender_id uuid, p_evidence jsonb, p_source text) | volatile | localStack.tw4rv (40), localStack.tw4sender (5) | 45 |
| tw4_sender_revoke(p_studio_id uuid, p_actor uuid, p_reason text, p_release boolean) | volatile | localStack.tw4sender (11), localStack.tw4usage (1), localStack.j4activation (6), localStack.tw4rfl (12), localStack.tw4rflops (2) | 32 |
| tw4_sender_verify(p_studio_id uuid, p_sender_id uuid, p_actor uuid, p_evidence jsonb, p_attested_opt_out boolean, p_source text) | volatile | localStack.f3recon (1), localStack.tw4recon (2), localStack.tw4rv (41), localStack.tw4sender (38), localStack.tw4usage (4), localStack.j4activation (6) | 92 |
| tw4_spend_authorize(p_entity_id uuid, p_kind text, p_amount_cents integer, p_approval_ref text, p_actor uuid, p_funding text, p_studio_id uuid, p_evidence_authorized_on date, p_evidence_role text, p_evidence_scope text, p_evidence_amount_cents integer, p_evidence_period_key text, p_evidence_document_ref text, p_evidence_sha256 text) | volatile | localStack.tw4monthly (1), localStack.feeres (10), localStack.r2a (24), localStack.tw4f3a (8), localStack.tw4fi (37), localStack.tw4fj1 (3), localStack.tw4pilothard (14), localStack.tw4rfl (1), localStack.tw4rflspend (48) | 146 |
| tw4_spend_reserve(p_onboarding_id uuid, p_lease_owner text, p_kind text) | volatile | localStack.tw4f3a (8), localStack.tw4fi (13) | 21 |
| tw4_spend_settle(p_onboarding_id uuid, p_lease_owner text, p_kind text, p_outcome text, p_ref text) | volatile | localStack.tw4f3a (5), localStack.tw4fi (13) | 18 |
| tw4_spend_withdraw(p_spend_event_id uuid, p_actor uuid, p_note text) | volatile | localStack.tw4monthly (1), localStack.r2a (8), localStack.tw4f3a (2), localStack.tw4fi (20) | 31 |
| tw4_subaccount_begin(p_entity_id uuid, p_actor uuid, p_friendly_name text, p_environment text) | volatile | localStack.tw4f3a (5) | 5 |
| tw4_subaccount_confirm(p_entity_id uuid, p_actor uuid) | volatile | localStack.tw4f3a (5) | 5 |
| tw4_subaccount_finish(p_entity_id uuid, p_actor uuid, p_status text, p_account_sid text) | volatile | localStack.tw4f3a (5) | 5 |
| tw4_usage_begin(p_source_kind text, p_source_id uuid, p_studio_id uuid, p_client_id uuid, p_phone_e164 text, p_body text, p_message_type text, p_related_table text, p_related_id uuid, p_sent_by uuid) | volatile | localStack.f3recon (3), localStack.tw4recon (62), localStack.tw4rv (2), localStack.tw4sender (31), localStack.tw4usage (69) | 167 |
| tw4_usage_billed_sender_set(p_studio_id uuid, p_actor uuid, p_messaging_service_sid text, p_sender_e164 text, p_status text, p_reason text) | volatile | - | 0 |
| tw4_usage_dispatching(p_attempt_id uuid) | volatile | localStack.tw4recon (59), localStack.tw4rv (2), localStack.tw4sender (26), localStack.tw4usage (52) | 139 |
| tw4_usage_escalate(p_run_id uuid, p_limit integer) | volatile | localStack.tw4recon (6) | 6 |
| tw4_usage_evidence_failed(p_attempt_id uuid, p_code text, p_definite boolean) | volatile | localStack.tw4recon (22), localStack.tw4usage (2) | 24 |
| tw4_usage_record_callback(p_attempt_id uuid, p_provider_sid text, p_signer_account text, p_status text, p_error_code text) | volatile | localStack.tw4recon (8), localStack.tw4sender (3), localStack.tw4usage (8) | 19 |
| tw4_usage_rejected(p_attempt_id uuid, p_error_code text) | volatile | localStack.tw4usage (3) | 3 |
| tw4_usage_release_stale(p_run_id uuid, p_limit integer) | volatile | localStack.tw4recon (4) | 4 |
| tw4_usage_release_unprepared(p_attempt_id uuid, p_code text) | volatile | localStack.tw4sender (3) | 3 |
| tw4_usage_release_unsent() | volatile | localStack.tw4recon (7), localStack.tw4usage (5) | 12 |
| tw4_usage_resolve(p_attempt_id uuid, p_actor uuid, p_outcome text, p_segments integer, p_reason text) | volatile | localStack.tw4recon (3), localStack.tw4usage (5) | 8 |
| tw4_usage_set_switch(p_enabled boolean, p_actor uuid, p_reason text) | volatile | localStack.f3recon (5), localStack.tw4recon (34), localStack.tw4rv (1), localStack.tw4sender (1), localStack.tw4usage (29), localStack.j4activation (2) | 72 |
| tw4_usage_settle(p_attempt_id uuid, p_evidence jsonb) | volatile | localStack.tw4recon (61), localStack.tw4usage (35) | 96 |
| tw4_usage_submitted(p_attempt_id uuid, p_provider_sid text) | volatile | localStack.tw4recon (53), localStack.tw4sender (2), localStack.tw4usage (37) | 92 |
| tw4_usage_touch(p_attempt_id uuid) | volatile | - | 0 |
| tw4_usage_uncertain(p_attempt_id uuid, p_error_code text) | volatile | localStack.tw4recon (3), localStack.tw4usage (6) | 9 |
| upsert_sms_contact_permission(p_studio_id uuid, p_organizer_id uuid, p_client_id uuid, p_organizer_contact_id uuid, p_phone_e164 text, p_consent_status text, p_consent_source text, p_consent_note text) | volatile | - | 0 |

#### Uncovered (zero recorded calls)
- _sms_onb_refuse_truncate()
- _sms_webhook_receipts_guard()
- _tw4c_truncate_guard()
- _tw4f1b_confirmations_truncate_guard()
- _tw4fi_append_only()
- _tw4ml_guard()
- _tw4num_free_selection(p_selection uuid, p_actor uuid, p_note text)
- _tw4p1_guard()
- _tw4p_append_only_guard()
- _tw4us_append_only()
- prevent_sms_consent_history_change()
- purge_due_sms_onboarding_eins()
- record_sms_public_opt_in(p_studio_id uuid, p_client_id uuid, p_phone_e164 text, p_source text, p_note text)
- sms_webhook_receipt_record(p_kind text, p_event_key text, p_account_sid text)
- tw4_num_history_observe(p_onboarding_id uuid, p_lease_owner text, p_facts jsonb, p_source text, p_digest text)
- tw4_num_identity_observe(p_onboarding_id uuid, p_lease_owner text, p_facts jsonb, p_source text, p_digest text)
- tw4_num_inventory_ack(p_studio_id uuid, p_actor uuid, p_phone_number_sid text, p_note text)
- tw4_num_inventory_status(p_studio_id uuid, p_actor uuid)
- tw4_num_orphan_exposure(p_actor uuid)
- tw4_num_orphan_resolve(p_orphan_id uuid, p_actor uuid, p_resolution text, p_note text)
- tw4_num_recon_claim(p_studio_id uuid, p_lease_owner text, p_lease_seconds integer)
- tw4_num_recon_mark(p_entity uuid)
- tw4_num_reopen(p_studio_id uuid, p_actor uuid, p_reason text)
- tw4_num_resolve(p_operation_id uuid, p_actor uuid, p_resolution text, p_provider_sid text, p_note text)
- tw4_num_settle_admin(p_operation_id uuid, p_actor uuid, p_outcome text, p_note text)
- tw4_panel_subaccount_confirm(p_request_key uuid, p_studio_id uuid, p_actor uuid)
- tw4_usage_billed_sender_set(p_studio_id uuid, p_actor uuid, p_messaging_service_sid text, p_sender_e164 text, p_status text, p_reason text)
- tw4_usage_touch(p_attempt_id uuid)
- upsert_sms_contact_permission(p_studio_id uuid, p_organizer_id uuid, p_client_id uuid, p_organizer_contact_id uuid, p_phone_e164 text, p_consent_status text, p_consent_source text, p_consent_note text)