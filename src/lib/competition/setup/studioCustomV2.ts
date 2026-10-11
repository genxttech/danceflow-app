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
      },
      "division_schemes": {
        "jack_and_jill": "wcs_contests",
        "couples": "wcs_contests",
        "pro_am": "wcs_contests",
        "routine": "open_only"
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
      },
      "division_schemes": {
        "pro_am": "ballroom_proam",
        "couples": "ballroom_amateur",
        "professional": "open_only",
        "showdance": "open_only",
        "solo": "open_only"
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
      },
      "division_schemes": {
        "pro_am": "studio_generic",
        "pro_pro": "studio_generic",
        "couples": "studio_generic",
        "professional": "studio_generic",
        "jack_and_jill": "studio_generic",
        "custom_routine": "open_only",
        "solo": "open_only",
        "team": "open_only"
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
          "recommended": [
            "newcomer",
            "novice",
            "intermediate",
            "advanced",
            "open"
          ],
          "defaults": [
            "newcomer",
            "novice",
            "intermediate",
            "advanced",
            "open"
          ],
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
          "recommended": [
            "open",
            "crystal",
            "diamond",
            "silver",
            "gold",
            "platinum",
            "pearl"
          ],
          "defaults": [
            "open"
          ],
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
          "recommended": [
            "propro_ii",
            "propro_i"
          ],
          "defaults": [
            "propro_ii",
            "propro_i"
          ],
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
          "recommended": [
            "open",
            "crystal",
            "diamond",
            "silver",
            "gold",
            "platinum",
            "pearl"
          ],
          "defaults": [
            "open"
          ],
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
          "recommended": [
            "newcomer",
            "novice",
            "intermediate",
            "advanced",
            "open"
          ],
          "defaults": [
            "newcomer",
            "novice",
            "intermediate",
            "advanced",
            "open"
          ],
          "allow_custom": true,
          "note": "Studio levels by default; the UCWDC Couples ladder (Newcomer IV–I, Classic III–I) is under More options."
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
          "recommended": [
            "open",
            "crystal",
            "diamond",
            "silver",
            "gold",
            "platinum"
          ],
          "defaults": [
            "open"
          ],
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
          "recommended": [
            "open",
            "crystal",
            "diamond",
            "silver",
            "gold",
            "platinum",
            "pearl"
          ],
          "defaults": [
            "open"
          ],
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
          "recommended": [
            "newcomer",
            "novice",
            "intermediate",
            "advanced",
            "all_star",
            "champion"
          ],
          "defaults": [
            "newcomer",
            "novice",
            "intermediate",
            "advanced"
          ],
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
          "recommended": [
            "juniors",
            "sophisticated",
            "masters"
          ],
          "defaults": [],
          "allow_custom": true,
          "note": "Optional age-based contests, open to all skill levels."
        }
      ]
    },
    "ballroom_proam": {
      "label": "Ballroom ProAm",
      "combination": "cross",
      "note": "NDCA lets organizers offer any or all of its Pro/Am levels and age categories; it defines no universal division list.",
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
              "key": "open",
              "label": "Open",
              "basis": "studio_recommendation",
              "name_label": "Open Level",
              "eligibility": {
                "note": "Studio / Custom open skill level. UCWDC uses Open only as an age division, not a ProAm skill level."
              }
            }
          ],
          "recommended": [
            "newcomer",
            "bronze",
            "silver",
            "gold",
            "open"
          ],
          "defaults": [
            "bronze",
            "silver",
            "gold"
          ],
          "allow_custom": true
        },
        {
          "key": "age_group",
          "label": "Age divisions",
          "values": [
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
          "recommended": [
            "a",
            "b",
            "c",
            "s1",
            "s2",
            "s3",
            "s4"
          ],
          "defaults": [],
          "allow_custom": true,
          "note": "Optional; whose age counts is NOT SPECIFIED IN PROVIDED SOURCE."
        }
      ]
    },
    "ballroom_amateur": {
      "label": "Ballroom amateur couples",
      "combination": "cross",
      "axes": [
        {
          "key": "skill_level",
          "label": "Levels",
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
                  "section": "X.B",
                  "page": "43"
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
                  "section": "X.B",
                  "page": "43"
                }
              ]
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
          "recommended": [
            "bronze",
            "silver",
            "gold",
            "open"
          ],
          "defaults": [
            "bronze",
            "silver",
            "gold"
          ],
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
                  "section": "X.A",
                  "page": "42-43"
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
                  "section": "X.A",
                  "page": "42-43"
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
                  "section": "X.A",
                  "page": "42-43"
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
                  "section": "X.A",
                  "page": "42-43"
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
                  "section": "X.A",
                  "page": "42-43"
                }
              ],
              "eligibility": {
                "min_age": 16,
                "under_age": 19
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
                  "section": "X.A",
                  "page": "42-43"
                }
              ],
              "eligibility": {
                "note": "At least one partner 16+, neither 21."
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
                  "section": "X.A",
                  "page": "42-43"
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
                  "section": "X.A",
                  "page": "42-43"
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
                  "section": "X.A",
                  "page": "42-43"
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
                  "section": "X.A",
                  "page": "42-43"
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
                  "section": "X.A",
                  "page": "42-43"
                }
              ],
              "eligibility": {
                "min_age": 65,
                "note": "One partner 65+, the other 60+."
              }
            }
          ],
          "recommended": [
            "adult",
            "senior_i",
            "senior_ii",
            "senior_iii",
            "senior_iv"
          ],
          "defaults": [],
          "allow_custom": true,
          "note": "Optional."
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
          "recommended": [
            "newcomer",
            "novice",
            "intermediate",
            "advanced",
            "open"
          ],
          "defaults": [
            "newcomer",
            "novice",
            "intermediate",
            "advanced"
          ],
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
          "recommended": [
            "youth",
            "adult",
            "senior"
          ],
          "defaults": [],
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
          "recommended": [
            "open"
          ],
          "defaults": [
            "open"
          ],
          "allow_custom": true
        }
      ]
    }
  },
  "limits": {
    "programs": 4,
    "categories": 8,
    "divisions": 80,
    "totalDivisions": 300,
    "dances": 20,
    "nameLength": 200,
    "maxPrice": 100000
  }
};
