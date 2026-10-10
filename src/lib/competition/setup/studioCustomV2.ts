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
      "recommended_formats": [
        "pro_am",
        "pro_pro",
        "couples"
      ],
      "recommended_special": [
        "showcase",
        "spotlight"
      ],
      "recommended_dances": [
        "triple_two",
        "nightclub",
        "waltz",
        "polka",
        "cha_cha",
        "east_coast_swing",
        "two_step"
      ],
      "custom_dances": true,
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
      }
    },
    "west_coast_swing": {
      "label": "West Coast Swing",
      "description": "West Coast Swing contests.",
      "discipline_family": "west_coast_swing",
      "dance_pool": "west_coast_swing",
      "formats": [
        "jack_and_jill",
        "couples",
        "pro_am",
        "routine"
      ],
      "recommended_formats": [
        "jack_and_jill",
        "couples"
      ],
      "recommended_special": [
        "routine"
      ],
      "recommended_dances": [
        "west_coast_swing"
      ],
      "custom_dances": false,
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
      }
    },
    "ballroom": {
      "label": "Ballroom",
      "description": "Ballroom partner dancing.",
      "discipline_family": "ballroom",
      "dance_pool": "ballroom",
      "formats": [
        "pro_am",
        "couples",
        "professional",
        "showdance",
        "solo"
      ],
      "recommended_formats": [
        "pro_am",
        "couples"
      ],
      "recommended_special": [
        "showdance"
      ],
      "recommended_dances": [
        "smooth_waltz",
        "smooth_tango",
        "smooth_foxtrot",
        "rhythm_cha_cha",
        "rhythm_rumba",
        "rhythm_swing"
      ],
      "custom_dances": true,
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
              "section": "IX.A.1.c-d",
              "page": "38-39",
              "quote": "American Style Smooth. Waltz, Tango, Foxtrot, Viennese Waltz"
            }
          ],
          "note": "NDCA also recommends ProAm single dances finish one level's sequence before the next level (IX.A.1.h)."
        },
        "style_blocks": {
          "value": [
            {
              "key": "american_smooth",
              "label": "American Smooth",
              "dance_category": "American Smooth",
              "dances": [
                "smooth_waltz",
                "smooth_tango",
                "smooth_foxtrot",
                "smooth_viennese_waltz"
              ]
            },
            {
              "key": "american_rhythm",
              "label": "American Rhythm",
              "dance_category": "American Rhythm",
              "dances": [
                "rhythm_cha_cha",
                "rhythm_rumba",
                "rhythm_swing",
                "rhythm_bolero",
                "rhythm_mambo"
              ]
            },
            {
              "key": "international_standard",
              "label": "International Standard",
              "dance_category": null
            },
            {
              "key": "international_latin",
              "label": "International Latin",
              "dance_category": null
            }
          ],
          "basis": "owner_operational"
        },
        "special_boundary": {
          "value": "style",
          "basis": "owner_operational",
          "note": "Showcase / Showdance numbers run after a style block, before the next major block."
        }
      }
    },
    "custom": {
      "label": "Other / Studio-defined",
      "description": "A style you define.",
      "discipline_family": "custom",
      "dance_pool": "general",
      "formats": [
        "pro_am",
        "pro_pro",
        "couples",
        "professional",
        "jack_and_jill",
        "custom_routine",
        "solo",
        "team"
      ],
      "recommended_formats": [
        "pro_am",
        "couples"
      ],
      "recommended_special": [
        "custom_routine"
      ],
      "recommended_dances": [
        "waltz",
        "foxtrot",
        "cha_cha",
        "rumba",
        "swing",
        "two_step"
      ],
      "custom_dances": true,
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
      "division_preset": "levels_newcomer_gold",
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
      "adjudication_override": false
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
      "division_preset": "open",
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
      "adjudication_override": false
    },
    "couples": {
      "label": "Couples",
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
      "division_preset": "levels_newcomer_gold",
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
      "adjudication_override": false
    },
    "professional": {
      "label": "Professional",
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
      "division_preset": "open",
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
      "adjudication_override": false
    },
    "jack_and_jill": {
      "label": "Jack & Jill",
      "description": "Dancers enter alone and are paired with a random partner.",
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
      "division_preset": "skill_levels",
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
      "adjudication_override": false
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
      "division_preset": "open",
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
      "division_preset": "open",
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
      "adjudication_override": true,
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
    "showdance": {
      "label": "Showcase / Showdance",
      "description": "A choreographed routine to music the dancers choose.",
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
      "division_preset": "open",
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
      "adjudication_override": true
    },
    "routine": {
      "label": "Routine / Showcase",
      "description": "A choreographed couple's routine to music the dancers choose.",
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
      "division_preset": "open",
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
      "adjudication_override": true
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
      "division_preset": "open",
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
      "organizer_configurable": [
        "label",
        "music_source",
        "duration",
        "adjudication",
        "floor_mode",
        "program_placement"
      ]
    },
    "solo": {
      "label": "Solo",
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
      "division_preset": "open",
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
      "adjudication_override": false
    },
    "team": {
      "label": "Team",
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
      "division_preset": "open",
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
      "adjudication_override": false
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
  "divisionPresets": {
    "levels_newcomer_gold": {
      "label": "Newcomer, Bronze, Silver, Gold",
      "levels": [
        "Newcomer",
        "Bronze",
        "Silver",
        "Gold"
      ]
    },
    "levels_basic": {
      "label": "Beginner, Intermediate, Advanced",
      "levels": [
        "Beginner",
        "Intermediate",
        "Advanced"
      ]
    },
    "open": {
      "label": "One open division",
      "levels": [
        "Open"
      ]
    },
    "skill_levels": {
      "label": "Newcomer, Novice, Intermediate, Advanced",
      "levels": [
        "Newcomer",
        "Novice",
        "Intermediate",
        "Advanced"
      ]
    }
  },
  "ageBands": [
    "Youth",
    "Adult",
    "Senior"
  ],
  "limits": {
    "programs": 4,
    "categories": 8,
    "divisions": 30,
    "totalDivisions": 200,
    "dances": 20,
    "nameLength": 200,
    "maxPrice": 100000
  }
};
