-- Phase 10C.5 (continued): studio_simple@3, competition event operations guard, NDCA Multi-Dance hold.
--
-- Forward migration on top of 20261113090000_phase10c5_competition_draft.sql. Rules profiles are immutable once a
-- program references them, and studio_simple@2 is referenced on DEV, so the corrected profile is a NEW version:
--   1. studio_simple@3 "Studio / Custom Rules" (schema 2), the profile new wizard setups use. studio_simple@1 and
--      studio_simple@2 are not read, changed or retired: programs keep resolving the version they were created from.
--   2. Venue, address, dates, times and time zone of competition events: only studio owners/admins and organizer
--      owners/admins (can_edit_competition_event_operations). A guard trigger on public.events applies the rule to
--      every write path for competition events (the events update policies, which live in the database but not in
--      repository migrations, allow any active studio role and organizer staff to update any column).
--   3. create_competition_draft: new setups need studio_simple@3 or later; venue, dates and time zone may change
--      (owner/admin only, change-only, refused while registrations, extra locations or dated records depend on
--      them); NDCA Multi-Dance sets are validated (style order, at least two dances, Open Amateur full set).
--   4. open_competition_registration: also refuses while a category carries a registration hold (Multi-Dance:
--      combined results are not computed).
--
-- A fresh database applies 20261113090000 (which seeds v2) and then this file; nothing here depends on v2.
-- Rollback: rollback/20261114090000_phase10c5_profile_v3_rollback.sql (restores the 20261113090000 functions
-- byte-for-byte, drops the guard, RETIRES -- never deletes -- v3).

-- ---------------------------------------------------------------------------
-- 0. Preflight: the 20261113090000 state
-- ---------------------------------------------------------------------------
do $$
begin
  if md5(pg_get_functiondef('public.open_competition_registration(uuid)'::regprocedure)) <> 'abe6b1940de5b96fd931cdddebfd9bed' then
    raise exception 'Phase 10C.5 v3 preflight: open_competition_registration is not the 20261113090000 definition.';
  end if;
  if to_regprocedure('public.create_competition_draft(uuid, jsonb)') is null
    or md5(pg_get_functiondef('public.create_competition_draft(uuid,jsonb)'::regprocedure)) <> '694b78b1d51d219f0fb4ce0f4b5f32d7' then
    raise exception 'Phase 10C.5 v3 preflight: create_competition_draft is not the 20261113090000 definition.';
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'events'
      and column_name in ('public_highlights', 'public_registration_info')) <> 2 then
    raise exception 'Phase 10C.5 v3 preflight: apply 20261113090000 first.';
  end if;
  if to_regprocedure('public.can_edit_competition_event_operations(uuid)') is not null
    or exists (select 1 from pg_trigger where tgrelid = 'public.events'::regclass and tgname = 'protect_competition_event_operations') then
    raise exception 'Phase 10C.5 v3 preflight: the event operations guard already exists.';
  end if;
  if not exists (select 1 from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 1 and status = 'active') then
    raise exception 'Phase 10C.5 v3 preflight: studio_simple@1 must exist and be active.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. studio_simple@3 -- Studio / Custom Rules (schema 2)
