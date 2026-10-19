"""python -m unittest discover -s analysis/predictability/tests"""
import random
import sys
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import prep  # noqa: E402
import run  # noqa: E402


def synthetic_season(seed=1, teams=30, weeks=8):
    """CFBD-shaped plays. 'Robot' always passes on passing downs and runs
    otherwise; 'Coin' flips a coin; everyone else follows a league-like
    tendency with its own pass rate."""
    rng = random.Random(seed)
    names = ["Robot", "Coin"] + [f"Team {k}" for k in range(teams - 2)]
    lean = {n: rng.gauss(0, 0.4) for n in names}
    plays, pid = [], 0

    def call(team, down, dist, prev):
        passing = (down == 2 and dist >= 8) or (down >= 3 and dist >= 5)
        if team == "Robot":
            return passing
        if team == "Coin":
            return rng.random() < 0.5
        z = -0.4 + lean[team] + 2.0 * passing - 0.8 * (down == 1) + (0.5 if prev == "pass" else 0)
        return rng.random() < 1 / (1 + np.exp(-z))

    for week in range(1, weeks + 1):
        order = names[:]
        rng.shuffle(order)
        for h, a in zip(order[::2], order[1::2]):
            gid = f"{week}-{h}-{a}"
            score = {h: 0, a: 0}
            for dn in range(1, 25):
                off = h if dn % 2 else a
                de = a if off == h else h
                period = min(4, 1 + (dn - 1) // 6)
                down, dist, ytg, prev = 1, 10, rng.randint(50, 80), None
                for pn in range(1, 13):
                    is_pass = call(off, down, dist, prev)
                    gain = int(rng.gauss(7, 9)) if is_pass and rng.random() < 0.6 else (0 if is_pass else int(rng.gauss(4, 4)))
                    kind = ("Pass Reception" if gain else "Pass Incompletion") if is_pass else "Rush"
                    pid += 1
                    plays.append({"id": pid, "gameId": gid, "week": week, "driveId": f"{gid}-{dn}", "driveNumber": dn,
                                  "playNumber": pn, "offense": off, "defense": de, "home": h,
                                  "offenseScore": score[off], "defenseScore": score[de], "period": period,
                                  "clock": {"minutes": 14 - (dn - 1) % 6 * 2, "seconds": 0}, "offenseTimeouts": 3,
                                  "defenseTimeouts": 3, "yardsToGoal": ytg, "down": down, "distance": dist,
                                  "yardsGained": gain, "playType": kind, "playText": "", "ppa": gain / 10 - 0.3})
                    prev = "pass" if is_pass else "rush"
                    ytg -= gain
                    if ytg <= 0:
                        score[off] += 7
                        break
                    if gain >= dist:
                        down, dist = 1, min(10, ytg)
                    elif down == 4:
                        break
                    else:
                        down, dist = down + 1, dist - gain
    return plays, names


class Classify(unittest.TestCase):
    def test_calls(self):
        self.assertEqual(prep.classify("Rush", "J. Smith scrambles for 8 yds"), "pass")
        self.assertEqual(prep.classify("Rush", "J. Smith run for 3 yds"), "rush")
        self.assertIsNone(prep.classify("Rush", "QB kneels for -1 yd"))
        self.assertIsNone(prep.classify("Pass Incompletion", "QB spikes the ball"))
        self.assertEqual(prep.classify("Sack", "QB sacked by X for -7"), "pass")
        self.assertEqual(prep.classify("Fumble Recovery (Opponent)", "QB pass complete to Y, fumbled"), "pass")
        self.assertEqual(prep.classify("Fumble Recovery (Own)", "RB run for 2 yds, fumbled"), "rush")
        self.assertIsNone(prep.classify("Penalty", "False start"))
        self.assertIsNone(prep.classify("Punt", "punt for 40 yds"))

    def test_garbage_time(self):
        self.assertTrue(prep.is_garbage(4, 22))
        self.assertFalse(prep.is_garbage(4, 21))
        self.assertFalse(prep.is_garbage(1, 40))


class Playcallers(unittest.TestCase):
    def test_stints_split_at_week_and_period(self):
        df = pd.DataFrame({"offense": ["Cal"] * 4 + ["Other"], "week": [4, 5, 5, 6, 5], "period": [2, 2, 3, 1, 3]})
        callers = pd.DataFrame({"team": ["Cal", "Cal"], "season": [2026, 2026], "week": [1, 5], "period": [1, 3],
                                "caller": ["A", "B"], "source": ["", ""]})
        out = prep.assign_playcallers(df, callers, 2026)
        self.assertEqual(out["entity"].tolist(), ["Cal (A)", "Cal (A)", "Cal (B)", "Cal (B)", "Other"])


class EndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        plays, names = synthetic_season()
        cls.df, cls.rep, cls.params = run.analyze(plays, names, 2026, log=lambda *a: None)

    def test_previous_call_is_on_the_same_drive(self):
        first = self.df.groupby("drive_id").head(1)
        self.assertTrue((first["prev_type"] == 0).all())

    def test_ranks_the_scripted_team_first_and_the_coin_last(self):
        r = self.rep[self.rep["ranked"]]
        self.assertEqual(r.iloc[0]["team"], "Robot")
        self.assertEqual(r.iloc[-1]["team"], "Coin")
        self.assertGreater(r.iloc[0]["called_right"], 0.95)
        self.assertLess(abs(r.iloc[-1]["called_right"] - 0.5), 0.08)
        self.assertLess(abs(r.iloc[-1]["predictability"]), 6)

    def test_scoring_uses_only_earlier_games(self):
        robot = self.rep[self.rep["team"] == "Robot"].iloc[0]
        self.assertLess(robot["games_scored"], robot["games"])

    def test_summary_renders(self):
        md = run.summary(self.df, self.rep, 2026, self.params)
        self.assertIn("| 1 | Robot |", md)


if __name__ == "__main__":
    unittest.main()
