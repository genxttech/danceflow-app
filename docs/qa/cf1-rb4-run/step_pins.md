## 20270101090000_competition_e1_officials.sql  (new fns: 18, redefined: 0, dropped: 0)

## 20270102090000_competition_e2_ballots.sql  (new fns: 29, redefined: 0, dropped: 0)

## 20270106090000_competition_o1_day_of.sql  (new fns: 11, redefined: 0, dropped: 0)

## 20270110090000_competition_k1_setup_fixes.sql  (new fns: 0, redefined: 1, dropped: 0)
| add_competition_division(uuid,text,text,text) | pre 9be8c835d0d053101a685150b31f5229 [NOT in migration/rollback file] | post e85048964bd66bcb2c758275e7620997 [NOT in file] | CR in applied def: false |

## 20270113090000_competition_scoring_registry.sql  (new fns: 11, redefined: 0, dropped: 0)

## 20270114090000_competition_f2_results_lifecycle.sql  (new fns: 24, redefined: 2, dropped: 0)
| _compe2_guard_ballot_insert() | pre bf42705de4337864940a6f73b54afda9 [in rollback file] | post 1fba5e9f1c47b83440597afef2861490 [NOT in file] | CR in applied def: false |
| _compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid) | pre f28880cece349cd1a52179f89ccf2e7c [in rollback file] | post 4e16740112345ac0c306e841b82ac473 [NOT in file] | CR in applied def: false |

## 20270115090000_competition_ns1_heat_no_shows.sql  (new fns: 6, redefined: 6, dropped: 0)
| _compe2_guard_mark_insert() | pre 007fd7de4aa3dd6ca1ba25962b6f3b61 [in rollback file] | post 786bdf3604fa36e5f8328ecc0d5385ad [NOT in file] | CR in applied def: false |
| _compe2_heat_entries(uuid) | pre 280a98ecd18f3cac6a332312dae4c8f8 [in rollback file] | post f275ced91a3b319aaf0835f67bfe174d [NOT in file] | CR in applied def: false |
| _compe2_round_entries(uuid) | pre 5733a9f338621b983a0b771570ad4833 [in rollback file] | post f0da6935a3dcc04320f7636da6655a3b [NOT in file] | CR in applied def: false |
| _compe2_round_heats(uuid) | pre 588b53f7e7662cb0df46554310312426 [in rollback file] | post 1e75e888142ed1727eb6b2d6c8c0a906 [NOT in file] | CR in applied def: false |
| competition_judge_ballot_sheet(uuid) | pre f89262a01859317442be13c8d6be0239 [in rollback file] | post eada65f81faa04248816773818006a14 [NOT in file] | CR in applied def: false |
| competition_round_ballot_status(uuid) | pre 6ed6628d3da9444ec24d25c36fd1d4c2 [in rollback file] | post d1aca173a954764731862a341a1d5e7e [NOT in file] | CR in applied def: false |

## 20270116090000_competition_ss1_round_scoring_lock.sql  (new fns: 3, redefined: 0, dropped: 0)

## 20270117090000_competition_cx1_correction_ballot_readers.sql  (new fns: 0, redefined: 2, dropped: 0)
| competition_judge_ballot_sheet(uuid) | pre eada65f81faa04248816773818006a14 [in rollback file] | post 21cd3df42b8789e3b1baade47a0231d0 [NOT in file] | CR in applied def: false |
| competition_round_ballot_status(uuid) | pre d1aca173a954764731862a341a1d5e7e [in rollback file] | post a3f5226acc9a40cdedd83d9c0a0fee24 [NOT in file] | CR in applied def: false |

## 20270118090000_competition_ss1_advancement_freeze.sql  (new fns: 1, redefined: 0, dropped: 0)

## 20270119090000_competition_hl1_heat_guards.sql  (new fns: 3, redefined: 1, dropped: 0)
| lock_competition_round_ballots(uuid,uuid) | pre a10fc61528af902c0d7fd0e00caaa155 [in rollback file] | post 6e4175342d51ffe274d70ce413bae8c3 [NOT in file] | CR in applied def: false |

## 20270120085000_competition_cf1_a1_eligibility_helpers.sql  (new fns: 11, redefined: 0, dropped: 0)

## 20270120090000_competition_cf1_callback_final_advancement.sql  (new fns: 30, redefined: 7, dropped: 0)
| _comp10d_copy_floor_plan(uuid,uuid) | pre 8162a7341b7bcd00a141e81392c8c602 [in rollback file] | post d8a61d3432db9f4b116227bff575a2ee [NOT in file] | CR in applied def: false |
| _comp10d_guard_floor_heat() | pre bd20973caffce985813daadde8be947a [in rollback file] | post f34af508b3da4d249c0245a8c16d8f0b [NOT in file] | CR in applied def: false |
| _comp10d_guard_heat_child() | pre 9bb78230385387a3c6a39e66f2d9f8d0 [in rollback file] | post f4b9277a0d6e2867640210ef513e5c5b [NOT in file] | CR in applied def: false |
| competition_audit_log(uuid,uuid,integer) | pre d38b87512d066907b37702addc6cd116 [in rollback file] | post f6bb04ec82b4e39d2df0ef438a223ba1 [NOT in file] | CR in applied def: false |
| complete_competition_round(uuid,uuid) | pre dd0e1cd4c02bb51bbd75471c113a1f9f [in rollback file] | post e4c105ac6ea9017eb7f3c5fa5dea789f [NOT in file] | CR in applied def: false |
| set_competition_round_heat_capacity(uuid,integer) | pre 4fbc864079928710917ea67d7968d8bb [in rollback file] | post acd3d68f8971b0292910d6c64236ec39 [NOT in file] | CR in applied def: false |
| validate_competition_heat_schedule_placement() | pre f2079401a3a92c3289405547d2fe511b [in rollback file] | post 2359c5515dcc8a1c10f87ee32faa3d4b [NOT in file] | CR in applied def: false |