-- ---------------------------------------------------------------------------
do $$
declare
  v_defaults constant jsonb := $profile${
  "schema": 2,
  "label": "Studio / Custom Rules",
  "sanction": {
    "status": "none",
    "claimable": false
  },
  "roundsDefault": "final_only",
  "roundsNote": "Every division starts with a Final. Preliminary rounds can be added later if entry volume or the rules require them.",
  "currency": "USD",
  "terminology": {
    "division_label": "Division",
    "skill_label": "Level",
    "age_label": "Age group",
    "partner_label": "Partner",
    "dance_label": "Dance"
  },
  "adjudication": {
    "adjudicated": {
      "label": "Adjudicated",
      "description": "Produces an official competitive result."
    },
    "non_adjudicated": {
      "label": "Non-Adjudicated",
      "description": "No official competitive placement or result. Dancers can still receive feedback from an evaluator.",
      "judging": "non_adjudicated"
    }
  },
  "judging": {
    "medal_marks": {
      "label": "Medal Marks",
      "description": "Judges give Medal Marks. The marks are processed under the scoring rules to produce placements.",
      "input_label": "Medal Marks",
      "result_label": "Placement",
      "official_result": true,
      "feedback_modes": [
        "none",
        "written",
        "written_plus_grade",
        "written_plus_score"
      ],
      "scoring": {
        "basis": "studio_custom",
        "stages": [
          {
            "key": "final",
            "family": "final",
            "round_types": [
              "final"
            ],
            "ballot": {
              "input": "medal_marks",
              "scored_by": "entry"
            },
            "engine": {
              "key": "studio_placeholder",
              "status": "placeholder",
              "params": {
                "semantic": "medal marks are the judge input; placement is the result"
              }
            },
            "tie_break": {
              "chain": [],
              "note": "Studio / Custom placeholder; no tie-break rules are implemented yet."
            },
            "outputs": [
              {
                "type": "placement",
                "primary": true
              }
            ],
            "sources": []
          }
        ],
        "adjudication_stages": [],
        "source_conflicts": [],
        "note": "Studio / Custom placeholder. It does not implement UCWDC Majority Rules."
      },
      "engine": {
        "key": "custom",
        "version": 1
      },
      "competition_mode": "relative",
      "advancement_method": "none",
      "rounds": [
        {
          "round_type": "final",
          "name": "Final",
          "scoring_method": "custom"
        }
      ]
    },
    "placements": {
      "label": "Placements",
      "description": "Judges rank the dancers in each division and the best-ranked dancer places first.",
      "input_label": "Placement marks",
      "result_label": "Placement",
      "official_result": true,
      "feedback_modes": [
        "none",
        "written",
        "written_plus_grade",
        "written_plus_score"
      ],
      "scoring": {
        "basis": "studio_custom",
        "stages": [
          {
            "key": "final",
            "family": "final",
            "round_types": [
              "final"
            ],
            "ballot": {
              "input": "placement_marks",
              "scored_by": "entry"
            },
            "engine": {
              "key": "studio_placeholder",
              "status": "placeholder",
              "params": {}
            },
            "tie_break": {
              "chain": [],
              "note": "Studio / Custom placeholder; no tie-break rules are implemented yet."
            },
            "outputs": [
              {
                "type": "placement",
                "primary": true
              }
            ],
            "sources": []
          }
        ],
        "adjudication_stages": [],
        "source_conflicts": [],
        "note": "Studio / Custom placeholder. It is not NDCA Skating or WSDC Relative Placement."
      },
      "engine": {
        "key": "ordinal_majority",
        "version": 1
      },
      "competition_mode": "relative",
      "advancement_method": "none",
      "rounds": [
        {
          "round_type": "final",
          "name": "Final",
          "scoring_method": "ordinal_majority"
        }
      ]
    },
    "ratings": {
      "label": "Gold / Silver / Bronze",
      "description": "Judges rate each performance, so every dancer can earn a Gold, Silver or Bronze rating instead of a place.",
      "input_label": "Ratings",
      "result_label": "Rating",
      "official_result": true,
      "feedback_modes": [
        "none",
        "written",
        "written_plus_grade",
        "written_plus_score"
      ],
      "scoring": {
        "basis": "studio_custom",
        "stages": [
          {
            "key": "final",
            "family": "final",
            "round_types": [
              "final"
            ],
            "ballot": {
              "input": "rating",
              "scored_by": "entry",
              "scale": [
                "Bronze",
                "Silver",
                "Gold"
              ]
            },
            "engine": {
              "key": "studio_placeholder",
              "status": "placeholder",
              "params": {}
            },
            "tie_break": {
              "chain": [],
              "note": "Studio / Custom placeholder; no tie-break rules are implemented yet."
            },
            "outputs": [
              {
                "type": "rating",
                "primary": true
              }
            ],
            "sources": []
          }
        ],
        "adjudication_stages": [],
        "source_conflicts": [],
        "note": "Studio / Custom ratings."
      },
      "engine": {
        "key": "proficiency_rating",
        "version": 1
      },
      "competition_mode": "proficiency",
      "advancement_method": "none",
      "bands": [
        "Gold",
        "Silver",
        "Bronze"
      ],
      "rounds": [
        {
          "round_type": "final",
          "name": "Final",
          "scoring_method": "proficiency_rating"
        }
      ]
    },
    "non_adjudicated": {
      "label": "Non-Adjudicated",
      "description": "No official competitive result. Dancers may still receive evaluator feedback.",
      "input_label": null,
      "result_label": "No official competitive result",
      "official_result": false,
      "feedback_modes": [
        "none",
        "written",
        "written_plus_grade",
        "written_plus_score"
      ],
      "scoring": {
        "basis": "studio_custom",
        "stages": [
          {
            "key": "performance",
            "family": "final",
            "round_types": [
              "exhibition"
            ],
            "ballot": {
              "input": "none"
            },
            "engine": {
              "key": "none",
              "status": "not_applicable"
            },
            "tie_break": {
              "chain": []
            },
            "outputs": [
              {
                "type": "none",
                "primary": true
              }
            ],
            "sources": []
          }
        ],
        "adjudication_stages": [],
        "source_conflicts": []
      },
      "engine": {
        "key": "none",
        "version": 1
      },
      "competition_mode": "exhibition",
      "advancement_method": "none",
      "rounds": [
        {
          "round_type": "exhibition",
          "name": "Performance",
          "scoring_method": "none"
        }
      ]
    }
  },
  "feedback": {
    "options": [
      {
        "key": "none",
        "label": "No feedback",
        "outputs": []
      },
      {
        "key": "written",
        "label": "Written feedback",
        "outputs": [
          "critique_text"
        ]
      },
      {
        "key": "written_plus_grade",
        "label": "Written feedback + grade",
        "outputs": [
          "critique_text",
          "grade"
        ]
      },
      {
        "key": "written_plus_score",
        "label": "Written feedback + score",
        "outputs": [
          "critique_text",
          "numeric_score"
        ]
      }
    ],
    "default": "none",
    "note": "Feedback is evaluation only. A grade or score given as feedback never becomes a placement, ranking, advancement, medal threshold or official result."
  },
  "source_conflicts": [
    {
      "key": "ndca_student_student_youth",
      "description": "NDCA II.A.6.b limits Student/Student to adults, but II.B.8 describes youth Student/Student events. Youth Student/Student is not offered until this is reviewed.",
      "references": [
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.A.6.b",
          "page": "5"
        },
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.B.8",
          "page": "8"
        }
      ],
      "status": "unresolved",
      "material": true
    },
    {
      "key": "ndca_formation_scoring",
      "description": "NDCA III.D.11 allows a cumulative point system for Formation Teams and Team Matches, but XII.N.3 requires the Skating System. Studio / Custom Formation uses Studio placements.",
      "references": [
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "III.D.11",
          "page": "21"
        },
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "XII.N.3",
          "page": "52"
        }
      ],
      "status": "unresolved",
      "material": true
    }
  ],
  "programs": {
    "country": {
      "label": "Country",
      "description": "Country partner dancing.",
      "discipline_family": "country",
      "dance_pool": "country",
      "formats": [
        "pro_am",
        "pro_pro",
        "couples",
        "showcase",
        "spotlight",
        "solo",
        "team"
      ],
      "custom_dances": true,
      "offering_groups": [
        {
          "label": "Partnerships",
          "formats": [
            "pro_am",
            "pro_pro",
            "couples"
          ]
        },
        {
          "label": "Showcase and performances",
          "formats": [
            "showcase",
            "spotlight",
            "solo"
          ]
        },
        {
          "label": "Teams",
          "formats": [
            "team"
          ]
        }
      ],
      "judging_options": [
        "medal_marks"
      ],
      "programming": {
        "hierarchy": {
          "value": [
            "level",
            "age",
            "dance"
          ],
          "basis": "owner_operational",
          "note": "Country events usually complete a level together: each age group dances the sequence. Not stated in the supplied UCWDC rules."
        },
        "dance_sequence": {
          "value": [
            "triple_two",
            "nightclub",
            "waltz",
            "polka",
            "cha_cha",
            "east_coast_swing",
            "two_step",
            "west_coast_swing"
          ],
          "basis": "source_grounded",
          "sources": [
            {
              "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
              "edition": "2026 (v1-26-2026)",
              "section": "II.M.1.a-b",
              "page": "11",
              "quote": "These categories will be danced in this order at all UCWDC events"
            }
          ],
          "note": "Masters and Crown Classic dance two flights instead (II.M.1.b.i-ii)."
        },
        "special_boundary": {
          "value": "age",
          "basis": "owner_operational",
          "note": "Showcases and Spotlights run after an age group's dance sequence, before the next block."
        }
      },
      "division_schemes": {
        "pro_am": "country_proam",
        "pro_pro": "country_propro",
        "couples": "country_couples",
        "showcase": "country_routine",
        "spotlight": "country_routine",
        "solo": "country_routine",
        "team": "open_only"
      }
    },
    "west_coast_swing": {
      "label": "West Coast Swing",
      "description": "West Coast Swing contests.",
      "discipline_family": "west_coast_swing",
      "dance_pool": "west_coast_swing",
      "formats": [
        "jack_and_jill",
        "wcs_couples",
        "wcs_pro_am",
        "routine"
      ],
      "custom_dances": false,
      "offering_groups": [
        {
          "label": "WSDC Registry contest",
          "formats": [
            "jack_and_jill"
          ]
        },
        {
          "label": "Studio / Custom",
          "formats": [
            "wcs_couples",
            "wcs_pro_am",
            "routine"
          ]
        }
      ],
      "judging_options": [
        "placements"
      ],
      "programming": {
        "hierarchy": {
          "value": [
            "contest_format",
            "division",
            "round"
          ],
          "basis": "owner_operational",
          "note": "WCS events run by contest format, then division, then round."
        },
        "dance_sequence": {
          "value": [
            "west_coast_swing"
          ],
          "basis": "studio_recommendation"
        },
        "special_boundary": {
          "value": "contest_format",
          "basis": "owner_operational",
          "note": "Routines run as their own contest block."
        }
      },
      "division_schemes": {
        "jack_and_jill": "wcs_contests",
        "wcs_couples": "studio_wcs",
        "wcs_pro_am": "studio_wcs",
        "routine": "open_only"
      }
    },
    "ballroom": {
      "label": "Ballroom",
      "description": "Ballroom partner dancing.",
      "discipline_family": "ballroom",
      "dance_pool": "ballroom",
      "formats": [
        "ndca_pro_am",
        "ndca_pro_am_multi",
        "ndca_amateur",
        "ndca_amateur_multi",
        "ndca_mixed_amateur",
        "ndca_student_student",
        "ndca_professional",
        "ndca_mixed_professional",
        "ndca_solo_star",
        "ndca_showdance",
        "ndca_cabaret",
        "ndca_theatre_arts",
        "ndca_pro_am_theatrical",
        "ndca_pro_am_exhibition",
        "ndca_formation",
        "ndca_team_match"
      ],
      "custom_dances": true,
      "styles": [
        {
          "key": "international_standard",
          "label": "International Standard",
          "dances": [
            "std_waltz",
            "std_tango",
            "std_viennese_waltz",
            "std_slow_foxtrot",
            "std_quickstep"
          ],
          "allow_custom_dances": false,
          "basis": "source_grounded",
          "sources": [
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "IX.A.1.a",
              "page": "38-39"
            }
          ],
          "note": "NDCA: International Style Ballroom."
        },
        {
          "key": "international_latin",
          "label": "International Latin",
          "dances": [
            "latin_cha_cha",
            "latin_samba",
            "latin_rumba",
            "latin_paso_doble",
            "latin_jive"
          ],
          "allow_custom_dances": false,
          "basis": "source_grounded",
          "sources": [
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "IX.A.1.b",
              "page": "38-39"
            }
          ]
        },
        {
          "key": "american_smooth",
          "label": "American Smooth",
          "dances": [
            "smooth_waltz",
            "smooth_tango",
            "smooth_foxtrot",
            "smooth_viennese_waltz"
          ],
          "allow_custom_dances": false,
          "basis": "source_grounded",
          "sources": [
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "IX.A.1.c",
              "page": "38-39"
            }
          ]
        },
        {
          "key": "american_rhythm",
          "label": "American Rhythm",
          "dances": [
            "rhythm_cha_cha",
            "rhythm_rumba",
            "rhythm_swing",
            "rhythm_bolero",
            "rhythm_mambo"
          ],
          "allow_custom_dances": false,
          "basis": "source_grounded",
          "sources": [
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "IX.A.1.d",
              "page": "38-39"
            }
          ]
        },
        {
          "key": "american_additional",
          "label": "Additional American Style Dances",
          "dances": [
            "addl_bachata",
            "addl_cumbia",
            "addl_hustle",
            "addl_jitterbug",
            "addl_lindy_hop",
            "addl_merengue",
            "addl_night_club_two_step",
            "addl_paso_doble",
            "addl_peabody",
            "addl_polka",
            "addl_salsa",
            "addl_samba",
            "addl_west_coast_swing",
            "addl_argentine_tango",
            "addl_argentine_vals",
            "addl_milonga"
          ],
          "allow_custom_dances": true,
          "basis": "source_grounded",
          "sources": [
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "IX.A.1.e",
              "page": "39",
              "quote": "These dances could include but not be limited to"
            }
          ],
          "note": "NDCA lists these dances as examples, not a closed list, so you can add others. Country Western versions of these dances also count as American style (IX.A.1.e).",
          "presentation": {
            "label": "Nightclub / Specialty Dances",
            "basis": "owner_operational",
            "note": "Many events run these dances as a Nightclub or specialty session. NDCA refers to Pro/Am Night Club events and Night Club sessions (music timing, III.D.15) and to Nightclub tempi (IX.B.5.c), but Night Club is not an NDCA competition classification. This heading is DanceFlow presentation; offering or scheduling these dances is optional.",
            "sources": [
              {
                "document": "NDCA Rule Book",
                "edition": "June 2026 (compiled)",
                "section": "III.D.15",
                "page": "21",
                "quote": "For Pro/Am Night Club events the music may fade as early as the 50-second point"
              },
              {
                "document": "NDCA Rule Book",
                "edition": "June 2026 (compiled)",
                "section": "IX.B.5.c",
                "page": "41",
                "quote": "NIGHTCLUB"
              }
            ]
          }
        }
      ],
      "offering_groups": [
        {
          "label": "Partnerships",
          "formats": [
            "ndca_pro_am",
            "ndca_pro_am_multi",
            "ndca_amateur",
            "ndca_amateur_multi",
            "ndca_mixed_amateur",
            "ndca_student_student",
            "ndca_professional",
            "ndca_mixed_professional"
          ]
        },
        {
          "label": "Youth",
          "formats": [
            "ndca_solo_star"
          ]
        },
        {
          "label": "Performances",
          "formats": [
            "ndca_showdance",
            "ndca_cabaret",
            "ndca_theatre_arts",
            "ndca_pro_am_theatrical",
            "ndca_pro_am_exhibition"
          ]
        },
        {
          "label": "Teams",
          "formats": [
            "ndca_formation",
            "ndca_team_match"
          ]
        }
      ],
      "judging_options": [
        "placements"
      ],
      "programming": {
        "hierarchy": {
          "value": [
            "style",
            "level",
            "age",
            "event"
          ],
          "basis": "owner_operational",
          "note": "Ballroom events run by style block (e.g. American Rhythm), then level, then age. Not mandated by the supplied NDCA rules."
        },
        "dance_sequence": {
          "value": [
            "std_waltz",
            "std_tango",
            "std_viennese_waltz",
            "std_slow_foxtrot",
            "std_quickstep",
            "latin_cha_cha",
            "latin_samba",
            "latin_rumba",
            "latin_paso_doble",
            "latin_jive",
            "smooth_waltz",
            "smooth_tango",
            "smooth_foxtrot",
            "smooth_viennese_waltz",
            "rhythm_cha_cha",
            "rhythm_rumba",
            "rhythm_swing",
            "rhythm_bolero",
            "rhythm_mambo"
          ],
          "basis": "source_grounded",
          "sources": [
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "IX.A.1.a-d",
              "page": "38-39",
              "quote": "American Style Smooth. Waltz, Tango, Foxtrot, Viennese Waltz"
            }
          ],
          "note": "NDCA also recommends Pro/Am single dances finish one level's sequence before the next level (IX.A.1.h)."
        },
        "special_boundary": {
          "value": "style",
          "basis": "owner_operational",
          "note": "Showdance, Cabaret and Theatre Arts numbers run after a style block, before the next major block."
        }
      },
      "division_schemes": {
        "ndca_pro_am": "ballroom_proam",
        "ndca_pro_am_multi": "ballroom_proam_multi",
        "ndca_amateur": "ballroom_amateur",
        "ndca_amateur_multi": "ballroom_amateur_multi",
        "ndca_mixed_amateur": "open_only",
        "ndca_student_student": "ballroom_adult_open",
        "ndca_professional": "ballroom_professional",
        "ndca_mixed_professional": "open_only",
        "ndca_solo_star": "ballroom_solo_star",
        "ndca_showdance": "open_only",
        "ndca_cabaret": "open_only",
        "ndca_theatre_arts": "open_only",
        "ndca_pro_am_theatrical": "open_only",
        "ndca_pro_am_exhibition": "open_only",
        "ndca_formation": "open_only",
        "ndca_team_match": "open_only"
      }
    },
    "custom": {
      "label": "Other / Studio-defined",
      "description": "A style you define.",
      "discipline_family": "custom",
      "dance_pool": "general",
      "formats": [
        "studio_pro_am",
        "studio_pro_pro",
        "studio_couples",
        "studio_professional",
        "studio_jack_and_jill",
        "custom_routine",
        "studio_solo",
        "studio_team"
      ],
      "custom_dances": true,
      "offering_groups": [
        {
          "label": "Partnerships",
          "formats": [
            "studio_pro_am",
            "studio_pro_pro",
            "studio_couples",
            "studio_professional",
            "studio_jack_and_jill"
          ]
        },
        {
          "label": "Routines and teams",
          "formats": [
            "custom_routine",
            "studio_solo",
            "studio_team"
          ]
        }
      ],
      "judging_options": [
        "placements",
        "ratings"
      ],
      "programming": {
        "hierarchy": {
          "value": [
            "level",
            "age",
            "dance"
          ],
          "basis": "studio_recommendation"
        },
        "dance_sequence": {
          "value": [
            "waltz",
            "foxtrot",
            "tango",
            "viennese_waltz",
            "cha_cha",
            "rumba",
            "swing",
            "bolero",
            "mambo",
            "salsa",
            "hustle",
            "two_step"
          ],
          "basis": "studio_recommendation"
        },
        "special_boundary": {
          "value": "age",
          "basis": "studio_recommendation"
        }
      },
      "division_schemes": {
        "studio_pro_am": "studio_generic",
        "studio_pro_pro": "studio_generic",
        "studio_couples": "studio_generic",
        "studio_professional": "studio_generic",
        "studio_jack_and_jill": "studio_generic",
        "custom_routine": "open_only",
        "studio_solo": "open_only",
        "studio_team": "open_only"
      }
    }
  },
  "categoryTypes": {
    "pro_am": {
      "label": "ProAm",
      "description": "A student dances with a professional.",
      "contest_type": "single_dance",
      "entry_format": "pro_am",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "per_dance",
      "price_unit": "per dance",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "student",
        "professional"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_dance",
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_dance",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "ucwdc",
      "uses_styles": false,
      "sources": [
        {
          "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
          "edition": "2026 (v1-26-2026)",
          "section": "II.A.16",
          "page": "2"
        },
        {
          "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
          "edition": "2026 (v1-26-2026)",
          "section": "II.E.1",
          "page": "4"
        }
      ]
    },
    "pro_pro": {
      "label": "ProPro",
      "description": "A competing professional dances with an instructing professional.",
      "contest_type": "single_dance",
      "entry_format": "pro_pro",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "per_dance",
      "price_unit": "per dance",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "instructor",
        "professional"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_dance",
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_dance",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "ucwdc",
      "uses_styles": false,
      "sources": [
        {
          "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
          "edition": "2026 (v1-26-2026)",
          "section": "II.A.18",
          "page": "2"
        },
        {
          "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
          "edition": "2026 (v1-26-2026)",
          "section": "II.E.2",
          "page": "4"
        }
      ]
    },
    "couples": {
      "label": "Couples",
      "description": "Two dancers compete as a couple (UCWDC Couples dance type).",
      "contest_type": "single_dance",
      "entry_format": "couple",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "per_dance",
      "price_unit": "per dance",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "dancer"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_dance",
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_dance",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "ucwdc",
      "uses_styles": false,
      "sources": [
        {
          "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
          "edition": "2026 (v1-26-2026)",
          "section": "II.E",
          "page": "4"
        }
      ]
    },
    "showcase": {
      "label": "Showcase",
      "description": "Choreography to set music for each dance; how the dancers interpret that music is judged.",
      "contest_type": "custom",
      "entry_format": "custom",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "per_dance",
      "price_unit": "per dance",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "dancer",
        "student",
        "professional",
        "instructor"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_dance",
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_dance",
      "kind": "special",
      "music_source": {
        "value": "profile_defined",
        "basis": "source_grounded",
        "sources": [
          {
            "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
            "edition": "2026 (v1-26-2026)",
            "section": "II.G.2.a",
            "page": "6",
            "quote": "music which is pre-selected for each dance on a rotating schedule"
          },
          {
            "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
            "edition": "2026 (v1-26-2026)",
            "section": "II.G.2.a",
            "page": "7"
          }
        ],
        "note": "UCWDC publishes the set music; under Studio / Custom the organizer supplies it."
      },
      "floor_mode": {
        "value": "not_specified",
        "basis": "not_specified",
        "note": "NOT SPECIFIED IN PROVIDED SOURCE. Floor sharing is a Studio policy setting to configure later."
      },
      "program_placement": {
        "value": "block_boundary",
        "basis": "owner_operational",
        "note": "Special offerings run at the end of a program block, not between regular heats."
      },
      "adjudication_override": true,
      "origin": "ucwdc",
      "uses_styles": false,
      "sources": [
        {
          "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
          "edition": "2026 (v1-26-2026)",
          "section": "II.G.2.a",
          "page": "6",
          "quote": "Choreographic interpretation of the music is one of the most important factors being judged."
        }
      ]
    },
    "spotlight": {
      "label": "Spotlight",
      "description": "A choreographed dance or medley to music the competitors choose (ProAm and ProPro), 2½ to 4 minutes.",
      "contest_type": "spotlight",
      "entry_format": "custom",
      "uses_dances": false,
      "dance_selection_mode": "routine",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "student",
        "professional",
        "instructor"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_entry",
      "kind": "special",
      "music_source": {
        "value": "entry_selected",
        "basis": "source_grounded",
        "sources": [
          {
            "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
            "edition": "2026 (v1-26-2026)",
            "section": "II.A.20",
            "page": "3",
            "quote": "choreographed to music of the competitor's choice"
          },
          {
            "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
            "edition": "2026 (v1-26-2026)",
            "section": "II.K.8",
            "page": "10"
          }
        ]
      },
      "floor_mode": {
        "value": "not_specified",
        "basis": "not_specified",
        "note": "NOT SPECIFIED IN PROVIDED SOURCE. Floor sharing is a Studio policy setting to configure later."
      },
      "program_placement": {
        "value": "block_boundary",
        "basis": "owner_operational",
        "note": "Special offerings run at the end of a program block, not between regular heats."
      },
      "adjudication_override": true,
      "origin": "ucwdc",
      "uses_styles": false,
      "duration": {
        "value": {
          "min_seconds": 150,
          "max_seconds": 240
        },
        "basis": "source_grounded",
        "sources": [
          {
            "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
            "edition": "2026 (v1-26-2026)",
            "section": "II.K.4.d; II.M.1.h.i",
            "page": "9, 13",
            "quote": "Spotlight (ProAm & ProPro) 2½ to 4 minutes"
          }
        ]
      },
      "sources": [
        {
          "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
          "edition": "2026 (v1-26-2026)",
          "section": "II.M.1.h.i",
          "page": "13",
          "quote": "Solo Performances: Spotlight"
        }
      ]
    },
    "solo": {
      "label": "Solo routine (Studio)",
      "description": "Studio / Custom: one dancer performs a routine. Not a UCWDC offering — UCWDC Solo Medley is a couple's multi-dance Showcase routine.",
      "contest_type": "showdance",
      "entry_format": "solo",
      "uses_dances": false,
      "dance_selection_mode": "routine",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 1,
      "maximum_participants": 1,
      "pairing_mode": "individual",
      "participant_roles": [
        "dancer"
      ],
      "dance_roles": "none",
      "pricing_models": [
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_entry",
      "kind": "special",
      "music_source": {
        "value": "entry_selected",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "not_specified",
        "basis": "not_specified",
        "note": "NOT SPECIFIED IN PROVIDED SOURCE. Floor sharing is a Studio policy setting to configure later."
      },
      "program_placement": {
        "value": "block_boundary",
        "basis": "owner_operational",
        "note": "Special offerings run at the end of a program block, not between regular heats."
      },
      "adjudication_override": false,
      "origin": "studio",
      "uses_styles": false
    },
    "team": {
      "label": "Team",
      "description": "A group performs a routine together (UCWDC Teams).",
      "contest_type": "team",
      "entry_format": "team",
      "uses_dances": false,
      "dance_selection_mode": "routine",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 2,
      "maximum_participants": 100,
      "pairing_mode": "team",
      "participant_roles": [
        "team_member"
      ],
      "dance_roles": "none",
      "pricing_models": [
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_entry",
      "kind": "special",
      "music_source": {
        "value": "entry_selected",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "not_specified",
        "basis": "not_specified",
        "note": "NOT SPECIFIED IN PROVIDED SOURCE. Floor sharing is a Studio policy setting to configure later."
      },
      "program_placement": {
        "value": "block_boundary",
        "basis": "owner_operational",
        "note": "Special offerings run at the end of a program block, not between regular heats."
      },
      "adjudication_override": false,
      "origin": "ucwdc",
      "uses_styles": false,
      "sources": [
        {
          "document": "UCWDC Rules, Contest Procedures and Scoring Format — Teams",
          "edition": "2026 (v1-26-2026)",
          "section": "II.D.1",
          "page": "3",
          "quote": "There are no age requirements in Team Divisions."
        }
      ]
    },
    "jack_and_jill": {
      "label": "Jack & Jill",
      "description": "Dancers enter alone and are paired with a random partner (WSDC Registry contest).",
      "contest_type": "jack_and_jill",
      "entry_format": "random_partner",
      "uses_dances": true,
      "dance_selection_mode": "prescribed_set",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 1,
      "maximum_participants": 1,
      "pairing_mode": "random_final_pair",
      "participant_roles": [
        "dancer"
      ],
      "dance_roles": "single",
      "pricing_models": [
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_entry",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "wsdc",
      "uses_styles": false,
      "sources": [
        {
          "document": "WSDC Registry Event Rules",
          "edition": "Version 2026.1C",
          "section": "3.4.9",
          "page": "20",
          "quote": "WSDC Jack and Jill contests must use the WSDC-approved Callback system"
        }
      ]
    },
    "wcs_couples": {
      "label": "Couples (Studio)",
      "description": "Studio / Custom couple contest. WSDC defines no Couples contest.",
      "contest_type": "single_dance",
      "entry_format": "couple",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "per_dance",
      "price_unit": "per dance",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "dancer"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_dance",
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_dance",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "studio",
      "uses_styles": false
    },
    "wcs_pro_am": {
      "label": "Pro-Am (Studio)",
      "description": "Studio / Custom: a student dances with a professional. Not a WSDC Registry contest.",
      "contest_type": "single_dance",
      "entry_format": "pro_am",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "per_dance",
      "price_unit": "per dance",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "student",
        "professional"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_dance",
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_dance",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "studio",
      "uses_styles": false
    },
    "routine": {
      "label": "Routine / Showcase (Studio)",
      "description": "Studio / Custom: a choreographed couple's routine to music the dancers choose.",
      "contest_type": "showdance",
      "entry_format": "custom",
      "uses_dances": false,
      "dance_selection_mode": "routine",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "dancer",
        "student",
        "professional",
        "instructor"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_entry",
      "kind": "special",
      "music_source": {
        "value": "entry_selected",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "not_specified",
        "basis": "not_specified",
        "note": "NOT SPECIFIED IN PROVIDED SOURCE. Floor sharing is a Studio policy setting to configure later."
      },
      "program_placement": {
        "value": "block_boundary",
        "basis": "owner_operational",
        "note": "Special offerings run at the end of a program block, not between regular heats."
      },
      "adjudication_override": true,
      "origin": "studio",
      "uses_styles": false
    },
    "ndca_pro_am": {
      "label": "Pro/Am Single-Dance",
      "description": "A registered professional dances with their registered Pro/Am Student Competitor; each dance is its own event.",
      "contest_type": "single_dance",
      "entry_format": "pro_am",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "per_dance",
      "price_unit": "per dance",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "student",
        "professional"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_dance",
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_dance",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "ndca",
      "uses_styles": true,
      "event_form": "single_dance",
      "sources": [
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.A.4",
          "page": "4-5"
        },
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.B.7",
          "page": "7-8"
        },
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "III.A.3.b",
          "page": "9",
          "quote": "Pro/Am Single Dance Competitions, Pro/Am Multi-Dance Competitions"
        }
      ]
    },
    "ndca_pro_am_multi": {
      "label": "Pro/Am Multi-Dance",
      "description": "A registered professional and their Pro/Am Student Competitor dance one entry made of a prescribed set of one style's dances.",
      "contest_type": "multi_dance",
      "entry_format": "pro_am",
      "uses_dances": true,
      "dance_selection_mode": "prescribed_set",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "student",
        "professional"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_entry",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "ndca",
      "uses_styles": true,
      "style_keys": [
        "international_standard",
        "international_latin",
        "american_smooth",
        "american_rhythm"
      ],
      "event_form": "multi_dance",
      "min_dances": 2,
      "registration_hold": {
        "key": "multi_dance_results_not_operational",
        "note": "Multi-Dance registration cannot open yet: combined results and accumulated-mark recalls (NDCA III.D.44) are not computed by DanceFlow. The draft and its divisions are created; no official advancement or combined result is produced."
      },
      "future_requirements": [
        {
          "key": "ndca_multi_dance_recalls",
          "description": "Recalls for all rounds of a multi-dance event are based on the accumulated marks of all dances (not nine- or ten-dance events). Requires the scoring phase.",
          "sources": [
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "III.D.44",
              "page": "24"
            }
          ]
        },
        {
          "key": "ndca_multi_dance_result",
          "description": "The scrutineer computes the multi-dance result with the Skating System, then adjusts it for penalties. Requires the scoring phase and an authoritative Skating System specification.",
          "sources": [
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "III.D.11",
              "page": "21"
            },
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "III.C.3.b(1)(d)",
              "page": "17"
            }
          ]
        },
        {
          "key": "ndca_omit_dance_early_rounds",
          "description": "In five-dance events with four or more rounds the organizer may omit the Jive (International Latin) or the Swing (American Rhythm) in all rounds except the semifinal and final. Round-specific dance sets are not modelled; the full set is danced in every round.",
          "sources": [
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "IX.A.1.b(1); IX.A.1.d(1)",
              "page": "39"
            }
          ]
        },
        {
          "key": "ndca_ten_dance",
          "description": "Nine- and ten-dance events span styles; each dance is a separate competition and the Skating System is applied to all ten dances together. Not offered.",
          "sources": [
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "III.D.36",
              "page": "23"
            }
          ]
        },
        {
          "key": "ndca_closed_multi_dance_winner",
          "description": "The Pro/Am student winner of a Closed or Rising Star Multi-Dance event (including Closed Scholarships) of three dances or more with a semifinal may not enter the same Multi-Dance level, style and age category at that event in following years. Not enforced: DanceFlow has no cross-year results yet.",
          "sources": [
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "II.B.7.d",
              "page": "7"
            }
          ]
        },
        {
          "key": "ndca_pro_am_multi_dance_music",
          "description": "Contested Pro/Am Multi-Dance music runs 1:10 to 1:20 plus a fade (the Chairman may adjust for heats of four or fewer couples). Recorded for the music and floor phases.",
          "sources": [
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "III.D.14.b",
              "page": "21"
            }
          ]
        }
      ],
      "sources": [
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "III.A.3.b",
          "page": "9"
        },
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.B.7.f",
          "page": "7-8",
          "quote": "The age divisions for Pro/Am Student Competitor Multi-Dance Events shall be as listed below."
        }
      ]
    },
    "ndca_amateur": {
      "label": "Amateur Single-Dance",
      "description": "Two registered amateur dancers compete together; each dance is its own event.",
      "contest_type": "single_dance",
      "entry_format": "couple",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "per_dance",
      "price_unit": "per dance",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "dancer"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_dance",
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_dance",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "ndca",
      "uses_styles": true,
      "event_form": "single_dance",
      "eligibility_note": "Both partners must be eligible for the proficiency entered; a couple's age is the older partner's (Pre-Teen to Adult) or the younger partner's (Senior). Amateurs may enter at most two consecutive proficiency levels. Open Amateur is offered only as Multi-Dance (NDCA X.B.4).",
      "sources": [
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.A.2",
          "page": "4"
        },
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.B.6",
          "page": "7"
        },
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "X.A.6; X.C",
          "page": "42-43"
        }
      ]
    },
    "ndca_amateur_multi": {
      "label": "Amateur Multi-Dance",
      "description": "Two registered amateur dancers dance one entry made of a prescribed set of one style's dances.",
      "contest_type": "multi_dance",
      "entry_format": "couple",
      "uses_dances": true,
      "dance_selection_mode": "prescribed_set",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "dancer"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_entry",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "ndca",
      "uses_styles": true,
      "style_keys": [
        "international_standard",
        "international_latin",
        "american_smooth",
        "american_rhythm"
      ],
      "event_form": "multi_dance",
      "min_dances": 2,
      "registration_hold": {
        "key": "multi_dance_results_not_operational",
        "note": "Multi-Dance registration cannot open yet: combined results and accumulated-mark recalls (NDCA III.D.44) are not computed by DanceFlow. The draft and its divisions are created; no official advancement or combined result is produced."
      },
      "future_requirements": [
        {
          "key": "ndca_multi_dance_recalls",
          "description": "Recalls for all rounds of a multi-dance event are based on the accumulated marks of all dances (not nine- or ten-dance events). Requires the scoring phase.",
          "sources": [
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "III.D.44",
              "page": "24"
            }
          ]
        },
        {
          "key": "ndca_multi_dance_result",
          "description": "The scrutineer computes the multi-dance result with the Skating System, then adjusts it for penalties. Requires the scoring phase and an authoritative Skating System specification.",
          "sources": [
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "III.D.11",
              "page": "21"
            },
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "III.C.3.b(1)(d)",
              "page": "17"
            }
          ]
        },
        {
          "key": "ndca_omit_dance_early_rounds",
          "description": "In five-dance events with four or more rounds the organizer may omit the Jive (International Latin) or the Swing (American Rhythm) in all rounds except the semifinal and final. Round-specific dance sets are not modelled; the full set is danced in every round.",
          "sources": [
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "IX.A.1.b(1); IX.A.1.d(1)",
              "page": "39"
            }
          ]
        },
        {
          "key": "ndca_ten_dance",
          "description": "Nine- and ten-dance events span styles; each dance is a separate competition and the Skating System is applied to all ten dances together. Not offered.",
          "sources": [
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "III.D.36",
              "page": "23"
            }
          ]
        },
        {
          "key": "ndca_proficiency_dance_counts",
          "description": "NDCA recommends Novice be restricted to two dances per style and Pre-Championship to three or four. Shown as guidance only; recommendations are not enforced.",
          "sources": [
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "X.B.2-3",
              "page": "43"
            }
          ]
        }
      ],
      "eligibility_note": "Both partners must be eligible for the proficiency entered; a couple's age is the older partner's (Pre-Teen to Adult) or the younger partner's (Senior). Amateurs may enter at most two consecutive proficiency levels. Open Amateur must dance all of the style's dances, in order.",
      "sources": [
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.A.2",
          "page": "4"
        },
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "X.B",
          "page": "43"
        },
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "X.A.6; X.C",
          "page": "42-43"
        }
      ]
    },
    "ndca_mixed_amateur": {
      "label": "Mixed Amateur",
      "description": "An advanced amateur competitor/teacher dances with an amateur who is their student; both are registered amateurs.",
      "contest_type": "single_dance",
      "entry_format": "mixed_amateur",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "per_dance",
      "price_unit": "per dance",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "dancer"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_dance",
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_dance",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "ndca",
      "uses_styles": true,
      "sources": [
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.A.5",
          "page": "5"
        }
      ]
    },
    "ndca_student_student": {
      "label": "Student/Student",
      "description": "Two adult Pro/Am Student Competitors dance together, in heats danced with Pro/Am events.",
      "contest_type": "single_dance",
      "entry_format": "custom",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "per_dance",
      "price_unit": "per dance",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "student"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_dance",
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_dance",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "ndca",
      "uses_styles": true,
      "eligibility_note": "Adults only. Not open to dancers who compete at the Open Amateur proficiency level. Youth Student/Student is not offered while NDCA II.A.6.b and II.B.8 conflict.",
      "sources": [
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.A.6",
          "page": "5"
        }
      ]
    },
    "ndca_professional": {
      "label": "Professional",
      "description": "Two registered professionals (16 and older) compete as a couple.",
      "contest_type": "single_dance",
      "entry_format": "professional",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "per_dance",
      "price_unit": "per dance",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "professional"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_dance",
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_dance",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "ndca",
      "uses_styles": true,
      "eligibility_note": "Professionals 16 years of age and older. Rising Star status is lost as described in NDCA II.B.1.b(1).",
      "sources": [
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.B.1",
          "page": "6"
        }
      ]
    },
    "ndca_mixed_professional": {
      "label": "Mixed Professional",
      "description": "Professionals dance with other than their regular professional partner.",
      "contest_type": "single_dance",
      "entry_format": "professional",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "per_dance",
      "price_unit": "per dance",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "professional"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_dance",
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_dance",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "ndca",
      "uses_styles": true,
      "sources": [
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.B.2",
          "page": "6"
        }
      ]
    },
    "ndca_solo_star": {
      "label": "Solo Star",
      "description": "Pre-Teen, Junior or Youth amateurs dance syllabus routines singly in heats, without a partner.",
      "contest_type": "single_dance",
      "entry_format": "solo",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "per_dance",
      "price_unit": "per dance",
      "minimum_participants": 1,
      "maximum_participants": 1,
      "pairing_mode": "individual",
      "participant_roles": [
        "dancer"
      ],
      "dance_roles": "none",
      "pricing_models": [
        "per_dance",
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_dance",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "ndca",
      "uses_styles": true,
      "eligibility_note": "Pre-Teen, Junior and Youth amateurs only; never Adult or Senior.",
      "sources": [
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.A.3",
          "page": "4"
        },
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.B.10",
          "page": "8"
        }
      ]
    },
    "ndca_showdance": {
      "label": "Showdance",
      "description": "A choreographed show in one style, up to 4 minutes, using that style's regular dances.",
      "contest_type": "showdance",
      "entry_format": "custom",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "dancer",
        "student",
        "professional"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_entry",
      "kind": "special",
      "music_source": {
        "value": "entry_selected",
        "basis": "source_grounded",
        "sources": [
          {
            "document": "NDCA Rule Book",
            "edition": "June 2026 (compiled)",
            "section": "XI.B.4",
            "page": "47",
            "quote": "The invitation for a Show Dance Competition must advise the couples of possible sound carriers"
          }
        ],
        "note": "Couples supply their own music media."
      },
      "floor_mode": {
        "value": "not_specified",
        "basis": "not_specified",
        "note": "NOT SPECIFIED IN PROVIDED SOURCE. Floor sharing is a Studio policy setting to configure later."
      },
      "program_placement": {
        "value": "block_boundary",
        "basis": "owner_operational",
        "note": "Special offerings run at the end of a program block, not between regular heats."
      },
      "adjudication_override": true,
      "duration": {
        "value": {
          "min_seconds": 0,
          "max_seconds": 240
        },
        "basis": "source_grounded",
        "sources": [
          {
            "document": "NDCA Rule Book",
            "edition": "June 2026 (compiled)",
            "section": "XI.B.2",
            "page": "47",
            "quote": "The time of the show must be up to a maximum of 4 minutes."
          }
        ]
      },
      "origin": "ndca",
      "uses_styles": true,
      "style_keys": [
        "international_standard",
        "international_latin",
        "american_smooth",
        "american_rhythm"
      ],
      "eligibility_note": "NDCA XI.B rules apply when the organizer uses them instead of WDC or USDC showdance rules (III.D.27).",
      "sources": [
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.B.4(3)",
          "page": "6"
        },
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "XI.B.1",
          "page": "47"
        }
      ]
    },
    "ndca_cabaret": {
      "label": "Cabaret",
      "description": "A solo performance with aerial work and artistry, moving on and off the floor, in any genre, to the couple's own music.",
      "contest_type": "cabaret",
      "entry_format": "custom",
      "uses_dances": false,
      "dance_selection_mode": "routine",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "dancer",
        "student",
        "professional"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_entry",
      "kind": "special",
      "music_source": {
        "value": "entry_selected",
        "basis": "source_grounded",
        "sources": [
          {
            "document": "NDCA Rule Book",
            "edition": "June 2026 (compiled)",
            "section": "II.B.4(2)",
            "page": "6",
            "quote": "to their own selection of music"
          }
        ]
      },
      "floor_mode": {
        "value": "not_specified",
        "basis": "not_specified",
        "note": "NOT SPECIFIED IN PROVIDED SOURCE. Floor sharing is a Studio policy setting to configure later."
      },
      "program_placement": {
        "value": "block_boundary",
        "basis": "owner_operational",
        "note": "Special offerings run at the end of a program block, not between regular heats."
      },
      "adjudication_override": true,
      "origin": "ndca",
      "uses_styles": false,
      "sources": [
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.B.4(2)",
          "page": "6"
        }
      ]
    },
    "ndca_theatre_arts": {
      "label": "Theatre Arts Compulsory",
      "description": "All couples dance at the same time to the same preselected music; lifts on no more than 50% of the bars.",
      "contest_type": "custom",
      "entry_format": "custom",
      "uses_dances": false,
      "dance_selection_mode": "routine",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "dancer",
        "student",
        "professional"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_entry",
      "kind": "special",
      "music_source": {
        "value": "profile_defined",
        "basis": "source_grounded",
        "sources": [
          {
            "document": "NDCA Rule Book",
            "edition": "June 2026 (compiled)",
            "section": "II.B.4(1)",
            "page": "6",
            "quote": "All couples dance at the same time to the same preselected music"
          }
        ]
      },
      "floor_mode": {
        "value": "not_specified",
        "basis": "not_specified",
        "note": "NOT SPECIFIED IN PROVIDED SOURCE. Floor sharing is a Studio policy setting to configure later."
      },
      "program_placement": {
        "value": "block_boundary",
        "basis": "owner_operational",
        "note": "Special offerings run at the end of a program block, not between regular heats."
      },
      "adjudication_override": true,
      "origin": "ndca",
      "uses_styles": false,
      "sources": [
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.B.4(1)",
          "page": "6"
        },
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "IX.A.1.f",
          "page": "39"
        }
      ]
    },
    "ndca_pro_am_theatrical": {
      "label": "Pro/Am Theatrical",
      "description": "A Pro/Am Theatrical division (lifts allowed).",
      "contest_type": "custom",
      "entry_format": "pro_am",
      "uses_dances": false,
      "dance_selection_mode": "routine",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "student",
        "professional"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_entry",
      "kind": "special",
      "music_source": {
        "value": "not_specified",
        "basis": "not_specified",
        "note": "NOT SPECIFIED IN PROVIDED SOURCE. NDCA lists Theatrical as a Pro/Am division without defining its music."
      },
      "floor_mode": {
        "value": "not_specified",
        "basis": "not_specified",
        "note": "NOT SPECIFIED IN PROVIDED SOURCE. Floor sharing is a Studio policy setting to configure later."
      },
      "program_placement": {
        "value": "block_boundary",
        "basis": "owner_operational",
        "note": "Special offerings run at the end of a program block, not between regular heats."
      },
      "adjudication_override": true,
      "origin": "ndca",
      "uses_styles": false,
      "sources": [
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.B.7.c",
          "page": "7"
        },
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "IX.A.1.g(1)",
          "page": "39"
        }
      ]
    },
    "ndca_pro_am_exhibition": {
      "label": "Pro/Am Exhibition",
      "description": "A Pro/Am Exhibition division (lifts allowed; not required to dance all dances).",
      "contest_type": "exhibition",
      "entry_format": "pro_am",
      "uses_dances": false,
      "dance_selection_mode": "routine",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "student",
        "professional"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_entry",
      "kind": "special",
      "music_source": {
        "value": "not_specified",
        "basis": "not_specified",
        "note": "NOT SPECIFIED IN PROVIDED SOURCE. NDCA lists Exhibition as a Pro/Am division without defining its music."
      },
      "floor_mode": {
        "value": "not_specified",
        "basis": "not_specified",
        "note": "NOT SPECIFIED IN PROVIDED SOURCE. Floor sharing is a Studio policy setting to configure later."
      },
      "program_placement": {
        "value": "block_boundary",
        "basis": "owner_operational",
        "note": "Special offerings run at the end of a program block, not between regular heats."
      },
      "adjudication_override": true,
      "origin": "ndca",
      "uses_styles": false,
      "sources": [
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.B.7.c",
          "page": "7"
        },
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "IX.A.1",
          "page": "38"
        },
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "IX.A.1.g(1)",
          "page": "39"
        }
      ]
    },
    "ndca_formation": {
      "label": "Formation",
      "description": "A formation team of couples.",
      "contest_type": "formation",
      "entry_format": "team",
      "uses_dances": false,
      "dance_selection_mode": "routine",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 2,
      "maximum_participants": 100,
      "pairing_mode": "team",
      "participant_roles": [
        "team_member"
      ],
      "dance_roles": "none",
      "pricing_models": [
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_entry",
      "kind": "special",
      "music_source": {
        "value": "entry_selected",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "not_specified",
        "basis": "not_specified",
        "note": "NOT SPECIFIED IN PROVIDED SOURCE. Floor sharing is a Studio policy setting to configure later."
      },
      "program_placement": {
        "value": "block_boundary",
        "basis": "owner_operational",
        "note": "Special offerings run at the end of a program block, not between regular heats."
      },
      "adjudication_override": false,
      "origin": "ndca",
      "uses_styles": false,
      "sources": [
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.B.3; II.B.6.c",
          "page": "6-7"
        },
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "XII",
          "page": "48"
        }
      ]
    },
    "ndca_team_match": {
      "label": "Team Match",
      "description": "A team match between teams of couples.",
      "contest_type": "team",
      "entry_format": "team",
      "uses_dances": false,
      "dance_selection_mode": "routine",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 2,
      "maximum_participants": 100,
      "pairing_mode": "team",
      "participant_roles": [
        "team_member"
      ],
      "dance_roles": "none",
      "pricing_models": [
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_entry",
      "kind": "regular",
      "music_source": {
        "value": "entry_selected",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "not_specified",
        "basis": "not_specified",
        "note": "NOT SPECIFIED IN PROVIDED SOURCE. Floor sharing is a Studio policy setting to configure later."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "ndca",
      "uses_styles": false,
      "sources": [
        {
          "document": "NDCA Rule Book",
          "edition": "June 2026 (compiled)",
          "section": "II.B.5; II.B.6.d",
          "page": "6-7"
        }
      ]
    },
    "studio_pro_am": {
      "label": "ProAm (Studio)",
      "description": "A student dances with a professional.",
      "contest_type": "single_dance",
      "entry_format": "pro_am",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "per_dance",
      "price_unit": "per dance",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "student",
        "professional"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_dance",
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_dance",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "studio",
      "uses_styles": false
    },
    "studio_pro_pro": {
      "label": "ProPro (Studio)",
      "description": "A competing professional dances with an instructing professional.",
      "contest_type": "single_dance",
      "entry_format": "pro_pro",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "per_dance",
      "price_unit": "per dance",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "instructor",
        "professional"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_dance",
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_dance",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "studio",
      "uses_styles": false
    },
    "studio_couples": {
      "label": "Couples (Studio)",
      "description": "Two dancers compete as a couple.",
      "contest_type": "single_dance",
      "entry_format": "couple",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "per_dance",
      "price_unit": "per dance",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "dancer"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_dance",
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_dance",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "studio",
      "uses_styles": false
    },
    "studio_professional": {
      "label": "Professional (Studio)",
      "description": "Two professionals compete as a couple.",
      "contest_type": "single_dance",
      "entry_format": "professional",
      "uses_dances": true,
      "dance_selection_mode": "individual",
      "pricing_method": "per_dance",
      "price_unit": "per dance",
      "minimum_participants": 2,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "professional"
      ],
      "dance_roles": "pair",
      "pricing_models": [
        "per_dance",
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_dance",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "studio",
      "uses_styles": false
    },
    "studio_jack_and_jill": {
      "label": "Jack & Jill (Studio)",
      "description": "Studio / Custom: dancers enter alone and are paired with a random partner.",
      "contest_type": "jack_and_jill",
      "entry_format": "random_partner",
      "uses_dances": true,
      "dance_selection_mode": "prescribed_set",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 1,
      "maximum_participants": 1,
      "pairing_mode": "random_final_pair",
      "participant_roles": [
        "dancer"
      ],
      "dance_roles": "single",
      "pricing_models": [
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_entry",
      "kind": "regular",
      "music_source": {
        "value": "event_music",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "multi_entry",
        "basis": "studio_recommendation",
        "note": "Studio policy: regular heats share the floor."
      },
      "program_placement": {
        "value": "within_sequence",
        "basis": "studio_recommendation"
      },
      "adjudication_override": false,
      "origin": "studio",
      "uses_styles": false
    },
    "custom_routine": {
      "label": "Choreographed Routine",
      "description": "A routine you define, for studios whose terms differ from governing-body names.",
      "contest_type": "custom",
      "entry_format": "custom",
      "uses_dances": false,
      "dance_selection_mode": "routine",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 1,
      "maximum_participants": 2,
      "pairing_mode": "fixed",
      "participant_roles": [
        "dancer",
        "student",
        "professional",
        "instructor"
      ],
      "dance_roles": "optional",
      "pricing_models": [
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_entry",
      "kind": "special",
      "music_source": {
        "value": "entry_selected",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "not_specified",
        "basis": "not_specified",
        "note": "NOT SPECIFIED IN PROVIDED SOURCE. Floor sharing is a Studio policy setting to configure later."
      },
      "program_placement": {
        "value": "block_boundary",
        "basis": "owner_operational",
        "note": "Special offerings run at the end of a program block, not between regular heats."
      },
      "adjudication_override": true,
      "origin": "studio",
      "uses_styles": false,
      "organizer_configurable": [
        "label",
        "music_source",
        "duration",
        "adjudication",
        "floor_mode",
        "program_placement"
      ]
    },
    "studio_solo": {
      "label": "Solo (Studio)",
      "description": "One dancer performs a routine.",
      "contest_type": "showdance",
      "entry_format": "solo",
      "uses_dances": false,
      "dance_selection_mode": "routine",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 1,
      "maximum_participants": 1,
      "pairing_mode": "individual",
      "participant_roles": [
        "dancer"
      ],
      "dance_roles": "none",
      "pricing_models": [
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_entry",
      "kind": "special",
      "music_source": {
        "value": "entry_selected",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "not_specified",
        "basis": "not_specified",
        "note": "NOT SPECIFIED IN PROVIDED SOURCE. Floor sharing is a Studio policy setting to configure later."
      },
      "program_placement": {
        "value": "block_boundary",
        "basis": "owner_operational",
        "note": "Special offerings run at the end of a program block, not between regular heats."
      },
      "adjudication_override": false,
      "origin": "studio",
      "uses_styles": false
    },
    "studio_team": {
      "label": "Team (Studio)",
      "description": "A group performs a routine together.",
      "contest_type": "team",
      "entry_format": "team",
      "uses_dances": false,
      "dance_selection_mode": "routine",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 2,
      "maximum_participants": 100,
      "pairing_mode": "team",
      "participant_roles": [
        "team_member"
      ],
      "dance_roles": "none",
      "pricing_models": [
        "per_entry",
        "included",
        "free",
        "later"
      ],
      "default_pricing": "per_entry",
      "kind": "special",
      "music_source": {
        "value": "entry_selected",
        "basis": "studio_recommendation"
      },
      "floor_mode": {
        "value": "not_specified",
        "basis": "not_specified",
        "note": "NOT SPECIFIED IN PROVIDED SOURCE. Floor sharing is a Studio policy setting to configure later."
      },
      "program_placement": {
        "value": "block_boundary",
        "basis": "owner_operational",
        "note": "Special offerings run at the end of a program block, not between regular heats."
      },
      "adjudication_override": false,
      "origin": "studio",
      "uses_styles": false
    }
  },
  "dancePools": {
    "general": [
      {
        "key": "waltz",
        "name": "Waltz",
        "category": "Ballroom"
      },
      {
        "key": "foxtrot",
        "name": "Foxtrot",
        "category": "Ballroom"
      },
      {
        "key": "tango",
        "name": "Tango",
        "category": "Ballroom"
      },
      {
        "key": "viennese_waltz",
        "name": "Viennese Waltz",
        "category": "Ballroom"
      },
      {
        "key": "cha_cha",
        "name": "Cha Cha",
        "category": "Latin and Rhythm"
      },
      {
        "key": "rumba",
        "name": "Rumba",
        "category": "Latin and Rhythm"
      },
      {
        "key": "swing",
        "name": "Swing",
        "category": "Latin and Rhythm"
      },
      {
        "key": "bolero",
        "name": "Bolero",
        "category": "Latin and Rhythm"
      },
      {
        "key": "mambo",
        "name": "Mambo",
        "category": "Latin and Rhythm"
      },
      {
        "key": "salsa",
        "name": "Salsa",
        "category": "Social"
      },
      {
        "key": "hustle",
        "name": "Hustle",
        "category": "Social"
      },
      {
        "key": "two_step",
        "name": "Two Step",
        "category": "Social"
      }
    ],
    "ballroom": [
      {
        "key": "std_waltz",
        "name": "Waltz",
        "category": "International Standard"
      },
      {
        "key": "std_tango",
        "name": "Tango",
        "category": "International Standard"
      },
      {
        "key": "std_viennese_waltz",
        "name": "Viennese Waltz",
        "category": "International Standard"
      },
      {
        "key": "std_slow_foxtrot",
        "name": "Slow Foxtrot",
        "category": "International Standard"
      },
      {
        "key": "std_quickstep",
        "name": "Quickstep",
        "category": "International Standard"
      },
      {
        "key": "latin_cha_cha",
        "name": "Cha Cha",
        "category": "International Latin"
      },
      {
        "key": "latin_samba",
        "name": "Samba",
        "category": "International Latin"
      },
      {
        "key": "latin_rumba",
        "name": "Rumba",
        "category": "International Latin"
      },
      {
        "key": "latin_paso_doble",
        "name": "Paso Doble",
        "category": "International Latin"
      },
      {
        "key": "latin_jive",
        "name": "Jive",
        "category": "International Latin"
      },
      {
        "key": "smooth_waltz",
        "name": "Waltz",
        "category": "American Smooth"
      },
      {
        "key": "smooth_tango",
        "name": "Tango",
        "category": "American Smooth"
      },
      {
        "key": "smooth_foxtrot",
        "name": "Foxtrot",
        "category": "American Smooth"
      },
      {
        "key": "smooth_viennese_waltz",
        "name": "Viennese Waltz",
        "category": "American Smooth"
      },
      {
        "key": "rhythm_cha_cha",
        "name": "Cha Cha",
        "category": "American Rhythm"
      },
      {
        "key": "rhythm_rumba",
        "name": "Rumba",
        "category": "American Rhythm"
      },
      {
        "key": "rhythm_swing",
        "name": "Swing",
        "category": "American Rhythm"
      },
      {
        "key": "rhythm_bolero",
        "name": "Bolero",
        "category": "American Rhythm"
      },
      {
        "key": "rhythm_mambo",
        "name": "Mambo",
        "category": "American Rhythm"
      },
      {
        "key": "addl_bachata",
        "name": "Bachata",
        "category": "Additional American Style Dances"
      },
      {
        "key": "addl_cumbia",
        "name": "Cumbia",
        "category": "Additional American Style Dances"
      },
      {
        "key": "addl_hustle",
        "name": "Hustle",
        "category": "Additional American Style Dances"
      },
      {
        "key": "addl_jitterbug",
        "name": "Jitterbug",
        "category": "Additional American Style Dances"
      },
      {
        "key": "addl_lindy_hop",
        "name": "Lindy Hop",
        "category": "Additional American Style Dances"
      },
      {
        "key": "addl_merengue",
        "name": "Merengue",
        "category": "Additional American Style Dances"
      },
      {
        "key": "addl_night_club_two_step",
        "name": "Night Club Two-Step",
        "category": "Additional American Style Dances"
      },
      {
        "key": "addl_paso_doble",
        "name": "Paso Doble",
        "category": "Additional American Style Dances"
      },
      {
        "key": "addl_peabody",
        "name": "Peabody",
        "category": "Additional American Style Dances"
      },
      {
        "key": "addl_polka",
        "name": "Polka",
        "category": "Additional American Style Dances"
      },
      {
        "key": "addl_salsa",
        "name": "Salsa",
        "category": "Additional American Style Dances"
      },
      {
        "key": "addl_samba",
        "name": "Samba",
        "category": "Additional American Style Dances"
      },
      {
        "key": "addl_west_coast_swing",
        "name": "West Coast Swing",
        "category": "Additional American Style Dances"
      },
      {
        "key": "addl_argentine_tango",
        "name": "Argentine Tango",
        "category": "Additional American Style Dances"
      },
      {
        "key": "addl_argentine_vals",
        "name": "Argentine Vals",
        "category": "Additional American Style Dances"
      },
      {
        "key": "addl_milonga",
        "name": "Milonga",
        "category": "Additional American Style Dances"
      }
    ],
    "country": [
      {
        "key": "two_step",
        "name": "Two Step",
        "category": "Partner"
      },
      {
        "key": "waltz",
        "name": "Waltz",
        "category": "Partner"
      },
      {
        "key": "triple_two",
        "name": "Triple Two",
        "category": "Partner"
      },
      {
        "key": "polka",
        "name": "Polka",
        "category": "Partner"
      },
      {
        "key": "east_coast_swing",
        "name": "East Coast Swing",
        "category": "Partner"
      },
      {
        "key": "west_coast_swing",
        "name": "West Coast Swing",
        "category": "Partner"
      },
      {
        "key": "nightclub",
        "name": "Nightclub",
        "category": "Partner"
      },
      {
        "key": "cha_cha",
        "name": "Cha Cha",
        "category": "Partner"
      }
    ],
    "west_coast_swing": [
      {
        "key": "west_coast_swing",
        "name": "West Coast Swing",
        "category": "Swing"
      }
    ]
  },
  "divisionSchemes": {
    "country_proam": {
      "label": "Country ProAm",
      "combination": "cross",
      "note": "A division is a level in an age division, e.g. Novice · Diamond (UCWDC II.A.7).",
      "axes": [
        {
          "key": "skill_level",
          "label": "Levels",
          "values": [
            {
              "key": "newcomer",
              "label": "Newcomer",
              "basis": "studio_recommendation",
              "eligibility": {
                "note": "Studio / Custom single Newcomer level; UCWDC splits Newcomer into IV, III, II and I."
              }
            },
            {
              "key": "newcomer_iv",
              "label": "Newcomer IV",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.E.1",
                  "page": "4"
                }
              ]
            },
            {
              "key": "newcomer_iii",
              "label": "Newcomer III",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.E.1",
                  "page": "4"
                }
              ]
            },
            {
              "key": "newcomer_ii",
              "label": "Newcomer II",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.E.1",
                  "page": "4"
                }
              ]
            },
            {
              "key": "newcomer_i",
              "label": "Newcomer I",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.E.1",
                  "page": "4"
                }
              ]
            },
            {
              "key": "novice",
              "label": "Novice",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.E.1",
                  "page": "4"
                }
              ]
            },
            {
              "key": "intermediate",
              "label": "Intermediate",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.E.1",
                  "page": "4"
                }
              ]
            },
            {
              "key": "advanced",
              "label": "Advanced",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.E.1",
                  "page": "4"
                }
              ]
            },
            {
              "key": "allstars",
              "label": "AllStars",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.E.1",
                  "page": "4"
                }
              ],
              "eligibility": {
                "note": "Ascension division (earned)."
              }
            },
            {
              "key": "open",
              "label": "Open",
              "basis": "studio_recommendation",
              "name_label": "Open Level",
              "eligibility": {
                "note": "Studio / Custom open skill level. UCWDC uses Open only as an age division, not a ProAm skill level."
              }
            }
          ],
          "required": true,
          "allow_custom": true
        },
        {
          "key": "age_group",
          "label": "Age divisions",
          "values": [
            {
              "key": "junior_primary",
              "label": "Junior Primary",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "under_age": 10
              }
            },
            {
              "key": "junior_youth",
              "label": "Junior Youth",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 10,
                "under_age": 14
              }
            },
            {
              "key": "junior_teen",
              "label": "Junior Teen",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 14,
                "under_age": 18
              }
            },
            {
              "key": "open",
              "label": "Open",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 18,
                "note": "Open age division competitors must be Adults."
              }
            },
            {
              "key": "crystal",
              "label": "Crystal",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 30
              }
            },
            {
              "key": "diamond",
              "label": "Diamond",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 40
              }
            },
            {
              "key": "silver",
              "label": "Silver",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 50
              }
            },
            {
              "key": "gold",
              "label": "Gold",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 60
              }
            },
            {
              "key": "platinum",
              "label": "Platinum",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 70
              }
            },
            {
              "key": "pearl",
              "label": "Pearl",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 80
              }
            }
          ],
          "required": true,
          "allow_custom": true,
          "note": "Age on the last day of the dance season (UCWDC). Pick every age division you will offer."
        }
      ]
    },
    "country_propro": {
      "label": "Country ProPro",
      "combination": "cross",
      "note": "ProPro has its own levels (II.E.2) and the shared ProPro/ProAm age divisions (II.D), e.g. ProPro I · Crystal.",
      "axes": [
        {
          "key": "skill_level",
          "label": "Levels",
          "values": [
            {
              "key": "propro_ii",
              "label": "ProPro II",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.E.2",
                  "page": "4"
                }
              ]
            },
            {
              "key": "propro_i",
              "label": "ProPro I",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.E.2",
                  "page": "4"
                }
              ]
            },
            {
              "key": "open",
              "label": "Open",
              "basis": "studio_recommendation",
              "name_label": "Open Level",
              "eligibility": {
                "note": "Studio / Custom open skill level. UCWDC uses Open only as an age division, not a ProAm skill level."
              }
            }
          ],
          "required": true,
          "allow_custom": true
        },
        {
          "key": "age_group",
          "label": "Age divisions",
          "values": [
            {
              "key": "junior_primary",
              "label": "Junior Primary",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "under_age": 10
              }
            },
            {
              "key": "junior_youth",
              "label": "Junior Youth",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 10,
                "under_age": 14
              }
            },
            {
              "key": "junior_teen",
              "label": "Junior Teen",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 14,
                "under_age": 18
              }
            },
            {
              "key": "open",
              "label": "Open",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 18,
                "note": "Open age division competitors must be Adults."
              }
            },
            {
              "key": "crystal",
              "label": "Crystal",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 30
              }
            },
            {
              "key": "diamond",
              "label": "Diamond",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 40
              }
            },
            {
              "key": "silver",
              "label": "Silver",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 50
              }
            },
            {
              "key": "gold",
              "label": "Gold",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 60
              }
            },
            {
              "key": "platinum",
              "label": "Platinum",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 70
              }
            },
            {
              "key": "pearl",
              "label": "Pearl",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 80
              }
            }
          ],
          "required": true,
          "allow_custom": true,
          "note": "Age on the last day of the dance season (UCWDC). Pick every age division you will offer."
        }
      ]
    },
    "country_couples": {
      "label": "Country Couples",
      "combination": "cross",
      "note": "Couples use their own ladder and age list (no Pearl). Junior couples dance in the older partner's age group.",
      "axes": [
        {
          "key": "skill_level",
          "label": "Levels",
          "values": [
            {
              "key": "newcomer",
              "label": "Newcomer",
              "basis": "studio_recommendation",
              "eligibility": {
                "note": "Studio / Custom single Newcomer level; UCWDC splits Newcomer into IV, III, II and I."
              }
            },
            {
              "key": "newcomer_iv",
              "label": "Newcomer IV",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.E",
                  "page": "4"
                }
              ]
            },
            {
              "key": "newcomer_iii",
              "label": "Newcomer III",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.E",
                  "page": "4"
                }
              ]
            },
            {
              "key": "newcomer_ii",
              "label": "Newcomer II",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.E",
                  "page": "4"
                }
              ]
            },
            {
              "key": "newcomer_i",
              "label": "Newcomer I",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.E",
                  "page": "4"
                }
              ]
            },
            {
              "key": "novice",
              "label": "Novice",
              "basis": "studio_recommendation"
            },
            {
              "key": "intermediate",
              "label": "Intermediate",
              "basis": "studio_recommendation"
            },
            {
              "key": "advanced",
              "label": "Advanced",
              "basis": "studio_recommendation"
            },
            {
              "key": "classic_iii",
              "label": "Classic III",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.E",
                  "page": "4"
                }
              ]
            },
            {
              "key": "classic_ii",
              "label": "Classic II",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.E",
                  "page": "4"
                }
              ]
            },
            {
              "key": "classic_ii_i",
              "label": "Classic II/I",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.E",
                  "page": "4"
                }
              ]
            },
            {
              "key": "classic_i",
              "label": "Classic I",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.E",
                  "page": "4"
                }
              ]
            },
            {
              "key": "open",
              "label": "Open",
              "basis": "studio_recommendation",
              "name_label": "Open Level",
              "eligibility": {
                "note": "Studio / Custom open skill level. UCWDC uses Open only as an age division, not a ProAm skill level."
              }
            }
          ],
          "required": true,
          "allow_custom": true,
          "note": "Novice, Intermediate and Advanced are Studio levels; Newcomer IV–I and Classic III–I are the UCWDC Couples ladder."
        },
        {
          "key": "age_group",
          "label": "Age divisions",
          "values": [
            {
              "key": "junior_primary",
              "label": "Junior Primary",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3"
                }
              ],
              "eligibility": {
                "under_age": 10,
                "note": "Older partner's age."
              }
            },
            {
              "key": "junior_youth",
              "label": "Junior Youth",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3"
                }
              ],
              "eligibility": {
                "min_age": 10,
                "under_age": 14,
                "note": "Older partner's age."
              }
            },
            {
              "key": "junior_teen",
              "label": "Junior Teen",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3"
                }
              ],
              "eligibility": {
                "min_age": 14,
                "under_age": 18,
                "note": "Older partner's age."
              }
            },
            {
              "key": "open",
              "label": "Open",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3"
                }
              ],
              "eligibility": {
                "min_age": 18,
                "note": "Adults; an Adult may dance with a partner who is 16 or older."
              }
            },
            {
              "key": "crystal",
              "label": "Crystal",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3"
                }
              ],
              "eligibility": {
                "min_age": 30
              }
            },
            {
              "key": "diamond",
              "label": "Diamond",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3"
                }
              ],
              "eligibility": {
                "min_age": 40
              }
            },
            {
              "key": "silver",
              "label": "Silver",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3"
                }
              ],
              "eligibility": {
                "min_age": 50
              }
            },
            {
              "key": "gold",
              "label": "Gold",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3"
                }
              ],
              "eligibility": {
                "min_age": 60
              }
            },
            {
              "key": "platinum",
              "label": "Platinum",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3"
                }
              ],
              "eligibility": {
                "min_age": 70
              }
            },
            {
              "key": "masters",
              "label": "Masters",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3"
                }
              ],
              "eligibility": {
                "min_age": 18,
                "note": "Adults. Ascension division: competitors must earn ascension (UCWDC Couples II.E.3)."
              }
            },
            {
              "key": "masters_plus",
              "label": "Masters Plus",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3"
                }
              ],
              "eligibility": {
                "min_age": 45,
                "note": "Ascension division: competitors must earn ascension (UCWDC Couples II.E.3)."
              }
            },
            {
              "key": "crown",
              "label": "Crown",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3"
                }
              ],
              "eligibility": {
                "min_age": 40,
                "note": "Ascension division: competitors must earn ascension (UCWDC Couples II.E.3)."
              }
            },
            {
              "key": "crown_plus",
              "label": "Crown Plus",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — Couples",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3"
                }
              ],
              "eligibility": {
                "min_age": 55,
                "note": "Ascension division: competitors must earn ascension (UCWDC Couples II.E.3)."
              }
            }
          ],
          "required": true,
          "allow_custom": true,
          "note": "Age on the last day of the dance season (UCWDC). Pick every age division you will offer."
        }
      ]
    },
    "country_routine": {
      "label": "Country routine",
      "combination": "cross",
      "note": "Showcase / Spotlight / routine offerings by age division.",
      "axes": [
        {
          "key": "age_group",
          "label": "Age divisions",
          "values": [
            {
              "key": "junior_primary",
              "label": "Junior Primary",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "under_age": 10
              }
            },
            {
              "key": "junior_youth",
              "label": "Junior Youth",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 10,
                "under_age": 14
              }
            },
            {
              "key": "junior_teen",
              "label": "Junior Teen",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 14,
                "under_age": 18
              }
            },
            {
              "key": "open",
              "label": "Open",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 18,
                "note": "Open age division competitors must be Adults."
              }
            },
            {
              "key": "crystal",
              "label": "Crystal",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 30
              }
            },
            {
              "key": "diamond",
              "label": "Diamond",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 40
              }
            },
            {
              "key": "silver",
              "label": "Silver",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 50
              }
            },
            {
              "key": "gold",
              "label": "Gold",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 60
              }
            },
            {
              "key": "platinum",
              "label": "Platinum",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 70
              }
            },
            {
              "key": "pearl",
              "label": "Pearl",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "UCWDC Rules, Contest Procedures and Scoring Format — ProPro/ProAm",
                  "edition": "2026 (v1-26-2026)",
                  "section": "II.D",
                  "page": "3-4"
                }
              ],
              "eligibility": {
                "min_age": 80
              }
            }
          ],
          "required": true,
          "allow_custom": true,
          "note": "Age on the last day of the dance season (UCWDC). Pick every age division you will offer."
        }
      ]
    },
    "wcs_contests": {
      "label": "West Coast Swing contests",
      "combination": "separate",
      "note": "Skill-level contests and age-based contests are separate contests. Age contests are open to every skill level (WSDC 3.1.3.a); they are not age splits of each level.",
      "axes": [
        {
          "key": "skill_level",
          "label": "Skill levels",
          "values": [
            {
              "key": "newcomer",
              "label": "Newcomer",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "WSDC Registry Event Rules",
                  "edition": "Version 2026.1C",
                  "section": "Purpose/Definitions",
                  "page": "1"
                }
              ]
            },
            {
              "key": "novice",
              "label": "Novice",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "WSDC Registry Event Rules",
                  "edition": "Version 2026.1C",
                  "section": "Purpose/Definitions",
                  "page": "1"
                }
              ]
            },
            {
              "key": "intermediate",
              "label": "Intermediate",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "WSDC Registry Event Rules",
                  "edition": "Version 2026.1C",
                  "section": "Purpose/Definitions",
                  "page": "1"
                }
              ]
            },
            {
              "key": "advanced",
              "label": "Advanced",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "WSDC Registry Event Rules",
                  "edition": "Version 2026.1C",
                  "section": "Purpose/Definitions",
                  "page": "1"
                }
              ]
            },
            {
              "key": "all_star",
              "label": "All Star",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "WSDC Registry Event Rules",
                  "edition": "Version 2026.1C",
                  "section": "Purpose/Definitions",
                  "page": "1"
                }
              ]
            },
            {
              "key": "champion",
              "label": "Champion",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "WSDC Registry Event Rules",
                  "edition": "Version 2026.1C",
                  "section": "Purpose/Definitions",
                  "page": "1"
                }
              ]
            }
          ],
          "required": false,
          "allow_custom": true
        },
        {
          "key": "age_group",
          "label": "Age-based contests",
          "values": [
            {
              "key": "juniors",
              "label": "Juniors",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "WSDC Registry Event Rules",
                  "edition": "Version 2026.1C",
                  "section": "Definitions; 3.1.3.a",
                  "page": "3, 10"
                }
              ],
              "eligibility": {
                "under_age": 18
              }
            },
            {
              "key": "sophisticated",
              "label": "Sophisticated",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "WSDC Registry Event Rules",
                  "edition": "Version 2026.1C",
                  "section": "Definitions; 3.1.3.a",
                  "page": "3, 10"
                }
              ],
              "eligibility": {
                "min_age": 35
              }
            },
            {
              "key": "masters",
              "label": "Masters",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "WSDC Registry Event Rules",
                  "edition": "Version 2026.1C",
                  "section": "Definitions; 3.1.3.a",
                  "page": "3, 10"
                }
              ],
              "eligibility": {
                "min_age": 50
              }
            }
          ],
          "required": false,
          "allow_custom": true,
          "note": "Optional age-based contests, open to all skill levels."
        }
      ]
    },
    "ballroom_proam": {
      "label": "NDCA Pro/Am Single-Dance",
      "combination": "cross",
      "note": "NDCA lets organizers offer any or all Pro/Am levels (II.B.7.c). Youth Pro/Am uses the amateur ages (II.B.8.a). Adult age categories for Single-Dance events are NOT SPECIFIED IN PROVIDED SOURCE: A–S4 are the Multi-Dance categories (II.B.7.f).",
      "axes": [
        {
          "key": "skill_level",
          "label": "Levels",
          "values": [
            {
              "key": "newcomer",
              "label": "Newcomer",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ],
              "eligibility": {
                "note": "First year of competition; closed syllabus only (II.B.7.c(1)–(2))."
              }
            },
            {
              "key": "beginner",
              "label": "Beginner",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ]
            },
            {
              "key": "intermediate",
              "label": "Intermediate",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ]
            },
            {
              "key": "advanced",
              "label": "Advanced",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ]
            },
            {
              "key": "pre_bronze",
              "label": "Pre-Bronze",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ]
            },
            {
              "key": "bronze",
              "label": "Bronze",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ]
            },
            {
              "key": "silver",
              "label": "Silver",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ]
            },
            {
              "key": "gold",
              "label": "Gold",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ]
            },
            {
              "key": "gold_star",
              "label": "Gold Star",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ]
            },
            {
              "key": "supreme_gold",
              "label": "Supreme Gold",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ]
            }
          ],
          "required": true,
          "allow_custom": true
        },
        {
          "key": "age_group",
          "label": "Age divisions",
          "values": [
            {
              "key": "pre_teen_i",
              "label": "Pre-Teen I",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.8.a",
                  "page": "8"
                },
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "under_age": 10
              }
            },
            {
              "key": "pre_teen_ii",
              "label": "Pre-Teen II",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.8.a",
                  "page": "8"
                },
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 10,
                "under_age": 12
              }
            },
            {
              "key": "junior_i",
              "label": "Junior I",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.8.a",
                  "page": "8"
                },
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 12,
                "under_age": 14
              }
            },
            {
              "key": "junior_ii",
              "label": "Junior II",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.8.a",
                  "page": "8"
                },
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 14,
                "under_age": 16
              }
            },
            {
              "key": "youth",
              "label": "Youth",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.8.a",
                  "page": "8"
                },
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 16,
                "under_age": 19
              }
            }
          ],
          "required": false,
          "allow_custom": true,
          "note": "Optional. Youth ages follow the amateur rules (II.B.8.a). Adult Single-Dance age categories are not specified by NDCA; add your own (Studio / Custom) if you split adults."
        }
      ]
    },
    "ballroom_amateur": {
      "label": "NDCA Amateur Single-Dance",
      "combination": "cross",
      "note": "A division is a proficiency level in an age category, e.g. Silver · Adult (NDCA X). Open Amateur is not offered as Single-Dance: all of a style's dances must be danced in that category (X.B.4).",
      "axes": [
        {
          "key": "skill_level",
          "label": "Proficiency levels",
          "values": [
            {
              "key": "bronze",
              "label": "Bronze",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.B",
                  "page": "43"
                }
              ],
              "eligibility": {
                "note": "Syllabus."
              }
            },
            {
              "key": "silver",
              "label": "Silver",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.B",
                  "page": "43"
                }
              ],
              "eligibility": {
                "note": "Syllabus."
              }
            },
            {
              "key": "gold",
              "label": "Gold",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.B",
                  "page": "43"
                }
              ],
              "eligibility": {
                "note": "Syllabus."
              }
            },
            {
              "key": "novice",
              "label": "Novice",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.B",
                  "page": "43"
                }
              ],
              "eligibility": {
                "note": "Open syllabus; NDCA recommends two dances per style (X.B.2)."
              }
            },
            {
              "key": "pre_championship",
              "label": "Pre-Championship",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.B",
                  "page": "43"
                }
              ],
              "eligibility": {
                "note": "Open syllabus; NDCA recommends three or four dances per style (X.B.3)."
              }
            }
          ],
          "required": true,
          "allow_custom": true,
          "note": "Amateurs may enter at most two consecutive proficiency levels (X.C.9)."
        },
        {
          "key": "age_group",
          "label": "Age divisions",
          "values": [
            {
              "key": "pre_teen_i",
              "label": "Pre-Teen I",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "under_age": 10
              }
            },
            {
              "key": "pre_teen_ii",
              "label": "Pre-Teen II",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 10,
                "under_age": 12
              }
            },
            {
              "key": "junior_i",
              "label": "Junior I",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 12,
                "under_age": 14
              }
            },
            {
              "key": "junior_ii",
              "label": "Junior II",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 14,
                "under_age": 16
              }
            },
            {
              "key": "youth",
              "label": "Youth",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 16,
                "under_age": 19
              }
            },
            {
              "key": "adult",
              "label": "Adult",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 19
              }
            },
            {
              "key": "senior_i",
              "label": "Senior I",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 35,
                "note": "One partner 35+, the other 30+."
              }
            },
            {
              "key": "senior_ii",
              "label": "Senior II",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 45,
                "note": "One partner 45+, the other 40+."
              }
            },
            {
              "key": "senior_iii",
              "label": "Senior III",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 55,
                "note": "One partner 55+, the other 50+."
              }
            },
            {
              "key": "senior_iv",
              "label": "Senior IV",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 65,
                "note": "One partner 65+, the other 60+."
              }
            },
            {
              "key": "pre_teen",
              "label": "Pre-Teen",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.2",
                  "page": "42"
                }
              ],
              "eligibility": {
                "note": "Organizer combination of Pre-Teen I and II."
              }
            },
            {
              "key": "junior",
              "label": "Junior",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.2",
                  "page": "42"
                }
              ],
              "eligibility": {
                "note": "Organizer combination of Junior I and II."
              }
            },
            {
              "key": "senior",
              "label": "Senior",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.2",
                  "page": "42"
                }
              ],
              "eligibility": {
                "note": "Organizer combination of Senior categories."
              }
            },
            {
              "key": "under_21",
              "label": "Under 21",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.3",
                  "page": "42"
                }
              ],
              "eligibility": {
                "note": "Organizer add-on: at least one partner 16+, neither 21."
              }
            }
          ],
          "required": true,
          "allow_custom": true,
          "note": "A couple's age is the older partner's (Pre-Teen to Adult) or the younger partner's (Senior) (X.A.6)."
        }
      ]
    },
    "ballroom_proam_multi": {
      "label": "NDCA Pro/Am Multi-Dance",
      "combination": "cross",
      "note": "A division is a level in a Multi-Dance age category, e.g. Silver · B (II.B.7.c, II.B.7.f).",
      "axes": [
        {
          "key": "skill_level",
          "label": "Levels",
          "values": [
            {
              "key": "newcomer",
              "label": "Newcomer",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ],
              "eligibility": {
                "note": "First year of competition; closed syllabus only (II.B.7.c(1)–(2))."
              }
            },
            {
              "key": "beginner",
              "label": "Beginner",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ]
            },
            {
              "key": "intermediate",
              "label": "Intermediate",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ]
            },
            {
              "key": "advanced",
              "label": "Advanced",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ]
            },
            {
              "key": "pre_bronze",
              "label": "Pre-Bronze",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ]
            },
            {
              "key": "bronze",
              "label": "Bronze",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ]
            },
            {
              "key": "silver",
              "label": "Silver",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ]
            },
            {
              "key": "gold",
              "label": "Gold",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ]
            },
            {
              "key": "gold_star",
              "label": "Gold Star",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ]
            },
            {
              "key": "supreme_gold",
              "label": "Supreme Gold",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.c",
                  "page": "7"
                }
              ]
            }
          ],
          "required": true,
          "allow_custom": true
        },
        {
          "key": "age_group",
          "label": "Multi-Dance age categories",
          "values": [
            {
              "key": "pre_teen_i",
              "label": "Pre-Teen I",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.8.a",
                  "page": "8"
                },
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "under_age": 10
              }
            },
            {
              "key": "pre_teen_ii",
              "label": "Pre-Teen II",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.8.a",
                  "page": "8"
                },
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 10,
                "under_age": 12
              }
            },
            {
              "key": "junior_i",
              "label": "Junior I",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.8.a",
                  "page": "8"
                },
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 12,
                "under_age": 14
              }
            },
            {
              "key": "junior_ii",
              "label": "Junior II",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.8.a",
                  "page": "8"
                },
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 14,
                "under_age": 16
              }
            },
            {
              "key": "youth",
              "label": "Youth",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.8.a",
                  "page": "8"
                },
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 16,
                "under_age": 19
              }
            },
            {
              "key": "a",
              "label": "A",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.f",
                  "page": "7-8"
                }
              ],
              "eligibility": {
                "min_age": 19
              }
            },
            {
              "key": "b",
              "label": "B",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.f",
                  "page": "7-8"
                }
              ],
              "eligibility": {
                "min_age": 36
              }
            },
            {
              "key": "c",
              "label": "C",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.f",
                  "page": "7-8"
                }
              ],
              "eligibility": {
                "min_age": 51
              }
            },
            {
              "key": "s1",
              "label": "S1",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.f",
                  "page": "7-8"
                }
              ],
              "eligibility": {
                "min_age": 61
              }
            },
            {
              "key": "s2",
              "label": "S2",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.f",
                  "page": "7-8"
                }
              ],
              "eligibility": {
                "min_age": 71
              }
            },
            {
              "key": "s3",
              "label": "S3",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.f",
                  "page": "7-8"
                }
              ],
              "eligibility": {
                "min_age": 76
              }
            },
            {
              "key": "s4",
              "label": "S4",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.7.f",
                  "page": "7-8"
                }
              ],
              "eligibility": {
                "min_age": 81
              }
            }
          ],
          "required": true,
          "allow_custom": true,
          "note": "A–S4 are the NDCA Pro/Am Multi-Dance age categories (II.B.7.f); youth Pro/Am uses the amateur ages (II.B.8.a)."
        }
      ]
    },
    "ballroom_amateur_multi": {
      "label": "NDCA Amateur Multi-Dance",
      "combination": "cross",
      "note": "A division is a proficiency level in an age category (NDCA X). An Open Amateur division dances all of the style's dances, in order (X.B.4).",
      "axes": [
        {
          "key": "skill_level",
          "label": "Proficiency levels",
          "values": [
            {
              "key": "bronze",
              "label": "Bronze",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.B",
                  "page": "43"
                }
              ],
              "eligibility": {
                "note": "Syllabus."
              }
            },
            {
              "key": "silver",
              "label": "Silver",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.B",
                  "page": "43"
                }
              ],
              "eligibility": {
                "note": "Syllabus."
              }
            },
            {
              "key": "gold",
              "label": "Gold",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.B",
                  "page": "43"
                }
              ],
              "eligibility": {
                "note": "Syllabus."
              }
            },
            {
              "key": "novice",
              "label": "Novice",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.B",
                  "page": "43"
                }
              ],
              "eligibility": {
                "note": "Open syllabus; NDCA recommends two dances per style (X.B.2)."
              }
            },
            {
              "key": "pre_championship",
              "label": "Pre-Championship",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.B",
                  "page": "43"
                }
              ],
              "eligibility": {
                "note": "Open syllabus; NDCA recommends three or four dances per style (X.B.3)."
              }
            },
            {
              "key": "open_amateur",
              "label": "Open Amateur",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.B",
                  "page": "43"
                }
              ],
              "requires_all_style_dances": true,
              "eligibility": {
                "note": "All of the style's dances, in all rounds, in the order prescribed (X.B.4)."
              }
            }
          ],
          "required": true,
          "allow_custom": true,
          "note": "Amateurs may enter at most two consecutive proficiency levels (X.C.9)."
        },
        {
          "key": "age_group",
          "label": "Age divisions",
          "values": [
            {
              "key": "pre_teen_i",
              "label": "Pre-Teen I",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "under_age": 10
              }
            },
            {
              "key": "pre_teen_ii",
              "label": "Pre-Teen II",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 10,
                "under_age": 12
              }
            },
            {
              "key": "junior_i",
              "label": "Junior I",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 12,
                "under_age": 14
              }
            },
            {
              "key": "junior_ii",
              "label": "Junior II",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 14,
                "under_age": 16
              }
            },
            {
              "key": "youth",
              "label": "Youth",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 16,
                "under_age": 19
              }
            },
            {
              "key": "adult",
              "label": "Adult",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 19
              }
            },
            {
              "key": "senior_i",
              "label": "Senior I",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 35,
                "note": "One partner 35+, the other 30+."
              }
            },
            {
              "key": "senior_ii",
              "label": "Senior II",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 45,
                "note": "One partner 45+, the other 40+."
              }
            },
            {
              "key": "senior_iii",
              "label": "Senior III",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 55,
                "note": "One partner 55+, the other 50+."
              }
            },
            {
              "key": "senior_iv",
              "label": "Senior IV",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 65,
                "note": "One partner 65+, the other 60+."
              }
            },
            {
              "key": "pre_teen",
              "label": "Pre-Teen",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.2",
                  "page": "42"
                }
              ],
              "eligibility": {
                "note": "Organizer combination of Pre-Teen I and II."
              }
            },
            {
              "key": "junior",
              "label": "Junior",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.2",
                  "page": "42"
                }
              ],
              "eligibility": {
                "note": "Organizer combination of Junior I and II."
              }
            },
            {
              "key": "senior",
              "label": "Senior",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.2",
                  "page": "42"
                }
              ],
              "eligibility": {
                "note": "Organizer combination of Senior categories."
              }
            },
            {
              "key": "under_21",
              "label": "Under 21",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.3",
                  "page": "42"
                }
              ],
              "eligibility": {
                "note": "Organizer add-on: at least one partner 16+, neither 21."
              }
            }
          ],
          "required": true,
          "allow_custom": true,
          "note": "A couple's age is the older partner's (Pre-Teen to Adult) or the younger partner's (Senior) (X.A.6)."
        }
      ]
    },
    "ballroom_professional": {
      "label": "NDCA Professional",
      "combination": "separate",
      "note": "Open Professional and Rising Star are separate contests (II.B.1); NDCA defines no professional age categories.",
      "axes": [
        {
          "key": "contest_type",
          "label": "Contests",
          "values": [
            {
              "key": "open_professional",
              "label": "Open Professional",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.1.a",
                  "page": "6"
                }
              ]
            },
            {
              "key": "rising_star",
              "label": "Rising Star",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.1.b",
                  "page": "6"
                }
              ],
              "eligibility": {
                "note": "Rising Star status is lost as described in II.B.1.b(1)."
              }
            }
          ],
          "required": true,
          "allow_custom": false
        }
      ]
    },
    "ballroom_solo_star": {
      "label": "NDCA Solo Star",
      "combination": "cross",
      "note": "Solo Star is for Pre-Teen, Junior and Youth amateurs only (II.A.3, II.B.10). Proficiency for Solo Star is NOT SPECIFIED IN PROVIDED SOURCE.",
      "axes": [
        {
          "key": "age_group",
          "label": "Age divisions",
          "values": [
            {
              "key": "pre_teen_i",
              "label": "Pre-Teen I",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.10",
                  "page": "8"
                },
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "under_age": 10
              }
            },
            {
              "key": "pre_teen_ii",
              "label": "Pre-Teen II",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.10",
                  "page": "8"
                },
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 10,
                "under_age": 12
              }
            },
            {
              "key": "junior_i",
              "label": "Junior I",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.10",
                  "page": "8"
                },
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 12,
                "under_age": 14
              }
            },
            {
              "key": "junior_ii",
              "label": "Junior II",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.10",
                  "page": "8"
                },
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 14,
                "under_age": 16
              }
            },
            {
              "key": "youth",
              "label": "Youth",
              "basis": "source_grounded",
              "sources": [
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "II.B.10",
                  "page": "8"
                },
                {
                  "document": "NDCA Rule Book",
                  "edition": "June 2026 (compiled)",
                  "section": "X.A.1",
                  "page": "42"
                }
              ],
              "eligibility": {
                "min_age": 16,
                "under_age": 19
              }
            }
          ],
          "required": true,
          "allow_custom": false
        }
      ]
    },
    "ballroom_adult_open": {
      "label": "One adult open division",
      "combination": "cross",
      "note": "Student/Student is for adults only (II.A.6.b). Youth Student/Student is not offered while II.A.6.b and II.B.8 conflict.",
      "axes": [
        {
          "key": "skill_level",
          "label": "Divisions",
          "values": [
            {
              "key": "adult_open",
              "label": "Adult Open",
              "basis": "studio_recommendation",
              "eligibility": {
                "note": "Adult Pro/Am Student Competitors; not open to Open Amateur dancers (II.A.6)."
              }
            }
          ],
          "required": true,
          "allow_custom": false
        }
      ]
    },
    "studio_wcs": {
      "label": "Studio WCS levels",
      "combination": "cross",
      "note": "Studio / Custom levels. WSDC 2026.1C defines no Couples or Pro-Am contest, so no WSDC age contests apply.",
      "axes": [
        {
          "key": "skill_level",
          "label": "Levels",
          "values": [
            {
              "key": "newcomer",
              "label": "Newcomer",
              "basis": "studio_recommendation"
            },
            {
              "key": "novice",
              "label": "Novice",
              "basis": "studio_recommendation"
            },
            {
              "key": "intermediate",
              "label": "Intermediate",
              "basis": "studio_recommendation"
            },
            {
              "key": "advanced",
              "label": "Advanced",
              "basis": "studio_recommendation"
            },
            {
              "key": "open",
              "label": "Open",
              "basis": "studio_recommendation",
              "name_label": "Open Level",
              "eligibility": {
                "note": "Studio / Custom open skill level. UCWDC uses Open only as an age division, not a ProAm skill level."
              }
            }
          ],
          "required": true,
          "allow_custom": true
        }
      ]
    },
    "studio_generic": {
      "label": "Studio levels",
      "combination": "cross",
      "axes": [
        {
          "key": "skill_level",
          "label": "Levels",
          "values": [
            {
              "key": "newcomer",
              "label": "Newcomer",
              "basis": "studio_recommendation"
            },
            {
              "key": "bronze",
              "label": "Bronze",
              "basis": "studio_recommendation"
            },
            {
              "key": "silver",
              "label": "Silver",
              "basis": "studio_recommendation"
            },
            {
              "key": "gold",
              "label": "Gold",
              "basis": "studio_recommendation"
            },
            {
              "key": "novice",
              "label": "Novice",
              "basis": "studio_recommendation"
            },
            {
              "key": "intermediate",
              "label": "Intermediate",
              "basis": "studio_recommendation"
            },
            {
              "key": "advanced",
              "label": "Advanced",
              "basis": "studio_recommendation"
            },
            {
              "key": "open",
              "label": "Open",
              "basis": "studio_recommendation",
              "name_label": "Open Level",
              "eligibility": {
                "note": "Studio / Custom open skill level. UCWDC uses Open only as an age division, not a ProAm skill level."
              }
            }
          ],
          "required": true,
          "allow_custom": true
        },
        {
          "key": "age_group",
          "label": "Age divisions",
          "values": [
            {
              "key": "youth",
              "label": "Youth",
              "basis": "studio_recommendation"
            },
            {
              "key": "adult",
              "label": "Adult",
              "basis": "studio_recommendation"
            },
            {
              "key": "senior",
              "label": "Senior",
              "basis": "studio_recommendation"
            }
          ],
          "required": false,
          "allow_custom": true,
          "note": "Studio / Custom age groups; define your own if you prefer."
        }
      ]
    },
    "open_only": {
      "label": "One open division",
      "combination": "cross",
      "axes": [
        {
          "key": "skill_level",
          "label": "Divisions",
          "values": [
            {
              "key": "open",
              "label": "Open",
              "basis": "studio_recommendation"
            }
          ],
          "required": true,
          "allow_custom": true
        }
      ]
    }
  },
  "limits": {
    "programs": 4,
    "categories": 60,
    "divisions": 80,
    "totalDivisions": 300,
    "dances": 20,
    "programDances": 60,
    "nameLength": 200,
    "maxPrice": 100000
  }
}$profile$::jsonb;
  v_existing record;
