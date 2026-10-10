// GENERATED studio_simple@2 (Studio / Custom Rules, schema 2) -- seeded by
// 20261113090000_phase10c5_competition_draft.sql. A vitest drift guard compares this with the migration; a
// profile version is immutable, so changing it means publishing studio_simple@3.
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
  "roundsNote": "Every division starts with a Final. DanceFlow can add preliminary rounds later if entry volume requires them.",
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
      "description": "Judges give formal results: placements, ratings or medals.",
      "judging_options": [
        "placements",
        "ratings"
      ],
      "default_judging": "placements"
    },
    "non_adjudicated": {
      "label": "Non-Adjudicated",
      "description": "An exhibition, showcase or participation event. Dancers perform; there is no formal competitive result.",
      "judging": "non_adjudicated"
    }
  },
  "judging": {
    "placements": {
      "label": "Placements",
      "description": "Judges rank the dancers in each division and the best-ranked dancer places first.",
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
      "label": "Ratings",
      "description": "Judges rate each performance, so every dancer can earn a rating instead of a place.",
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
      "description": "Dancers perform without formal judging or results.",
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
  "programs": {
    "country": {
      "label": "Country",
      "description": "Country partner dancing.",
      "purpose": "competition",
      "discipline_family": "country",
      "dance_pool": "country",
      "formats": [
        "pro_am",
        "pro_pro",
        "couples",
        "solo",
        "team"
      ],
      "recommended_formats": [
        "pro_am",
        "pro_pro",
        "couples"
      ],
      "recommended_dances": [
        "two_step",
        "waltz",
        "triple_two",
        "polka",
        "east_coast_swing",
        "nightclub",
        "cha_cha"
      ],
      "custom_dances": true
    },
    "west_coast_swing": {
      "label": "West Coast Swing",
      "description": "West Coast Swing contests.",
      "purpose": "competition",
      "discipline_family": "west_coast_swing",
      "dance_pool": "west_coast_swing",
      "formats": [
        "jack_and_jill",
        "couples",
        "pro_am",
        "showcase"
      ],
      "recommended_formats": [
        "jack_and_jill",
        "couples"
      ],
      "recommended_dances": [
        "west_coast_swing"
      ],
      "custom_dances": false
    },
    "ballroom": {
      "label": "Ballroom",
      "description": "Ballroom partner dancing.",
      "purpose": "competition",
      "discipline_family": "ballroom",
      "dance_pool": "ballroom",
      "formats": [
        "pro_am",
        "couples",
        "professional",
        "solo",
        "showcase"
      ],
      "recommended_formats": [
        "pro_am",
        "couples"
      ],
      "recommended_dances": [
        "smooth_waltz",
        "smooth_tango",
        "smooth_foxtrot",
        "rhythm_cha_cha",
        "rhythm_rumba",
        "rhythm_swing"
      ],
      "custom_dances": true
    },
    "custom": {
      "label": "Other / Studio-defined",
      "description": "A style you define.",
      "purpose": "competition",
      "discipline_family": "custom",
      "dance_pool": "general",
      "formats": [
        "pro_am",
        "pro_pro",
        "couples",
        "professional",
        "solo",
        "jack_and_jill",
        "team",
        "showcase"
      ],
      "recommended_formats": [
        "pro_am",
        "couples"
      ],
      "recommended_dances": [
        "waltz",
        "foxtrot",
        "cha_cha",
        "rumba",
        "swing",
        "two_step"
      ],
      "custom_dances": true
    },
    "showcase": {
      "label": "Showcase / Performance",
      "description": "Routines performed for an audience.",
      "purpose": "showcase",
      "discipline_family": "showcase",
      "dance_pool": "general",
      "formats": [
        "showcase",
        "solo",
        "team"
      ],
      "recommended_formats": [
        "showcase",
        "solo"
      ],
      "recommended_dances": [],
      "custom_dances": false,
      "adjudication": "non_adjudicated"
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
      "division_preset": "levels_newcomer_gold"
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
      "division_preset": "open"
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
      "division_preset": "levels_newcomer_gold"
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
      "division_preset": "open"
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
      "division_preset": "open"
    },
    "showcase": {
      "label": "Showcase routine",
      "description": "A routine performed alone or as a duo, with its own music.",
      "contest_type": "showdance",
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
      "division_preset": "open"
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
      "division_preset": "skill_levels"
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
      "division_preset": "open"
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
    "programs": 5,
    "categories": 8,
    "divisions": 30,
    "totalDivisions": 200,
    "dances": 20,
    "nameLength": 200,
    "maxPrice": 100000
  }
};