## 20270120091000_competition_cf1_a4a_callback_target_guard.sql  (new fns: 0, redefined: 4, dropped: 0)
| _cf1_callback_target_check(integer,integer) | pre 1bd9c67d1476753760fe2725e27fe121 [NOT in migration/rollback file] | post 9d157c2ff103eaa9889e549d44ac68e7 [NOT in file] | CR in applied def: false |
| cf1_guard_callback_target_capacity() | pre 852618baeb7cff14d8286aa241a59771 [NOT in migration/rollback file] | post 97e78cbb505cc56b9393afc931b70294 [NOT in file] | CR in applied def: false |
| cf1_guard_callback_target_program_lock() | pre 44ed866b50c0077c5ee537d13dd66f86 [NOT in migration/rollback file] | post f564ff1bc4163c0a37b29ce9a15253e5 [NOT in file] | CR in applied def: false |
| set_competition_round_heat_capacity(uuid,integer,text,uuid) | pre 52c174e637b3c7ba37fe1b6877b0adbf [NOT in migration/rollback file] | post d66154c6d7d8085b94e7d82609e492e6 [NOT in file] | CR in applied def: false |

## 20270120092000_competition_cf1_a2_lock_check.sql  (new fns: 0, redefined: 1, dropped: 0)
| lock_competition_round_ballots(uuid,uuid) | pre 6e4175342d51ffe274d70ce413bae8c3 [in rollback file] | post c4ba327df7943d559ab52ccd07d20ea0 [in migration file] | CR in applied def: false |

## 20270120093000_competition_cf1_a3_results_integrity.sql  (new fns: 0, redefined: 10, dropped: 0)
| _compe2_guard_mark_insert() | pre 786bdf3604fa36e5f8328ecc0d5385ad [in rollback file] | post 055adcc12d8f903a7570c93008f303a9 [in migration file] | CR in applied def: false |
| _compe2_heat_entries(uuid) | pre f275ced91a3b319aaf0835f67bfe174d [in rollback file] | post fdcb8728dde030c8d9772fdaf2963524 [in migration file] | CR in applied def: false |
| _compe2_round_entries(uuid) | pre f0da6935a3dcc04320f7636da6655a3b [in rollback file] | post 64859bac497c22fd7472b9e7ae6fc986 [in migration file] | CR in applied def: false |
| _compe2_round_heats(uuid) | pre 1e75e888142ed1727eb6b2d6c8c0a906 [in rollback file] | post 7a5a1563a9450e2ec3b807a69737f9f4 [in migration file] | CR in applied def: false |
| _compf2_evidence(uuid,text,text) | pre 2b1c9a22be4a4c4a4e5ba43adee37306 [in rollback file] | post 415a823b4a689cae26b8a20187af58e7 [in migration file] | CR in applied def: false |
| approve_competition_round_result(uuid,uuid,text,uuid) | pre 0650367be64e3d1b4387a3dbceba3d4a [in rollback file] | post ac33e456925e64665db1ea0547bae18b [in migration file] | CR in applied def: false |
| calculate_competition_round(uuid,text,text,text,text,jsonb,jsonb,jsonb,uuid) | pre ddaa45cbb518f7592f5ca6dd0ba00176 [in rollback file] | post bc3cc4397e740444a4d4a53d93b499cc [in migration file] | CR in applied def: false |
| competition_judge_ballot_sheet(uuid) | pre 21cd3df42b8789e3b1baade47a0231d0 [in rollback file] | post 2506cb2f466d1738fb1a8f298e805b5f [in migration file] | CR in applied def: false |
| competition_round_ballot_status(uuid) | pre a3f5226acc9a40cdedd83d9c0a0fee24 [in rollback file] | post 7d3bebe922fed33604666009d3a593a5 [in migration file] | CR in applied def: false |
| competition_round_results_review(uuid) | pre c842be1dafce548cd279f1d2d6f6f1d0 [in rollback file] | post c9d747907caad0a88b75da1c53862f43 [in migration file] | CR in applied def: false |

## 20270120094000_competition_cf1_a5_exclusion_action.sql  (new fns: 14, redefined: 0, dropped: 0)

## 20270120095000_competition_cf1_a6_withdrawal.sql  (new fns: 17, redefined: 0, dropped: 0)

## 20270120096000_competition_cf1_a7_od13_correction_integrity.sql  (new fns: 16, redefined: 1, dropped: 0)
| _compe2_insert_ballot(uuid,uuid,uuid,uuid,text,uuid,jsonb,text,uuid) | pre 4e16740112345ac0c306e841b82ac473 [in rollback file] | post e5cecd7b4cff91bbdb7222cc5061b4d9 [in migration file] | CR in applied def: false |
