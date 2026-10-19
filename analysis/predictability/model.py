"""How predictable each offense's run/pass calls are.

1. A league-wide model gives the chance of a pass in each situation. Each
   team's plays are scored by a version of it trained without that team.
2. A small per-team model adjusts the league chance for the team's own
   tendencies (overall and in a few situations), shrunk toward zero so a
   handful of plays can't define a team.
3. Scoring is out of sample and in order, like a defense studying film: each
   game is predicted from the team's earlier games only.
"""
import numpy as np
import pandas as pd
from scipy.special import expit, logit
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.model_selection import GroupKFold

BASE_FEATURES = ["down", "distance", "yards_to_goal", "margin", "period", "secs_half", "secs_game", "overtime",
                 "two_minute", "off_timeouts", "def_timeouts", "is_home", "prev_type", "prev_yards",
                 "prev_incomplete", "drive_play"]

# Situations the per-team model can adjust for, and that the report describes,
# named to finish the sentence "passes N pts more than expected ...".
SITUATIONS = {
    "on early downs": lambda d: ~_passing_down(d) & d["down"].le(2),
    "on passing downs": lambda d: _passing_down(d),
    "in short yardage": lambda d: d["down"].ge(3) & d["distance"].le(2),
    "in the red zone": lambda d: d["yards_to_goal"].le(20),
    "when trailing by 9 or more": lambda d: d["margin"].le(-9),
    "when leading by 9 or more": lambda d: d["margin"].ge(9),
    "on the play after a run": lambda d: d["prev_type"].eq(1),
    "on the play after a pass": lambda d: d["prev_type"].eq(2),
    "on the first play of a drive": lambda d: d["prev_type"].eq(0),
    "in the last two minutes of a half": lambda d: d["two_minute"].eq(1),
}
TEAM_TERMS = ["on passing downs", "in short yardage", "in the red zone", "when trailing by 9 or more", "when leading by 9 or more",
              "on the play after a pass", "on the first play of a drive", "in the last two minutes of a half"]

MIN_PRIOR = 150      # plays a team must have before its games are scored
NULL_PRIOR = 20      # plays of league pass rate mixed into a team's own rate
CLIP = 1e-4


def _passing_down(d):
    return (d["down"].eq(2) & d["distance"].ge(8)) | (d["down"].ge(3) & d["distance"].ge(5))


def baseline_offsets(df, folds=5, seed=0):
    """Out-of-team league logits: each team's plays are predicted by a model
    trained on the other teams."""
    out = np.zeros(len(df))
    groups = df["offense"].to_numpy()
    k = min(folds, len(np.unique(groups)))
    X, y = df[BASE_FEATURES].to_numpy(float), df["pass"].to_numpy()
    for tr, te in GroupKFold(n_splits=k).split(X, y, groups):
        m = HistGradientBoostingClassifier(max_iter=400, learning_rate=0.05, max_leaf_nodes=31,
                                           min_samples_leaf=40, l2_regularization=1.0, random_state=seed)
        m.fit(X[tr], y[tr])
        out[te] = logit(np.clip(m.predict_proba(X[te])[:, 1], CLIP, 1 - CLIP))
    return out


def design(df, terms=TEAM_TERMS):
    cols = [np.ones(len(df))] + [SITUATIONS[t](df).to_numpy(float) for t in terms]
    return np.column_stack(cols)


def fit_offset_logit(Z, y, off, lam, iters=30):
    """Ridge logistic regression with a fixed offset, by Newton's method."""
    b = np.zeros(Z.shape[1])
    for _ in range(iters):
        p = expit(off + Z @ b)
        grad = Z.T @ (p - y) + lam * b
        H = (Z.T * (p * (1 - p))) @ Z + np.diag(lam)
        step = np.linalg.solve(H, grad)
        b -= step
        if np.max(np.abs(step)) < 1e-7:
            break
    return b


def _bits(p, y):
    p = np.clip(p, CLIP, 1 - CLIP)
    return -(y * np.log2(p) + (1 - y) * np.log2(1 - p))


