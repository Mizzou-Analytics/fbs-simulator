# Play-call predictability

This ranks FBS offenses by how predictable their run/pass calls are, using CollegeFootballData play-by-play. It is separate from the simulator site.

## Running it

From the Actions tab, run **Play-call predictability** and choose the season. The run uses about 18 CFBD calls. Results appear in two places:

- **The job summary:** the ranking table.
- **The `predictability-<season>` artifact:**
  - `predictability-<season>.csv`, with every column below;
  - `summary.md`;
  - the downloaded plays, `plays-<season>.json.gz`.

To run it locally:

```sh
pip install -r analysis/predictability/requirements.txt
CFBD_API_KEY=your-key python analysis/predictability/run.py --season 2026 --out out
python analysis/predictability/run.py --season 2026 --out out --plays out/plays-2026.json.gz   # reuse the download
python -m unittest discover -s analysis/predictability/tests
```

## What counts as a call

Each run or pass play from scrimmage by an FBS offense counts as one call.

- **Counted as passes:** sacks, plus scrambles the play description identifies.
- **Fumbles and safeties:** classified from the play description.
- **Dropped:** kneels, spikes, penalties that wipe out the play, special teams, two-point tries, and garbage time. Garbage time follows CFBD's rule: a margin over 43 points in the first quarter, 37 in the second, 27 in the third or 21 in the fourth.

The play-by-play records what happened, not what was called. A handed-off RPO counts as a run, and a scramble the description doesn't mention counts as a run.

## The model

1. **League model.** Gradient boosting gives the chance of a pass from:
   - down, distance and field position;
   - score margin, quarter and time left;
   - timeouts and home field;
   - the previous call on the drive and how many yards it gained.

   Each team's plays are predicted by a version trained without that team, so the league model never memorizes the team it is scoring.
2. **Team model.** It adjusts the league chance for the team's own pass rate and for its habits in eight situations:
   - passing downs;
   - short yardage;
   - the red zone;
   - leading or trailing by 9 or more;
   - the play after a pass;
   - the first play of a drive;
   - the last two minutes of a half.

   The adjustments are shrunk toward zero (ridge penalties, tuned for out-of-sample accuracy), so a handful of plays can't define a team.
3. **Scoring.** The scoring runs in order through the season, like a defense studying film. Each game is predicted from the team's earlier games only. A team's games start counting once it has 150 calls behind it, and a team needs 150 scored calls to be ranked.

## The columns

| Column | Meaning |
| --- | --- |
| `predictability` | 100 × (1 − bits of surprise per call). 0 is a coin flip, 100 would be perfectly predictable. Teams are ranked by it. |
| `called_right` | How often the model's guess (pass at 50% or more) matched the call |
| `called_right_pass_rate_only` | The same, for a guess that knows only the team's pass rate |
| `bits_per_call`, `bits_se` | Out-of-sample log loss in bits, and its standard error |
| `bits_situation_only` | Log loss with the league model and the team's pass rate, but no team habits |
| `bits_pass_rate_only` | Log loss knowing only the team's pass rate |
| `pass_rate`, `pass_over_expected` | Pass rate, and how far it is above or below what the league would do in the same situations |
| `epa_per_call` | CFBD's expected points added per call |
| `obvious_share`, `epa_followed_obvious`, `epa_broke_obvious` | Share of calls where the model was at least 70% sure, and EPA per call when the offense did or didn't do the expected thing |
| `tendency` | The situation where the team's pass rate differs most from the league's, shrunk for small samples |

`bits_pass_rate_only` minus `bits_situation_only` is how much situation explains. `bits_situation_only` minus `bits_per_call` is how much the team's own habits add.

## Play-caller changes

CFBD lists head coaches but not coordinators or play-callers. `playcallers.csv` records play-calling changes by hand.

- Each row starts a stint for a team and season at a week and quarter.
- The team's plays from that point go to "Team (Caller)" until the next row.
- Plays before a team's first row go to the first row's caller.
- Teams without rows are scored as a whole.

Add a row whenever a change is announced. The `source` column is for a link that confirms it.

The current rows:

- **California:** Pat McCann took over from Jordan Somerville at halftime of Week 5 at UNLV.
- **Arizona State:** Marcus Arroyo took over from Kenny Dillingham starting in Week 6.

A stint needs 150 scored calls before it is ranked, so a recent change shows up in the unranked list until it has enough games.
