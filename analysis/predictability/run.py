"""Ranks FBS offenses by how predictable their run/pass calls are.

    CFBD_API_KEY=... python analysis/predictability/run.py --season 2026 --out out/

Writes predictability-<season>.csv, summary.md and (unless --plays is given)
plays-<season>.json.gz, which --plays can reuse without calling the API.
"""
import argparse
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import fetch  # noqa: E402
import model  # noqa: E402
import prep  # noqa: E402


def analyze(raw, teams, season, callers=None, log=print, diagnose=False, mode="loo"):
    if diagnose:
        table, scrambles = prep.diagnostics(raw)
        log("Play types and how they were classified:")
        log(table.to_string())
        log(f"Rushes relabeled as passes (scrambles): {scrambles:,}")
    df = prep.prepare(raw, teams)
    df = prep.assign_playcallers(df, callers, season)
    log(f"{len(df):,} run/pass calls by {df['offense'].nunique()} FBS offenses")
    off = model.baseline_offsets(df)
    lam0, lam1 = model.tune(df, off, mode=mode)
    log(f"shrinkage: team rate {lam0}, situations {lam1}")
    full, sit, null = model.rolling(df, off, lam0, lam1, mode=mode)
    return df, model.report(df, off, full, sit, null), {"lam0": lam0, "lam1": lam1, "mode": mode}


def _pct(x, d=0):
    return "" if pd.isna(x) else f"{x * 100:.{d}f}%"


def _signed(x, scale=100, d=0):
    return "" if pd.isna(x) else f"{x * scale:+.{d}f}".replace("-", "−")


def summary(df, rep, season, params):
    r = rep[rep["ranked"]]
    lines = [f"# Play-call predictability, {season}", ""]
    if not len(r):
        return "\n".join(lines + ["Not enough games yet to score any team."])
    weeks = int(df.loc[df["week"] < 99, "week"].max())
    rho = spearmanr(r["predictability"], r["epa_per_call"]).statistic if len(r) > 2 else np.nan
    lines += [
        f"Through week {weeks}: {len(df):,} run/pass calls, {len(r)} offenses ranked. "
        + ("Each game is predicted only from the team's earlier games, like a defense studying film."
           if params.get("mode") == "rolling" else "Each game is predicted from the team's other games, never from itself."),
        "",
        "- **Predictability** is 100 × (1 − bits of surprise per call). 0 is a coin flip, 100 would be perfectly "
        "predictable. Teams are ranked by it. A lopsided run/pass mix alone makes a team predictable.",
        "- **Beyond pass rate** is the part that comes from situation and habit: how many points of predictability "
        "the model adds over a guess that knows only the team's pass rate.",
        "- **Called right** is how often the model's guess (pass if its chance is 50% or more) matched the call. "
        "**Rate alone** is the same for a guess that only knows the team's pass rate.",
        "- **Pass over expected** is how much more often the team passes than the league would in the same "
        "situations.",
        f"- Across ranked teams, the rank correlation between predictability and EPA per call is {rho:+.2f}.",
        "",
        "| Rank | Team | Predictability | Beyond pass rate | Called right | Rate alone | Pass rate | Pass over expected | EPA/call | Calls scored | Biggest tendency |",
        "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for _, x in r.iterrows():
        lines.append(f"| {int(x['rank'])} | {x['team']} | {x['predictability']:.1f} | {x['beyond_pass_rate']:.1f} | {_pct(x['called_right'])} | "
                     f"{_pct(x['called_right_pass_rate_only'])} | {_pct(x['pass_rate'])} | "
                     f"{_signed(x['pass_over_expected'])} | {_signed(x['epa_per_call'], 1, 2)} | {int(x['calls_scored'])} | "
                     f"{x['tendency']} |")
    un = rep[~rep["ranked"]]
    if len(un):
        lines += ["", f"Not ranked (fewer than {model.MIN_RANK} calls scored): "
                  + ", ".join(f"{t} ({int(n)})" for t, n in zip(un["team"], un["calls_scored"])) + "."]
    ob = r.dropna(subset=["epa_followed_obvious", "epa_broke_obvious"])
    if len(ob):
        w = ob["obvious_calls"] - ob["broke_obvious"]
        lines += ["", "**Obvious situations** (the model is at least 70% sure): across ranked teams, EPA per call was "
                  f"{_signed(np.average(ob['epa_followed_obvious'], weights=w), 1, 2)} when the offense did the expected thing and "
                  f"{_signed(np.average(ob['epa_broke_obvious'], weights=ob['broke_obvious']), 1, 2)} when it broke tendency."]
    lines += ["", f"Model: league situation model (gradient boosting, trained without each team), plus per-team "
              f"adjustments shrunk with ridge penalties {params['lam0']} (team rate) and {params['lam1']} "
              "(situations), tuned for out-of-sample accuracy."]
    return "\n".join(lines) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--out", default="out")
    ap.add_argument("--plays", help="reuse a plays-<season>.json.gz from an earlier run instead of calling CFBD")
    ap.add_argument("--playcallers", default=str(HERE / "playcallers.csv"))
    ap.add_argument("--mode", choices=["loo", "rolling"], default="loo",
                    help="score each game from the team's other games (loo) or earlier games only (rolling)")
    a = ap.parse_args(argv)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if a.plays:
        data = fetch.load(a.plays)
    else:
        key = os.environ.get("CFBD_API_KEY")
        if not key:
            sys.exit("Set CFBD_API_KEY, or pass --plays.")
        print(f"Downloading {a.season} plays from CFBD")
        data = fetch.season(a.season, key)
        fetch.save(data, out / f"plays-{a.season}.json.gz")
    callers = pd.read_csv(a.playcallers) if a.playcallers and Path(a.playcallers).exists() else None
    df, rep, params = analyze(data["plays"], data.get("teams"), a.season, callers, diagnose=True, mode=a.mode)
    rep.to_csv(out / f"predictability-{a.season}.csv", index=False, float_format="%.4f")
    (out / "summary.md").write_text(summary(df, rep, a.season, params))
    print(f"Wrote {out / f'predictability-{a.season}.csv'} and {out / 'summary.md'}")


if __name__ == "__main__":
    main()