def rolling(df, off, lam0, lam1, entity="entity"):
    """Predicts each team's games from its earlier games. Returns per-play
    out-of-sample chances for the full model, a league-plus-team-rate model,
    and the team's pass rate alone (NaN where not scored)."""
    n = len(df)
    full, sit, null = (np.full(n, np.nan) for _ in range(3))
    Z_all, y_all = design(df), df["pass"].to_numpy(float)
    lam_full = np.r_[lam0, np.full(Z_all.shape[1] - 1, lam1)]
    league_rate = y_all.mean()
    for _, idx in df.groupby(entity, sort=False).indices.items():
        sub = df.iloc[idx]
        order = sub.sort_values(["week", "game_id"]).groupby(["week", "game_id"], sort=False).indices
        seen = []
        for _, gpos in order.items():
            rows = idx[gpos]
            if len(seen) >= MIN_PRIOR:
                tr = np.array(seen)
                Z, y, o = Z_all[tr], y_all[tr], off[tr]
                b = fit_offset_logit(Z, y, o, lam_full)
                full[rows] = expit(off[rows] + Z_all[rows] @ b)
                b0 = fit_offset_logit(Z[:, :1], y, o, np.array([lam0]))
                sit[rows] = expit(off[rows] + b0[0])
                null[rows] = (y.sum() + NULL_PRIOR * league_rate) / (len(y) + NULL_PRIOR)
            seen.extend(rows.tolist())
    return full, sit, null


def tune(df, off, grid0=(0.5, 2.0, 8.0), grid1=(4.0, 16.0, 64.0)):
    """The shrinkage that predicts best, pooled over all teams."""
    best = None
    y = df["pass"].to_numpy(float)
    for l0 in grid0:
        for l1 in grid1:
            full, _, _ = rolling(df, off, l0, l1)
            m = ~np.isnan(full)
            score = _bits(full[m], y[m]).mean()
            if best is None or score < best[0]:
                best = (score, l0, l1)
    return best[1], best[2]


def tendency(sub, off):
    """The team's most distinctive habit: the situation where its pass rate
    differs most from what the league would do in the same spots (shrunk for
    small samples)."""
    best = None
    league = expit(off)
    for name, f in SITUATIONS.items():
        m = f(sub).to_numpy()
        n = int(m.sum())
        if n < 40:
            continue
        d = (sub["pass"].to_numpy()[m] - league[m]).mean() * n / (n + 60)
        if best is None or abs(d) > abs(best[1]):
            best = (name, d, n)
    if not best:
        return ""
    name, d, n = best
    return f"{'passes' if d > 0 else 'runs'} {abs(d) * 100:.0f} pts more than expected {name}"


def report(df, off, full, sit, null, entity="entity", min_scored=MIN_PRIOR):
    """One row per team (or play-calling stint), most predictable first."""
    y = df["pass"].to_numpy(float)
    epa = df["epa"].to_numpy(float)
    rows = []
    for ent, idx in df.groupby(entity, sort=False).indices.items():
        sc = idx[~np.isnan(full[idx])]
        sub = df.iloc[idx]
        r = {"team": ent, "offense": sub["offense"].iloc[0], "games": sub["game_id"].nunique(), "calls": len(idx),
             "pass_rate": y[idx].mean(), "pass_over_expected": (y[idx] - expit(off[idx])).mean(),
             "epa_per_call": np.nanmean(epa[idx]), "calls_scored": len(sc),
             "games_scored": sub.loc[~np.isnan(full[idx]), "game_id"].nunique(),
             "tendency": tendency(sub, off[idx])}
        if len(sc):
            b = _bits(full[sc], y[sc])
            r.update({
                "bits_per_call": b.mean(), "bits_se": b.std(ddof=1) / np.sqrt(len(b)) if len(b) > 1 else np.nan,
                "bits_situation_only": _bits(sit[sc], y[sc]).mean(), "bits_pass_rate_only": _bits(null[sc], y[sc]).mean(),
                "called_right": ((full[sc] >= 0.5) == (y[sc] == 1)).mean(),
                "called_right_pass_rate_only": ((null[sc] >= 0.5) == (y[sc] == 1)).mean(),
            })
            conf = np.maximum(full[sc], 1 - full[sc]) >= 0.7
            followed = conf & ((full[sc] >= 0.5) == (y[sc] == 1))
            broke = conf & ~followed
            r.update({"obvious_calls": int(conf.sum()), "obvious_share": conf.mean(),
                      "epa_followed_obvious": np.nanmean(epa[sc][followed]) if followed.any() else np.nan,
                      "epa_broke_obvious": np.nanmean(epa[sc][broke]) if broke.any() else np.nan,
                      "broke_obvious": int(broke.sum())})
        rows.append(r)
    out = pd.DataFrame(rows)
    out["predictability"] = 100 * (1 - out.get("bits_per_call", np.nan))
    out["ranked"] = out["calls_scored"] >= min_scored
    out = out.sort_values(["ranked", "predictability"], ascending=[False, False]).reset_index(drop=True)
    out["rank"] = np.where(out["ranked"], np.arange(1, len(out) + 1), np.nan)
    return out
