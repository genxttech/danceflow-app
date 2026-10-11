// GENERATED studio_simple@2 (Studio / Custom Rules, schema 2) -- seeded by
// 20261113090000_phase10c5_competition_draft.sql. A vitest drift guard compares this with the migration; a
// profile version is immutable once released, so changing it after release means publishing studio_simple@3.
import type { SetupProfileDefaults } from "./types";

export const STUDIO_CUSTOM_PROFILE = { key: "studio_simple", version: 2 } as const;

export const STUDIO_CUSTOM_V2_DEFAULTS: SetupProfileDefaults = {
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
        "ndca_amateur",
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
          "dances": [],
          "allow_custom_dances": true,
          "basis": "source_grounded",
          "sources": [
            {
              "document": "NDCA Rule Book",
              "edition": "June 2026 (compiled)",
              "section": "IX.A.1.e",
              "page": "38-39"
            }
          ],
          "note": "Add the additional American style dances you will offer; NDCA does not list them."
        }
      ],
      "offering_groups": [
        {
          "label": "Partnerships",
          "formats": [
            "ndca_pro_am",
            "ndca_amateur",
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
        "ndca_amateur": "ballroom_amateur",
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
      "label": "Pro/Am",
      "description": "A registered professional dances with their registered Pro/Am Student Competitor.",
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
        }
      ]
    },
    "ndca_amateur": {
      "label": "Amateur",
      "description": "Two registered amateur dancers compete together.",
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
      "eligibility_note": "Both partners must be eligible for the proficiency entered; a couple's age is the older partner's (Pre-Teen to Adult) or the younger partner's (Senior). Amateurs may enter at most two consecutive proficiency levels.",
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
      "label": "NDCA Pro/Am",
      "combination": "cross",
      "note": "NDCA lets organizers offer any or all Pro/Am levels (II.B.7.c). A–S4 are the Pro/Am Multi-Dance age categories (II.B.7.f); youth Pro/Am uses the amateur ages (II.B.8.a).",
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
          "required": false,
          "allow_custom": true,
          "note": "Optional. A–S4 are stated for Pro/Am Multi-Dance events; ages for single-dance events are NOT SPECIFIED IN PROVIDED SOURCE."
        }
      ]
    },
    "ballroom_amateur": {
      "label": "NDCA Amateur",
      "combination": "cross",
      "note": "A division is a proficiency level in an age category, e.g. Silver · Adult (NDCA X).",
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
              ]
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
              ]
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
              ]
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
    "nameLength": 200,
    "maxPrice": 100000
  }
};
