-- HARNESS FIXTURE (disposable database only; NOT a migration; not yet executed).
-- Restores seed DATA lost because the baseline restores a schema-only dump.
-- Verbatim lines 114-221 of 20260620_competition_contests_and_templates_v1.sql (ballroom, country).
\set ON_ERROR_STOP on
insert into public.competition_configuration_templates (
  template_key,
  name,
  discipline_family,
  version,
  description,
  blueprint
)
values
(
  'ballroom_starter',
  'Ballroom Starter',
  'ballroom',
  1,
  'Editable ballroom category shells using neutral terminology.',
  '{
    "program": {
      "name": "Ballroom Competition",
      "competition_mode": "relative",
      "scoring_method": "skating",
      "advancement_method": "recall_count",
      "feedback_policy": "none",
      "rules_edition": "2026 Starter"
    },
    "dances": [
      {"key":"smooth_waltz","name":"Waltz","category":"American Smooth"},
      {"key":"smooth_tango","name":"Tango","category":"American Smooth"},
      {"key":"smooth_foxtrot","name":"Foxtrot","category":"American Smooth"},
      {"key":"smooth_viennese_waltz","name":"Viennese Waltz","category":"American Smooth"},
      {"key":"rhythm_cha_cha","name":"Cha Cha","category":"American Rhythm"},
      {"key":"rhythm_rumba","name":"Rumba","category":"American Rhythm"},
      {"key":"rhythm_swing","name":"Swing","category":"American Rhythm"},
      {"key":"rhythm_bolero","name":"Bolero","category":"American Rhythm"},
      {"key":"rhythm_mambo","name":"Mambo","category":"American Rhythm"},
      {"key":"ballroom_waltz","name":"Waltz","category":"International Ballroom"},
      {"key":"ballroom_tango","name":"Tango","category":"International Ballroom"},
      {"key":"ballroom_viennese_waltz","name":"Viennese Waltz","category":"International Ballroom"},
      {"key":"ballroom_foxtrot","name":"Foxtrot","category":"International Ballroom"},
      {"key":"ballroom_quickstep","name":"Quickstep","category":"International Ballroom"},
      {"key":"latin_cha_cha","name":"Cha Cha","category":"International Latin"},
      {"key":"latin_samba","name":"Samba","category":"International Latin"},
      {"key":"latin_rumba","name":"Rumba","category":"International Latin"},
      {"key":"latin_paso_doble","name":"Paso Doble","category":"International Latin"},
      {"key":"latin_jive","name":"Jive","category":"International Latin"},
      {"key":"showdance","name":"Showdance","category":"Performance"},
      {"key":"formation","name":"Formation Routine","category":"Performance"}
    ],
    "contests": [
      {"name":"American Smooth Single Dances","type":"single_dance","entry_format":"pro_am","dance_keys":["smooth_waltz","smooth_tango","smooth_foxtrot","smooth_viennese_waltz"]},
      {"name":"American Rhythm Single Dances","type":"single_dance","entry_format":"pro_am","dance_keys":["rhythm_cha_cha","rhythm_rumba","rhythm_swing","rhythm_bolero","rhythm_mambo"]},
      {"name":"International Ballroom Single Dances","type":"single_dance","entry_format":"pro_am","dance_keys":["ballroom_waltz","ballroom_tango","ballroom_viennese_waltz","ballroom_foxtrot","ballroom_quickstep"]},
      {"name":"International Latin Single Dances","type":"single_dance","entry_format":"pro_am","dance_keys":["latin_cha_cha","latin_samba","latin_rumba","latin_paso_doble","latin_jive"]},
      {"name":"Multi-Dance Championship","type":"multi_dance","entry_format":"couple","dance_keys":[]},
      {"name":"Scholarship","type":"scholarship","entry_format":"pro_am","dance_keys":[]},
      {"name":"Showdance / Cabaret","type":"showdance","entry_format":"couple","dance_keys":["showdance"]},
      {"name":"Formation","type":"formation","entry_format":"team","dance_keys":["formation"]}
    ]
  }'::jsonb
),
(
  'country_starter',
  'Country Starter',
  'country',
  1,
  'Editable country category shells using neutral terminology.',
  '{
    "program": {
      "name": "Country Competition",
      "competition_mode": "relative",
      "scoring_method": "majority_rules",
      "advancement_method": "promote_callback",
      "feedback_policy": "none",
      "rules_edition": "2026-2028 Starter"
    },
    "dances": [
      {"key":"two_step","name":"Two Step","category":"Partner"},
      {"key":"waltz","name":"Waltz","category":"Partner"},
      {"key":"triple_two","name":"Triple Two","category":"Partner"},
      {"key":"polka","name":"Polka","category":"Partner"},
      {"key":"east_coast_swing","name":"East Coast Swing","category":"Partner"},
      {"key":"west_coast_swing","name":"West Coast Swing","category":"Partner"},
      {"key":"nightclub","name":"Nightclub","category":"Partner"},
      {"key":"cha_cha","name":"Cha Cha","category":"Partner"},
      {"key":"solo_medley","name":"Solo Medley","category":"Showcase"},
      {"key":"line_routine","name":"Line Dance Routine","category":"Line Dance"},
      {"key":"team_routine","name":"Team Routine","category":"Team"},
      {"key":"spotlight","name":"Spotlight Routine","category":"Spotlight"}
    ],
    "contests": [
      {"name":"ProAm / ProPro Classic","type":"multi_dance","entry_format":"pro_am","dance_keys":["two_step","waltz","triple_two","polka","east_coast_swing","west_coast_swing","nightclub","cha_cha"]},
      {"name":"Couples Classic","type":"multi_dance","entry_format":"couple","dance_keys":["two_step","waltz","triple_two","polka","east_coast_swing","west_coast_swing","nightclub","cha_cha"]},
      {"name":"Line Dance","type":"line_dance","entry_format":"solo","dance_keys":["line_routine"]},
      {"name":"Teams","type":"team","entry_format":"team","dance_keys":["team_routine"]},
      {"name":"Spotlight","type":"spotlight","entry_format":"pro_am","dance_keys":["spotlight"]},
      {"name":"Showcase","type":"showdance","entry_format":"couple","dance_keys":["two_step","waltz","solo_medley"]},
      {"name":"Jack and Jill","type":"jack_and_jill","entry_format":"random_partner","dance_keys":["two_step","west_coast_swing"]},
      {"name":"Strictly","type":"strictly","entry_format":"couple","dance_keys":["two_step","west_coast_swing"]}
    ]
  }'::jsonb
)
on conflict (template_key, version)
do update set
  name = excluded.name,
  discipline_family = excluded.discipline_family,
  description = excluded.description,
  blueprint = excluded.blueprint,
  status = 'active',
  updated_at = now();