begin
  select * into v_existing from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 3;
  if v_existing.profile_key is null then
    insert into public.competition_rules_profiles (profile_key, version, name, description, status, defaults)
    values ('studio_simple', 3, 'Studio / Custom Rules',
            'DanceFlow generic studio rules for the Competition Setup Wizard. Not a sanctioning organization.',
            'active', v_defaults);
  elsif v_existing.defaults = v_defaults and v_existing.name = 'Studio / Custom Rules' and v_existing.status = 'retired' then
    -- Re-apply after this file's rollback: the identical, immutable version is reactivated (status only).
    alter table public.competition_rules_profiles disable trigger protect_competition_rules_profile;
    update public.competition_rules_profiles set status = 'active' where profile_key = 'studio_simple' and version = 3;
    alter table public.competition_rules_profiles enable trigger protect_competition_rules_profile;
  else
    raise exception 'Phase 10C.5: studio_simple@3 already exists with different content.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Venue, dates, times and time zone of competition events: owner/admin roles only
-- ---------------------------------------------------------------------------
-- Owner decision (10C.5): studio owners/admins and organizer owners/admins only. Organizer staff keep their
-- competition access (can_manage_event_competition) but cannot change these operationally sensitive fields.
create function public.can_edit_competition_event_operations(target_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
    from public.events e
    where e.id = target_event_id
      and (
        exists (select 1 from public.user_studio_roles usr
                where usr.studio_id = e.studio_id and usr.user_id = auth.uid() and usr.active = true
                  and usr.role in ('studio_owner', 'studio_admin'))
        or exists (select 1 from public.organizer_users ou
                   where ou.organizer_id = e.organizer_id and ou.user_id = auth.uid() and ou.active = true
                     and ou.role in ('organizer_owner', 'organizer_admin'))
      )
  );
