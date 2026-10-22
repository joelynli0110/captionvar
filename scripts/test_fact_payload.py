"""No local model or SDK needed to validate event-to-prompt grounding."""
import json
import unittest
from pathlib import Path
from generate_local_drafts import ROOT, build_observed_facts, make_prompt


class SyntheticFactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.s = json.loads((ROOT / 'src/data/scenarios.json').read_text(encoding='utf-8'))

    def test_two_successful_passes_are_not_possession(self):
        fact = build_observed_facts(self.s[0])
        self.assertEqual(len(fact['recorded_passes']), 2)
        self.assertTrue(all(x['completed'] for x in fact['recorded_passes']))
        self.assertNotIn('dominating', make_prompt(fact).lower().split('observations:')[-1])

    def test_high_recovery_counts_are_from_events(self):
        fact = build_observed_facts(self.s[1])
        self.assertEqual(fact['attacking_third_recoveries_by_team']['Northbridge FC'], 3)
        self.assertFalse(fact['pressing_actions_recorded'])

    def test_missing_xg_remains_unavailable(self):
        fact = build_observed_facts(self.s[2])
        self.assertEqual(fact['recorded_shots'][0]['xg'], 'UNAVAILABLE')
        self.assertNotIn('0.82', json.dumps(fact))

    def test_model_case_is_not_automatically_causal(self):
        fact = build_observed_facts(self.s[3])
        self.assertEqual(fact['attacking_third_recoveries_by_team']['Riverside United'], 1)
        self.assertFalse(fact['pressing_actions_recorded'])


if __name__ == '__main__':
    unittest.main()
