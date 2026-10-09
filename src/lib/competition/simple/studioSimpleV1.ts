// GENERATED from the studio_simple@1 seed in 20261108090000_phase10b_competition_profiles.sql.
// A vitest drift guard compares this with the migration; edit both together (a profile version is immutable,
// so changing defaults means publishing studio_simple@2 instead).
import type { ProfileDefaults } from "./types";

export const STUDIO_SIMPLE_V1_DEFAULTS: ProfileDefaults = {
  "schema": 1,
  "label": "Studio Competition",
  "sanction": {
    "status": "none",
    "claimable": false
  },
  "roundsDefault": "final_only",
  "currency": "USD",
  "terminology": {
    "division_label": "Division",
    "skill_label": "Level",
    "age_label": "Age group",
    "partner_label": "Partner",
    "dance_label": "Dance"
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
    "callbacks": {
      "label": "Callbacks + Final",
      "description": "Judges call the best dancers back from a first round into the final. Best for large divisions.",
      "engine": {
        "key": "callback_tally",
        "version": 1
      },
      "competition_mode": "relative",
      "advancement_method": "promote_callback",
      "rounds": [
        {
          "round_type": "preliminary",
          "name": "Callback round",
          "scoring_method": "callback_tally"
        },
        {
          "round_type": "final",
          "name": "Final",
          "scoring_method": "ordinal_majority"
        }
      ]
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
      "pairing_mode": "fixed"
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
      "pairing_mode": "fixed"
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
      "pairing_mode": "individual"
    },
    "showcase": {
      "label": "Showcase",
      "description": "A routine performed for the audience, alone or as a duo.",
      "contest_type": "showdance",
      "entry_format": "custom",
      "uses_dances": false,
      "dance_selection_mode": "routine",
      "pricing_method": "flat_entry",
      "price_unit": "per entry",
      "minimum_participants": 1,
      "maximum_participants": 2,
      "pairing_mode": "fixed"
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
      "pairing_mode": "random_final_pair"
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
      "pairing_mode": "team"
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
  "presets": {
    "studio_competition": {
      "label": "Studio Competition",
      "description": "ProAm, couples, solo and group entries for your own students.",
      "discipline_family": "custom",
      "dance_pool": "general",
      "category_types": [
        "pro_am",
        "couples",
        "solo",
        "showcase",
        "jack_and_jill",
        "team"
      ],
      "default_categories": [
        "pro_am",
        "solo"
      ],
      "default_dances": [
        "waltz",
        "foxtrot",
        "cha_cha",
        "rumba"
      ],
      "default_judging": "placements",
      "division_preset": "levels_newcomer_gold"
    },
    "showcase": {
      "label": "Showcase",
      "description": "Performances for an audience, usually rated rather than ranked.",
      "discipline_family": "showcase",
      "dance_pool": "general",
      "category_types": [
        "solo",
        "showcase",
        "team"
      ],
      "default_categories": [
        "showcase"
      ],
      "default_dances": [],
      "default_judging": "ratings",
      "division_preset": "open"
    },
    "ballroom": {
      "label": "Ballroom",
      "description": "Smooth and rhythm dances for ProAm and couples.",
      "discipline_family": "ballroom",
      "dance_pool": "ballroom",
      "category_types": [
        "pro_am",
        "couples",
        "solo",
        "showcase"
      ],
      "default_categories": [
        "pro_am",
        "couples"
      ],
      "default_dances": [
        "smooth_waltz",
        "smooth_foxtrot",
        "rhythm_cha_cha",
        "rhythm_rumba"
      ],
      "default_judging": "placements",
      "division_preset": "levels_newcomer_gold"
    },
    "country": {
      "label": "Country",
      "description": "Country partner dances for ProAm, couples, solo and team entries.",
      "discipline_family": "country",
      "dance_pool": "country",
      "category_types": [
        "pro_am",
        "couples",
        "solo",
        "team"
      ],
      "default_categories": [
        "couples"
      ],
      "default_dances": [
        "two_step",
        "waltz",
        "cha_cha"
      ],
      "default_judging": "placements",
      "division_preset": "levels_basic"
    },
    "west_coast_swing": {
      "label": "West Coast Swing",
      "description": "Jack & Jill and partner swing entries.",
      "discipline_family": "west_coast_swing",
      "dance_pool": "west_coast_swing",
      "category_types": [
        "jack_and_jill",
        "couples",
        "pro_am",
        "showcase"
      ],
      "default_categories": [
        "jack_and_jill"
      ],
      "default_dances": [
        "west_coast_swing"
      ],
      "default_judging": "placements",
      "division_preset": "levels_basic"
    },
    "custom": {
      "label": "Custom",
      "description": "Start from a blank structure and choose everything yourself.",
      "discipline_family": "custom",
      "dance_pool": "general",
      "category_types": [
        "pro_am",
        "couples",
        "solo",
        "showcase",
        "jack_and_jill",
        "team"
      ],
      "default_categories": [
        "solo"
      ],
      "default_dances": [
        "waltz"
      ],
      "default_judging": "placements",
      "division_preset": "levels_basic"
    }
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
    }
  },
  "ageBands": [
    "Youth",
    "Adult",
    "Senior"
  ],
  "limits": {
    "categories": 6,
    "divisions": 60,
    "nameLength": 200,
    "maxPrice": 100000
  }
};