$fn$;

revoke all on function public.can_edit_competition_event_operations(uuid) from public, anon;
grant execute on function public.can_edit_competition_event_operations(uuid) to authenticated, service_role;

-- The events update policies (present in the database, not in repository migrations) let any active studio role and
-- organizer staff update any column. For competition events this guard narrows changes to the venue, address,
-- dates, times, time zone and event type to the roles above, whatever path writes them. Writes without a user
-- session (service role, migrations) are not affected.
create function public.protect_competition_event_operations()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if auth.uid() is null then
    return new;
  end if;
  if (new.venue_name, new.address_line_1, new.address_line_2, new.city, new.state, new.postal_code,
      new.start_date, new.end_date, new.start_time, new.end_time, new.timezone, new.event_type)
     is not distinct from
     (old.venue_name, old.address_line_1, old.address_line_2, old.city, old.state, old.postal_code,
      old.start_date, old.end_date, old.start_time, old.end_time, old.timezone, old.event_type) then
    return new;
  end if;
  if (old.event_type = 'competition' or new.event_type = 'competition'
      or exists (select 1 from public.event_competition_programs p where p.event_id = old.id))
     and not public.can_edit_competition_event_operations(old.id) then
    raise exception 'Only studio owners and admins, and organizer owners and admins, can change the venue, dates, times or time zone of a competition event.'
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

revoke all on function public.protect_competition_event_operations() from public, anon, authenticated;

create trigger protect_competition_event_operations
before update on public.events
for each row execute function public.protect_competition_event_operations();


-- ---------------------------------------------------------------------------
-- 3. create_competition_draft (replaces the 20261113090000 body; privileges are kept)
-- ---------------------------------------------------------------------------
create or replace function public.create_competition_draft(p_event_id uuid, p_spec jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_event record;
  v_profile record;
  v_defaults jsonb;
  v_limits jsonb;
  v_request text;
  v_hash text;
  v_ids uuid[];
  v_mismatch integer;
  v_purpose text;
  v_programs jsonb;
  v_prog jsonb;
  v_prog_ix integer;
  v_prog_key text;
  v_prog_keys text[] := '{}';
  v_template jsonb;
  v_regular_count integer := 0;
  v_special_count integer := 0;
  v_prog_adjudication text;
  v_cat_adjudication text;
  v_cat_judging_key text;
  v_cat_judging jsonb;
  v_cat_label text;
  v_allowed jsonb;
  v_judging_key text;
  v_judging jsonb;
  v_name text;
  v_names text[] := '{}';
  v_pool jsonb;
  v_dance jsonb;
  v_dance_ix integer;
  v_dance_key text;
  v_dance_name text;
  v_dance_keys text[];
  v_used text[];
  v_cat jsonb;
  v_cat_ix integer;
  v_cat_key text;
  v_cat_def jsonb;
  v_cat_seen text[];
  v_style_key text;
  v_style jsonb;
  v_div jsonb;
  v_div_ix integer;
  v_div_seen text[];
  v_div_name text;
  v_total_divisions integer := 0;
  v_model text;
  v_amount numeric;
  v_needs_fee boolean;
  v_fee numeric;
  v_max_price numeric;
  v_opens timestamptz;
  v_closes timestamptz;
  v_account boolean;
  v_page jsonb;
  v_ops text[];
  v_new_start date;
  v_new_end date;
  v_new_start_time time;
  v_new_end_time time;
  v_program_id uuid;
  v_contest_id uuid;
  v_division_id uuid;
  v_dance_id uuid;
  v_dance_ids jsonb;
  v_round jsonb;
  v_round_ix integer;
  v_pending boolean;
  v_any_pending boolean := false;
  v_created uuid[] := '{}';
begin
  if v_actor is null or not public.can_manage_event_competition(p_event_id) then
    raise exception 'Event was not found or cannot be managed.' using errcode = '42501';
  end if;
  select e.id, e.name, e.studio_id, e.organizer_id, e.start_date, e.end_date, e.start_time, e.end_time
    into v_event from public.events e where e.id = p_event_id;
  if v_event.id is null then
    raise exception 'Event was not found or cannot be managed.' using errcode = '42501';
  end if;
  if p_spec is null or jsonb_typeof(p_spec) <> 'object' then
    raise exception 'A competition setup is required.';
  end if;

  select p.profile_key, p.version, p.defaults, p.status into v_profile
  from public.competition_rules_profiles p
  where p.profile_key = p_spec->>'profile_key'
    and p.version = case when p_spec->>'profile_version' ~ '^[0-9]{1,6}$' then (p_spec->>'profile_version')::integer end;
  if v_profile.profile_key is null or v_profile.status <> 'active' or v_profile.defaults->>'schema' is distinct from '2' then
    raise exception 'Unsupported competition profile.';
  end if;
  -- Referenced profiles are immutable: a superseded version keeps serving the programs created from it, but new
  -- setups use the current one (studio_simple@3 replaced the never-released studio_simple@2).
  if v_profile.profile_key = 'studio_simple' and v_profile.version < 3 then
    raise exception 'These competition rules have been replaced. Reload the page and start the setup again.';
  end if;
  v_defaults := v_profile.defaults;
  v_limits := v_defaults->'limits';
  v_max_price := (v_limits->>'maxPrice')::numeric;

  v_request := p_spec->>'request_key';
  if v_request is null or v_request !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'A request key is required.';
  end if;
  -- jsonb text is canonical (sorted keys, normalized spacing), so equal requests hash equally.
  v_hash := md5(p_spec::text);

  perform pg_advisory_xact_lock(hashtext(p_event_id::text || ':simple_competition'));

  select array_agg(p.id order by p.sort_order, p.created_at),
         count(*) filter (where p.configuration #>> '{setup,request_hash}' is distinct from v_hash)
    into v_ids, v_mismatch
  from public.event_competition_programs p
  where p.event_id = p_event_id and p.configuration #>> '{simple,request_key}' = v_request;
  if v_ids is not null then
    if v_mismatch > 0 then
      raise exception 'This setup was already submitted with different choices. Reload the page to see the competition that was created.';
    end if;
    return jsonb_build_object('program_ids', to_jsonb(v_ids), 'replayed', true);
  end if;
  if exists (select 1 from public.event_competition_programs p where p.event_id = p_event_id) then
    raise exception 'This event already has competition setup. Use Advanced settings or restart the setup first.';
  end if;

  v_purpose := p_spec->>'purpose';
  if v_purpose is null or v_purpose not in ('competition', 'showcase', 'competition_showcase') then
    raise exception 'Choose what you are creating.';
  end if;
  -- Registration basics (timestamps are computed by the server from the event time zone).
  if jsonb_typeof(p_spec->'registration') is distinct from 'object'
    or jsonb_typeof(p_spec #> '{registration,account_required}') is distinct from 'boolean' then
    raise exception 'Registration details are required.';
  end if;
  begin
    v_opens := case when jsonb_typeof(p_spec #> '{registration,opens_at}') = 'string' then (p_spec #>> '{registration,opens_at}')::timestamptz end;
    v_closes := case when jsonb_typeof(p_spec #> '{registration,closes_at}') = 'string' then (p_spec #>> '{registration,closes_at}')::timestamptz end;
  exception when others then
    raise exception 'Registration dates must be valid dates.';
  end;
  if coalesce(jsonb_typeof(p_spec #> '{registration,opens_at}'), 'null') not in ('string', 'null')
    or coalesce(jsonb_typeof(p_spec #> '{registration,closes_at}'), 'null') not in ('string', 'null') then
    raise exception 'Registration dates must be valid dates.';
  end if;
  if v_opens is not null and v_closes is not null and v_closes <= v_opens then
    raise exception 'Registration cannot close before it opens.';
  end if;
  v_account := (p_spec #>> '{registration,account_required}')::boolean;

  -- Event page (optional): only the fields the organizer changed. Venue, dates and slug stay with the event.
  v_page := coalesce(p_spec->'event', '{}'::jsonb);
  if jsonb_typeof(v_page) <> 'object'
    or exists (select 1 from jsonb_object_keys(v_page) k
               where k not in ('name', 'summary', 'description', 'cover_image_url', 'highlights', 'registration_info',
                               'venue_name', 'address_line_1', 'address_line_2', 'city', 'state', 'postal_code',
                               'start_date', 'end_date', 'start_time', 'end_time', 'timezone')) then
    raise exception 'The event page details are not valid.';
  end if;
  -- Venue, address, dates, times and time zone: owner/admin roles only, valid values, nothing depending on them.
  v_ops := array(select k from jsonb_object_keys(v_page) k
                 where k in ('venue_name', 'address_line_1', 'address_line_2', 'city', 'state', 'postal_code',
                             'start_date', 'end_date', 'start_time', 'end_time', 'timezone'));
  if cardinality(v_ops) > 0 then
    if not public.can_edit_competition_event_operations(p_event_id) then
      raise exception 'Only studio owners and admins, and organizer owners and admins, can change the venue, dates, times or time zone.'
        using errcode = '42501';
    end if;
    if exists (select 1 from unnest(v_ops) k where jsonb_typeof(v_page->k) not in ('string', 'null'))
      or (v_page ? 'start_date' and jsonb_typeof(v_page->'start_date') <> 'string')
      or (v_page ? 'timezone' and jsonb_typeof(v_page->'timezone') <> 'string') then
      raise exception 'The venue, dates or time zone are not valid.';
    end if;
    if exists (select 1 from (values ('venue_name', 200), ('address_line_1', 200), ('address_line_2', 200), ('city', 120), ('postal_code', 20)) f(k, max_length)
               where v_page ? f.k and length(coalesce(v_page->>f.k, '')) > f.max_length)
      or (v_page ? 'state' and coalesce(v_page->>'state', '') !~ '^([A-Z]{2})?$') then
      raise exception 'The venue or address is not valid.';
    end if;
    if (v_page ? 'timezone' and not exists (select 1 from pg_timezone_names tz where tz.name = v_page->>'timezone'))
      or exists (select 1 from unnest(array['start_date', 'end_date']) k
                 where v_page ? k and coalesce(v_page->>k, '') <> '' and v_page->>k !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
      or exists (select 1 from unnest(array['start_time', 'end_time']) k
                 where v_page ? k and coalesce(v_page->>k, '') <> '' and v_page->>k !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
      raise exception 'Enter valid dates, times and a time zone.';
    end if;
    begin
      v_new_start := case when v_page ? 'start_date' then (v_page->>'start_date')::date else v_event.start_date end;
      v_new_end := case when v_page ? 'end_date' then nullif(v_page->>'end_date', '')::date else v_event.end_date end;
      v_new_start_time := case when v_page ? 'start_time' then nullif(v_page->>'start_time', '')::time else v_event.start_time end;
      v_new_end_time := case when v_page ? 'end_time' then nullif(v_page->>'end_time', '')::time else v_event.end_time end;
    exception when others then
      raise exception 'Enter valid dates, times and a time zone.';
    end;
    if v_new_start is null or (v_new_end is not null and v_new_end < v_new_start) then
      raise exception 'The end date cannot be before the start date.';
    end if;
    if v_new_start_time is not null and v_new_end_time is not null and coalesce(v_new_end, v_new_start) = v_new_start
      and v_new_end_time <= v_new_start_time then
      raise exception 'On a one-day event the end time must be after the start time.';
    end if;
    -- Never move or strand what depends on the venue and dates: registrants are notified only by Edit event.
    if exists (select 1 from public.event_registrations r where r.event_id = p_event_id
               and r.status in ('pending', 'confirmed', 'waitlisted', 'checked_in')) then
      raise exception 'This event already has registrations; change its venue, dates or time zone in Edit event, which notifies registrants.';
    end if;
    if v_ops && array['venue_name', 'address_line_1', 'address_line_2', 'city', 'state', 'postal_code']
      and exists (select 1 from public.event_locations l where l.event_id = p_event_id and l.active) then
      raise exception 'This event lists additional locations; change its venue in Edit event.';
    end if;
    if v_ops && array['start_date', 'end_date', 'start_time', 'end_time', 'timezone']
      and (exists (select 1 from public.event_schedule_items si where si.event_id = p_event_id)
           or exists (select 1 from public.event_location_sessions ls where ls.event_id = p_event_id)
           or exists (select 1 from public.event_sessions es where es.event_id = p_event_id)
           or exists (select 1 from public.event_competition_schedule_sessions cs where cs.event_id = p_event_id)) then
      raise exception 'This event already has dated schedule items or sessions; change its dates or time zone in Edit event.';
    end if;
  end if;
  if v_page ? 'name' and (jsonb_typeof(v_page->'name') <> 'string' or length(btrim(v_page->>'name')) not between 1 and 160) then
    raise exception 'Enter an event title of 1 to 160 characters.';
  end if;
  if exists (select 1 from (values ('summary', 300), ('description', 10000), ('registration_info', 2000)) f(k, max_length)
             where v_page ? f.k and (jsonb_typeof(v_page->f.k) not in ('string', 'null') or length(coalesce(v_page->>f.k, '')) > f.max_length)) then
    raise exception 'The event page text is too long.';
  end if;
  if v_page ? 'cover_image_url' and jsonb_typeof(v_page->'cover_image_url') <> 'null'
    and (jsonb_typeof(v_page->'cover_image_url') <> 'string' or length(v_page->>'cover_image_url') > 2048
         or v_page->>'cover_image_url' !~ ('^https://[^[:space:]/]+/storage/v1/object/public/event-media/' || v_event.studio_id::text || '/[^[:space:]]+$')) then
    raise exception 'Upload the cover image again.';
  end if;
  if v_page ? 'highlights'
    and (jsonb_typeof(v_page->'highlights') <> 'array' or jsonb_array_length(v_page->'highlights') > 6
         or exists (select 1 from jsonb_array_elements(v_page->'highlights') h(value)
                    where jsonb_typeof(h.value) <> 'string' or length(btrim(h.value #>> '{}')) not between 1 and 120)) then
    raise exception 'Use up to 6 highlights of 1 to 120 characters each.';
  end if;

  v_programs := p_spec->'programs';
  if jsonb_typeof(v_programs) is distinct from 'array'
    or jsonb_array_length(v_programs) < 1 or jsonb_array_length(v_programs) > (v_limits->>'programs')::integer then
    raise exception 'Choose between 1 and % programs.', v_limits->>'programs';
  end if;

  -- ---- validation pass: nothing is written until the whole request is valid ----
  for v_prog in select value from jsonb_array_elements(v_programs) loop
    if jsonb_typeof(v_prog) <> 'object' then raise exception 'Each program must be an object.'; end if;
    v_prog_key := v_prog->>'key';
    v_template := v_defaults->'programs'->v_prog_key;
    if v_prog_key is null or v_template is null then
      raise exception 'Program % is not available.', coalesce(v_prog_key, '(none)');
    end if;
    if v_prog_key = any (v_prog_keys) then raise exception 'Each program can be added once.'; end if;
    v_prog_keys := v_prog_keys || v_prog_key;
    -- Style-level adjudication: the default every ordinary entry format inherits.
    v_prog_adjudication := v_prog->>'adjudication';
    if v_prog_adjudication is null or v_prog_adjudication not in ('adjudicated', 'non_adjudicated') then
      raise exception 'Choose Adjudicated or Non-Adjudicated for %.', v_template->>'label';
    end if;
    v_allowed := case when v_prog_adjudication = 'adjudicated'
                      then v_template->'judging_options'
                      else jsonb_build_array(v_defaults #>> '{adjudication,non_adjudicated,judging}') end;
    v_judging_key := v_prog->>'judging';
    if v_judging_key is null or not coalesce(v_allowed ? v_judging_key, false) or v_defaults->'judging'->v_judging_key is null then
      raise exception 'Choose how % is judged.', v_template->>'label';
    end if;

    v_name := btrim(coalesce(v_prog->>'name', ''));
    if length(v_name) < 1 or length(v_name) > 160 then
      raise exception 'Each program name must be 1 to 160 characters.';
    end if;
    if lower(v_name) = any (v_names) then raise exception 'Program names must be unique (%).', v_name; end if;
    v_names := v_names || lower(v_name);

    -- Program dances: from the profile pool, or organizer-defined when the program allows it.
    v_pool := v_defaults->'dancePools'->(v_template->>'dance_pool');
    if jsonb_typeof(v_prog->'dances') is distinct from 'array' or jsonb_array_length(v_prog->'dances') > (v_limits->>'programDances')::integer then
      raise exception 'Choose % dances or fewer for %.', v_limits->>'programDances', v_template->>'label';
    end if;
    v_dance_keys := '{}';
    for v_dance in select value from jsonb_array_elements(v_prog->'dances') loop
      v_dance_key := v_dance->>'key';
      if jsonb_typeof(v_dance) <> 'object' or v_dance_key is null then raise exception 'Each dance needs a key.'; end if;
      if not exists (select 1 from jsonb_array_elements(v_pool) pd(value) where pd.value->>'key' = v_dance_key) then
        v_dance_name := btrim(coalesce(v_dance->>'name', ''));
        if not (v_template->>'custom_dances')::boolean or v_dance_key !~ '^custom_[a-z0-9_]{1,40}$'
          or length(v_dance_name) < 1 or length(v_dance_name) > 80 then
          raise exception 'Dance % is not available for %.', v_dance_key, v_template->>'label';
        end if;
      end if;
      if v_dance_key = any (v_dance_keys) then raise exception 'Each dance can be listed once per program.'; end if;
      v_dance_keys := v_dance_keys || v_dance_key;
    end loop;

    if jsonb_typeof(v_prog->'categories') is distinct from 'array'
      or jsonb_array_length(v_prog->'categories') < 1 or jsonb_array_length(v_prog->'categories') > (v_limits->>'categories')::integer then
      raise exception 'Choose between 1 and % categories for %.', v_limits->>'categories', v_template->>'label';
    end if;
    v_cat_seen := '{}';
    v_used := '{}';
    v_needs_fee := false;
    for v_cat in select value from jsonb_array_elements(v_prog->'categories') loop
      if jsonb_typeof(v_cat) <> 'object' then raise exception 'Each entry format must be an object.'; end if;
      v_cat_key := v_cat->>'type';
      v_cat_def := v_defaults->'categoryTypes'->v_cat_key;
      if v_cat_key is null or v_cat_def is null or not (v_template->'formats' ? v_cat_key) then
        raise exception 'Entry format % is not available for %.', coalesce(v_cat_key, '(none)'), v_template->>'label';
      end if;
      -- A styled offering (e.g. Ballroom Pro/Am) is entered per dance style: one category per (offering, style).
      v_style_key := v_cat->>'style';
      v_style := null;
      if coalesce((v_cat_def->>'uses_styles')::boolean, false) then
        select st.value into v_style from jsonb_array_elements(coalesce(v_template->'styles', '[]'::jsonb)) st(value)
        where st.value->>'key' = v_style_key;
        if jsonb_typeof(v_cat->'style') is distinct from 'string' or v_style is null
          or (v_cat_def ? 'style_keys' and not coalesce(v_cat_def->'style_keys' ? v_style_key, false)) then
          raise exception 'Choose an available style for %.', v_cat_def->>'label';
        end if;
      elsif coalesce(jsonb_typeof(v_cat->'style'), 'null') <> 'null' then
        raise exception '% is not entered per style.', v_cat_def->>'label';
      end if;
      if v_cat_key || ':' || coalesce(v_style_key, '') = any (v_cat_seen) then
        raise exception 'Each entry format can be added once per style in a program.';
      end if;
      v_cat_seen := v_cat_seen || (v_cat_key || ':' || coalesce(v_style_key, ''));
      -- Showcase / Performance offers only special (routine / performance) formats.
      if v_purpose = 'showcase' and v_cat_def->>'kind' is distinct from 'special' then
        raise exception '% is not a Showcase / Performance offering.', v_cat_def->>'label';
      end if;
      if v_cat_def->>'kind' = 'special' then v_special_count := v_special_count + 1;
      else v_regular_count := v_regular_count + 1; end if;
      -- A format may differ from its style's adjudication only where the profile allows it.
      v_cat_adjudication := coalesce(v_cat->>'adjudication', 'inherit');
      if v_cat_adjudication not in ('inherit', 'adjudicated', 'non_adjudicated')
        or (v_cat_adjudication <> 'inherit' and not coalesce((v_cat_def->>'adjudication_override')::boolean, false)) then
        raise exception '% follows the style''s adjudication.', v_cat_def->>'label';
      end if;

      if jsonb_typeof(v_cat->'divisions') is distinct from 'array'
        or jsonb_array_length(v_cat->'divisions') < 1 or jsonb_array_length(v_cat->'divisions') > (v_limits->>'divisions')::integer then
        raise exception 'Add between 1 and % divisions for %.', v_limits->>'divisions', v_cat_def->>'label';
      end if;
      v_div_seen := '{}';
      for v_div in select value from jsonb_array_elements(v_cat->'divisions') loop
        if jsonb_typeof(v_div) <> 'object' then raise exception 'Each division must be an object.'; end if;
        v_div_name := btrim(coalesce(v_div->>'name', ''));
        if length(v_div_name) < 1 or length(v_div_name) > (v_limits->>'nameLength')::integer then
          raise exception 'Each division needs a name of 1 to % characters.', v_limits->>'nameLength';
        end if;
        if lower(v_div_name) = any (v_div_seen) then raise exception 'Division names must be unique (%).', v_div_name; end if;
        if coalesce(jsonb_typeof(v_div->'axes'), 'object') <> 'object'
          or exists (select 1 from jsonb_each(coalesce(v_div->'axes', '{}'::jsonb)) a
                     where a.key not in ('skill_level', 'age_group', 'style', 'proficiency', 'contest_type', 'custom')
                        or jsonb_typeof(a.value) <> 'string' or length(btrim(a.value #>> '{}')) not between 1 and 80) then
          raise exception 'Division % has invalid division details.', v_div_name;
        end if;
        v_div_seen := v_div_seen || lower(v_div_name);
      end loop;
      v_total_divisions := v_total_divisions + jsonb_array_length(v_cat->'divisions');

      if (v_cat_def->>'uses_dances')::boolean then
        if jsonb_typeof(v_cat->'dances') is distinct from 'array'
          or jsonb_array_length(v_cat->'dances') < 1 or jsonb_array_length(v_cat->'dances') > (v_limits->>'dances')::integer then
          raise exception 'Choose at least one dance for %.', v_cat_def->>'label';
        end if;
        v_dance_keys := '{}';
        for v_dance_key in select value from jsonb_array_elements_text(v_cat->'dances') loop
          if not exists (select 1 from jsonb_array_elements(v_prog->'dances') d(value) where d.value->>'key' = v_dance_key) then
            raise exception 'Dance % is not part of %.', v_dance_key, v_template->>'label';
          end if;
          -- A styled category holds only its style's dances (or organizer-added dances where the style allows them).
          if v_style is not null and not coalesce(v_style->'dances' ? v_dance_key, false)
            and not (coalesce((v_style->>'allow_custom_dances')::boolean, false) and v_dance_key ~ '^custom_[a-z0-9_]{1,40}$'
                     and not exists (select 1 from jsonb_array_elements(v_pool) pd(value) where pd.value->>'key' = v_dance_key)) then
            raise exception 'Dance % is not part of the % style.', v_dance_key, v_style->>'label';
          end if;
          if v_dance_key = any (v_dance_keys) then raise exception 'Dances can be chosen once per entry format.'; end if;
          -- A Multi-Dance set is danced in its style's order (NDCA IX.A.1).
          if v_cat_def->>'event_form' = 'multi_dance' and cardinality(v_dance_keys) > 0
            and (select st.n from jsonb_array_elements_text(v_style->'dances') with ordinality st(k, n) where st.k = v_dance_key)
                <= (select st.n from jsonb_array_elements_text(v_style->'dances') with ordinality st(k, n) where st.k = v_dance_keys[cardinality(v_dance_keys)]) then
            raise exception '% dances must be listed in the % order.', v_cat_def->>'label', v_style->>'label';
          end if;
          v_dance_keys := v_dance_keys || v_dance_key;
          if not (v_dance_key = any (v_used)) then v_used := v_used || v_dance_key; end if;
        end loop;
      elsif coalesce(v_cat->'dances', '[]'::jsonb) not in ('[]'::jsonb, 'null'::jsonb) then
        raise exception '% does not use individual dances.', v_cat_def->>'label';
      end if;
      if v_cat_def->>'event_form' = 'multi_dance' then
        if jsonb_array_length(v_cat->'dances') < coalesce((v_cat_def->>'min_dances')::integer, 2) then
          raise exception 'A Multi-Dance set needs at least % dances (%).', coalesce(v_cat_def->>'min_dances', '2'), v_cat_def->>'label';
        end if;
        -- NDCA X.B.4: an Open Amateur division dances every dance of the style.
        if exists (select 1
                   from jsonb_array_elements(v_cat->'divisions') d(value),
                        jsonb_each_text(coalesce(d.value->'axes', '{}'::jsonb)) a(axis, label),
                        jsonb_array_elements(v_defaults #> array['divisionSchemes', v_template #>> array['division_schemes', v_cat_key], 'axes']) sa(value),
                        jsonb_array_elements(sa.value->'values') sv(value)
                   where sa.value->>'key' = a.axis and sv.value->>'label' = a.label
                     and coalesce((sv.value->>'requires_all_style_dances')::boolean, false))
          and exists (select 1 from jsonb_array_elements_text(v_style->'dances') sd(k) where not (v_cat->'dances' ? sd.k)) then
          raise exception 'Open Amateur dances every % dance: choose all of them for %.', v_style->>'label', v_cat_def->>'label';
        end if;
      end if;

      v_model := v_cat #>> '{pricing,model}';
      if v_model is null or not coalesce(v_cat_def->'pricing_models' ? v_model, false) then
        raise exception 'Choose how % is priced.', v_cat_def->>'label';
      end if;
      if v_model in ('per_dance', 'per_entry') then
        if jsonb_typeof(v_cat #> '{pricing,amount}') is distinct from 'number' then
          raise exception 'Enter a price for %.', v_cat_def->>'label';
        end if;
        v_amount := (v_cat #>> '{pricing,amount}')::numeric;
        if v_amount <= 0 or v_amount > v_max_price or v_amount <> round(v_amount, 2) then
          raise exception 'Enter a valid price for %.', v_cat_def->>'label';
        end if;
      elsif coalesce(jsonb_typeof(v_cat #> '{pricing,amount}'), 'null') <> 'null' then
        raise exception 'A price is only entered for per-dance or per-entry pricing (%).', v_cat_def->>'label';
      end if;
      if v_model = 'included' then v_needs_fee := true; end if;
    end loop;

    if exists (select 1 from jsonb_array_elements(v_prog->'dances') d(value) where not (d.value->>'key' = any (v_used))) then
      raise exception 'Remove dances that no entry format in % uses.', v_template->>'label';
    end if;
    if v_needs_fee then
      if jsonb_typeof(v_prog->'registration_fee') is distinct from 'number' then
        raise exception 'Enter the % registration fee.', v_template->>'label';
      end if;
      v_fee := (v_prog->>'registration_fee')::numeric;
      if v_fee <= 0 or v_fee > v_max_price or v_fee <> round(v_fee, 2) then
        raise exception 'Enter a valid % registration fee.', v_template->>'label';
      end if;
    elsif coalesce(jsonb_typeof(v_prog->'registration_fee'), 'null') <> 'null' then
      raise exception 'A registration fee is only used when entries are included in it (%).', v_template->>'label';
    end if;
  end loop;

  if v_total_divisions > (v_limits->>'totalDivisions')::integer then
    raise exception 'This setup has % divisions; use % or fewer.', v_total_divisions, v_limits->>'totalDivisions';
  end if;
  if v_purpose = 'competition_showcase' and (v_regular_count < 1 or v_special_count < 1) then
    raise exception 'Competition + Showcase / Performance needs a competition entry format and a showcase or performance offering.';
  end if;

  -- ---- writes ----
  update public.events
  set registration_required = true, account_required_for_registration = v_account,
      registration_opens_at = v_opens, registration_closes_at = v_closes,
      name = case when v_page ? 'name' then btrim(v_page->>'name') else name end,
      short_description = case when v_page ? 'summary' then nullif(btrim(coalesce(v_page->>'summary', '')), '') else short_description end,
      public_summary = case when v_page ? 'summary' then nullif(btrim(coalesce(v_page->>'summary', '')), '') else public_summary end,
      description = case when v_page ? 'description' then nullif(btrim(coalesce(v_page->>'description', '')), '') else description end,
      public_description = case when v_page ? 'description' then nullif(btrim(coalesce(v_page->>'description', '')), '') else public_description end,
      cover_image_url = case when v_page ? 'cover_image_url' then v_page->>'cover_image_url' else cover_image_url end,
      public_cover_image_url = case when v_page ? 'cover_image_url' then v_page->>'cover_image_url' else public_cover_image_url end,
      public_highlights = case when v_page ? 'highlights'
                               then array(select btrim(h.value) from jsonb_array_elements_text(v_page->'highlights') with ordinality h(value, n) order by h.n)
                               else public_highlights end,
      public_registration_info = case when v_page ? 'registration_info' then nullif(btrim(coalesce(v_page->>'registration_info', '')), '') else public_registration_info end,
      venue_name = case when v_page ? 'venue_name' then nullif(btrim(coalesce(v_page->>'venue_name', '')), '') else venue_name end,
      address_line_1 = case when v_page ? 'address_line_1' then nullif(btrim(coalesce(v_page->>'address_line_1', '')), '') else address_line_1 end,
      address_line_2 = case when v_page ? 'address_line_2' then nullif(btrim(coalesce(v_page->>'address_line_2', '')), '') else address_line_2 end,
      city = case when v_page ? 'city' then nullif(btrim(coalesce(v_page->>'city', '')), '') else city end,
      state = case when v_page ? 'state' then nullif(btrim(coalesce(v_page->>'state', '')), '') else state end,
      postal_code = case when v_page ? 'postal_code' then nullif(btrim(coalesce(v_page->>'postal_code', '')), '') else postal_code end,
      start_date = case when v_page ? 'start_date' then v_new_start else start_date end,
      end_date = case when v_page ? 'end_date' then v_new_end else end_date end,
      start_time = case when v_page ? 'start_time' then v_new_start_time else start_time end,
      end_time = case when v_page ? 'end_time' then v_new_end_time else end_time end,
      timezone = case when v_page ? 'timezone' then v_page->>'timezone' else timezone end
  where id = p_event_id;

  for v_prog, v_prog_ix in select value, ordinality from jsonb_array_elements(v_programs) with ordinality loop
    v_prog_key := v_prog->>'key';
    v_template := v_defaults->'programs'->v_prog_key;
    v_prog_adjudication := v_prog->>'adjudication';
    v_judging_key := v_prog->>'judging';
    v_judging := v_defaults->'judging'->v_judging_key;
    v_pool := v_defaults->'dancePools'->(v_template->>'dance_pool');
    v_fee := case when jsonb_typeof(v_prog->'registration_fee') = 'number' then (v_prog->>'registration_fee')::numeric end;

    insert into public.event_competition_programs (
      event_id, studio_id, organizer_id, name, discipline_family, competition_mode, scoring_method,
      advancement_method, feedback_policy, status, sort_order, rules_profile_key, rules_profile_version, configuration, created_by
    ) values (
      p_event_id, v_event.studio_id, v_event.organizer_id, btrim(v_prog->>'name'), v_template->>'discipline_family',
      v_judging->>'competition_mode', v_judging #>> '{engine,key}', v_judging->>'advancement_method', 'none', 'draft',
      v_prog_ix * 10, v_profile.profile_key, v_profile.version,
      jsonb_build_object(
        'simple', jsonb_build_object('request_key', v_request, 'judging', v_judging_key, 'created_with', 'setup_wizard'),
        'setup', jsonb_build_object('request_hash', v_hash, 'program_key', v_prog_key, 'purpose', v_purpose,
                                    'adjudication', v_prog_adjudication, 'judging', v_judging_key, 'registration_fee', v_fee,
                                    'programming', v_template->'programming',
                                    'answers', coalesce(p_spec->'answers', '{}'::jsonb))),
      v_actor
    ) returning id into v_program_id;
    v_created := v_created || v_program_id;

    v_dance_ids := '{}'::jsonb;
    for v_dance, v_dance_ix in select value, ordinality from jsonb_array_elements(v_prog->'dances') with ordinality loop
      v_dance_key := v_dance->>'key';
      select pd.value into v_dance from jsonb_array_elements(v_pool) pd(value) where pd.value->>'key' = v_dance_key;
      if v_dance is null then
        select d.value into v_dance from jsonb_array_elements(v_prog->'dances') d(value) where d.value->>'key' = v_dance_key;
        v_dance := jsonb_build_object('name', btrim(v_dance->>'name'), 'category', 'Custom');
      end if;
      insert into public.event_competition_dances (event_id, program_id, dance_key, name, category_label, sort_order)
      values (p_event_id, v_program_id, v_dance_key, v_dance->>'name', v_dance->>'category', v_dance_ix * 10)
      returning id into v_dance_id;
      v_dance_ids := v_dance_ids || jsonb_build_object(v_dance_key, v_dance_id);
    end loop;

    for v_cat, v_cat_ix in select value, ordinality from jsonb_array_elements(v_prog->'categories') with ordinality loop
      v_cat_key := v_cat->>'type';
      v_cat_def := v_defaults->'categoryTypes'->v_cat_key;
      v_model := v_cat #>> '{pricing,model}';
      v_amount := case when v_model in ('per_dance', 'per_entry') then (v_cat #>> '{pricing,amount}')::numeric else 0 end;
      v_pending := v_model = 'later';
      v_any_pending := v_any_pending or v_pending;
      -- Inherit the style's judging, or apply the Showcase / Spotlight override.
      v_cat_adjudication := coalesce(v_cat->>'adjudication', 'inherit');
      v_cat_judging_key := case
        when v_cat_adjudication = 'inherit' then v_judging_key
        when v_cat_adjudication = 'non_adjudicated' then v_defaults #>> '{adjudication,non_adjudicated,judging}'
        when v_prog_adjudication = 'adjudicated' then v_judging_key
        else v_template #>> '{judging_options,0}'
      end;
      v_cat_judging := v_defaults->'judging'->v_cat_judging_key;
      v_style_key := v_cat->>'style';
      v_style := null;
      if v_style_key is not null then
        select st.value into v_style from jsonb_array_elements(v_template->'styles') st(value) where st.value->>'key' = v_style_key;
      end if;
      v_cat_label := coalesce(v_template #>> array['format_labels', v_cat_key], v_cat_def->>'label')
                     || coalesce(' — ' || (v_style->>'label'), '');

      insert into public.event_competition_contests (event_id, program_id, name, contest_type, entry_format, sort_order, configuration)
      values (p_event_id, v_program_id, v_cat_label, v_cat_def->>'contest_type', v_cat_def->>'entry_format', v_cat_ix * 10,
              jsonb_build_object(
                'simple', jsonb_build_object('category_type', v_cat_key),
                'setup', jsonb_build_object('pricing_model', v_model, 'pricing_pending', v_pending, 'style', v_style_key,
                                            'event_form', v_cat_def->'event_form', 'registration_hold', v_cat_def #> '{registration_hold,key}',
                                            'adjudication', case when v_cat_adjudication = 'inherit' then v_prog_adjudication else v_cat_adjudication end,
                                            'adjudication_source', case when v_cat_adjudication = 'inherit' then 'style' else 'override' end,
                                            'judging', v_cat_judging_key,
                                            'kind', v_cat_def->'kind', 'music_source', v_cat_def->'music_source',
                                            'floor_mode', v_cat_def->'floor_mode', 'program_placement', v_cat_def->'program_placement',
                                            'participant_roles', v_cat_def->'participant_roles', 'dance_roles', v_cat_def->'dance_roles')))
      returning id into v_contest_id;

      update public.event_competition_contest_registration_rules set
        dance_selection_mode = v_cat_def->>'dance_selection_mode',
        pricing_method = case when v_model = 'per_dance' then 'per_dance' else 'flat_entry' end,
        base_entry_fee = case when v_model = 'per_entry' then v_amount else 0 end,
        currency = v_defaults->>'currency',
        minimum_dances = case when v_cat_def->>'dance_selection_mode' = 'individual' then 1 else null end,
        maximum_dances = null,
        minimum_participants = (v_cat_def->>'minimum_participants')::integer,
        maximum_participants = (v_cat_def->>'maximum_participants')::integer,
        terminology = v_defaults->'terminology',
        registration_open = false
      where contest_id = v_contest_id and event_id = p_event_id;
      if not found then
        raise exception 'Category registration rules were not created.';
      end if;

      for v_div, v_div_ix in select value, ordinality from jsonb_array_elements(v_cat->'divisions') with ordinality loop
        insert into public.event_competition_divisions (event_id, program_id, contest_id, name, skill_label, age_label, sort_order, configuration)
        values (p_event_id, v_program_id, v_contest_id, btrim(v_div->>'name'),
                nullif(btrim(coalesce(v_div->>'skill_label', '')), ''), nullif(btrim(coalesce(v_div->>'age_label', '')), ''),
                v_div_ix * 10,
                jsonb_build_object('setup', jsonb_build_object('axes', coalesce(v_div->'axes', '{}'::jsonb))))
        returning id into v_division_id;

        for v_round, v_round_ix in select value, ordinality from jsonb_array_elements(v_cat_judging->'rounds') with ordinality loop
          insert into public.event_competition_rounds (event_id, program_id, division_id, name, round_type, sequence_number, scoring_method, pairing_mode)
          values (p_event_id, v_program_id, v_division_id, v_round->>'name', v_round->>'round_type', v_round_ix,
                  v_round->>'scoring_method', v_cat_def->>'pairing_mode');
        end loop;

        if (v_cat_def->>'uses_dances')::boolean then
          for v_dance_key, v_dance_ix in select value, ordinality from jsonb_array_elements_text(v_cat->'dances') with ordinality loop
            insert into public.event_competition_division_dances (event_id, program_id, division_id, dance_id, entry_fee, currency, required, sort_order)
            values (p_event_id, v_program_id, v_division_id, (v_dance_ids->>v_dance_key)::uuid,
                    case when v_model = 'per_dance' then v_amount else 0 end, v_defaults->>'currency',
                    v_cat_def->>'dance_selection_mode' <> 'individual', v_dance_ix * 10);
          end loop;
        end if;
      end loop;
    end loop;

    if v_fee is not null then
      insert into public.event_competition_fee_rules (event_id, program_id, name, calculation_type, amount, currency, configuration)
      values (p_event_id, v_program_id, left(btrim(v_prog->>'name'), 160) || ' registration fee', 'flat_per_person', v_fee,
              v_defaults->>'currency', jsonb_build_object('setup', jsonb_build_object('kind', 'registration_fee', 'request_key', v_request)));
    end if;
  end loop;

  return jsonb_build_object('program_ids', to_jsonb(v_created), 'replayed', false, 'pricing_pending', v_any_pending);
end;
$$;

revoke all on function public.create_competition_draft(uuid, jsonb) from public, anon;
grant execute on function public.create_competition_draft(uuid, jsonb) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 4. open_competition_registration: pricing-pending guard plus registration-hold guard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.open_competition_registration(p_program_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_program record;
  v_event record;
  v_contests int;
  v_divisions int;
begin
  select p.* into v_program from public.event_competition_programs p where p.id = p_program_id for update;
  if v_program.id is null or not public.can_manage_event_competition(v_program.event_id) then
    raise exception 'COMP10C_FORBIDDEN: competition was not found or cannot be managed.' using errcode = '42501';
  end if;
  select e.* into v_event from public.events e where e.id = v_program.event_id;
  if v_program.status not in ('configured', 'active') then
    raise exception 'COMP10C_NOT_PUBLISHED: publish the competition before opening registration.';
  end if;
  if v_program.rules_profile_key is not null and v_program.profile_locked_at is null then
    raise exception 'COMP10C_NOT_PUBLISHED: publish the competition before opening registration.';
  end if;
  if not v_event.registration_required then
    raise exception 'COMP10C_EVENT_REGISTRATION_OFF: turn on event registration before opening competition registration.';
  end if;
  -- 10C.5: a category whose pricing was deferred ("Configure later") blocks opening until it is priced.
  if exists (select 1 from public.event_competition_contests c
             where c.program_id = v_program.id and c.event_id = v_program.event_id and c.status in ('draft', 'open')
               and coalesce(c.configuration #>> '{setup,pricing_pending}', 'false') = 'true') then
    raise exception 'COMP10C_PRICING_PENDING: Pricing requires completion before registration can open.';
  end if;
  -- 10C.5: a category the rules profile cannot run yet (e.g. Multi-Dance, whose combined results are not computed)
  -- blocks opening; the draft and its divisions still exist.
  if exists (select 1 from public.event_competition_contests hc
             where hc.program_id = v_program.id and hc.event_id = v_program.event_id
               and hc.status = any (array['draft', 'open'])
               and hc.configuration #>> '{setup,registration_hold}' is not null) then
    raise exception 'COMP10C_REGISTRATION_HOLD: This competition has a category that cannot open registration yet (Multi-Dance results are not supported).';
  end if;

  -- Open every category that has at least one division, its draft divisions, and its rule.
  with ready as (
    select c.id from public.event_competition_contests c
    where c.program_id = v_program.id and c.event_id = v_program.event_id
      and c.status in ('draft', 'open')
      and exists (select 1 from public.event_competition_divisions d
                  where d.contest_id = c.id and d.event_id = c.event_id and d.status in ('draft', 'open'))
      and exists (select 1 from public.event_competition_contest_registration_rules r
                  where r.contest_id = c.id and r.event_id = c.event_id)
  ), opened as (
    update public.event_competition_contests c set status = 'open', updated_at = now()
    from ready where c.id = ready.id and c.status = 'draft' returning c.id
  )
  select (select count(*) from ready) into v_contests;
  if v_contests = 0 then
    raise exception 'COMP10C_NOTHING_REGISTRABLE: add a category with at least one division before opening registration.';
  end if;

  update public.event_competition_divisions d set status = 'open', updated_at = now()
  where d.program_id = v_program.id and d.event_id = v_program.event_id and d.status = 'draft'
    and exists (select 1 from public.event_competition_contests c where c.id = d.contest_id and c.status = 'open');
  select count(*) into v_divisions from public.event_competition_divisions d
  where d.program_id = v_program.id and d.status = 'open';

  update public.event_competition_contest_registration_rules r set registration_open = true, updated_at = now()
  where r.program_id = v_program.id and r.event_id = v_program.event_id and not r.registration_open
    and exists (select 1 from public.event_competition_contests c where c.id = r.contest_id and c.status = 'open');

  update public.event_competition_programs
  set registration_status = 'open', registration_opened_at = now(), updated_at = now()
  where id = v_program.id;

  return jsonb_build_object('program_id', v_program.id, 'registration_status', 'open',
    'open_categories', v_contests, 'open_divisions', v_divisions);
end;
$function$
;

-- ---------------------------------------------------------------------------
-- 5. Postflight
-- ---------------------------------------------------------------------------
do $$
begin
  if md5(pg_get_functiondef('public.open_competition_registration(uuid)'::regprocedure)) <> '040ed4e9444af229b40842ade65bf5e8' then
    raise exception 'Phase 10C.5 v3 postflight: open_competition_registration is not the generated definition.';
  end if;
  if position('These competition rules have been replaced. Reload the page and start the setup again.' in pg_get_functiondef('public.create_competition_draft(uuid,jsonb)'::regprocedure)) = 0 then
    raise exception 'Phase 10C.5 v3 postflight: create_competition_draft is not the generated definition.';
  end if;
  if has_function_privilege('anon', 'public.create_competition_draft(uuid, jsonb)', 'EXECUTE')
    or has_function_privilege('anon', 'public.can_edit_competition_event_operations(uuid)', 'EXECUTE')
    or has_function_privilege('anon', 'public.open_competition_registration(uuid)', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.create_competition_draft(uuid, jsonb)', 'EXECUTE') then
    raise exception 'Phase 10C.5 v3 postflight: function privileges are wrong.';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.events'::regclass and tgname = 'protect_competition_event_operations' and tgenabled = 'O') then
    raise exception 'Phase 10C.5 v3 postflight: the event operations guard is not in place.';
  end if;
  if not exists (select 1 from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 3 and status = 'active')
    or not exists (select 1 from public.competition_rules_profiles where profile_key = 'studio_simple' and version = 1 and status = 'active') then
    raise exception 'Phase 10C.5 v3 postflight: studio_simple@1 and @3 must be active.';
  end if;
end $$;
